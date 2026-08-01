#!/usr/bin/env bash
#
# Nocheh bootstrap. Takes a freshly cloned repo on a VPS to a running,
# HTTPS-reachable deployment with a connected Telegram bot.
#
#   bash scripts/bootstrap.sh
#
# What it does:
#   1. Installs Docker Engine + compose plugin (Ubuntu/Debian), swap, firewall
#   2. Creates .env, generating every secret that is missing
#   3. Asks only for what cannot be generated: username, AI key, tunnel token,
#      public hostname, bot token
#   4. Starts the stack (app + Cloudflare Tunnel) and waits for /health
#   5. Validates the bot token and registers the Telegram webhook
#
# Safe to re-run. Existing secrets are never regenerated and answers you
# already gave become the defaults.
#
# Flags:
#   -y, --non-interactive   Never prompt; read answers from the environment
#       --env-only          Only create/update .env (no Docker, no system changes)
#       --bot-only          Only validate the bot token and set the webhook
#       --skip-system       Skip Docker install, swap and firewall
#       --with-firewall     Enable ufw, allowing the detected SSH ports
#       --no-firewall       Never touch ufw
#       --no-start          Configure everything but do not start containers
#       --no-bot            Skip the Telegram step
#   -h, --help              Show this help
#
# Non-interactive input (environment variables):
#   APP_AUTH_USERNAME, AI_PROVIDER, NVIDIA_API_KEY, ANTHROPIC_API_KEY,
#   ANTHROPIC_MODEL, CLOUDFLARE_TUNNEL_TOKEN, PUBLIC_HOSTNAME,
#   TELEGRAM_BOT_TOKEN, MESSAGE_ANALYSIS_MODE

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

NON_INTERACTIVE=0
ENV_ONLY=0
BOT_ONLY=0
SKIP_SYSTEM=0
FIREWALL=ask
DO_START=1
DO_BOT=1

GENERATED_PASSWORD=""
DOCKER=(docker)
APT=0
TTY_OK=0
PROMPT_IN=0
PROMPT_OUT=2

# ---------------------------------------------------------------- output ----

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s+%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
skip()  { printf '    %s-%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() { sed -n '3,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ------------------------------------------------------------------ args ----

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--non-interactive) NON_INTERACTIVE=1 ;;
    --env-only)           ENV_ONLY=1 ;;
    --bot-only)           BOT_ONLY=1 ;;
    --skip-system)        SKIP_SYSTEM=1 ;;
    --with-firewall)      FIREWALL=yes ;;
    --no-firewall)        FIREWALL=no ;;
    --no-start)           DO_START=0 ;;
    --no-bot)             DO_BOT=0 ;;
    -h|--help)            usage; exit 0 ;;
    *)                    die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

[[ $NON_INTERACTIVE == 1 && $FIREWALL == ask ]] && FIREWALL=no

# --------------------------------------------------------------- prompts ----

# Prompts read from the terminal, never from stdin's data, so `curl | bash` and
# heredocs still work. /dev/tty may exist but be unopenable when the process has
# no controlling terminal (`ssh host 'bash bootstrap.sh'`), so it is opened for
# real rather than tested with -r.
detect_tty() {
  TTY_OK=0
  if [[ $NON_INTERACTIVE == 1 ]]; then
    return 0
  fi
  if [[ -t 0 && -t 2 ]]; then
    TTY_OK=1; PROMPT_IN=0; PROMPT_OUT=2
    return 0
  fi
  # Probe in a subshell: a failed `exec` redirection would exit this script.
  if ( exec 3<> /dev/tty ) 2>/dev/null; then
    exec 3<> /dev/tty
    TTY_OK=1; PROMPT_IN=3; PROMPT_OUT=3
  fi
}

has_tty() { [[ $TTY_OK == 1 ]]; }

# ask <prompt> [default] -> prints the answer
ask() {
  local prompt="$1" default="${2-}" reply=""
  if ! has_tty; then printf '%s' "$default"; return 0; fi
  if [[ -n $default ]]; then
    printf '    %s [%s]: ' "$prompt" "$default" >&"$PROMPT_OUT"
  else
    printf '    %s: ' "$prompt" >&"$PROMPT_OUT"
  fi
  IFS= read -r reply <&"$PROMPT_IN" || reply=""
  printf '%s' "${reply:-$default}"
}

# ask_secret <prompt> [current] -> prints the answer, echoes nothing
ask_secret() {
  local prompt="$1" current="${2-}" reply=""
  if ! has_tty; then printf '%s' "$current"; return 0; fi
  if [[ -n $current ]]; then
    printf '    %s %s[enter to keep existing]%s: ' "$prompt" "$C_DIM" "$C_RESET" >&"$PROMPT_OUT"
  else
    printf '    %s: ' "$prompt" >&"$PROMPT_OUT"
  fi
  IFS= read -rs reply <&"$PROMPT_IN" || reply=""
  printf '\n' >&"$PROMPT_OUT"
  printf '%s' "${reply:-$current}"
}

# confirm <prompt> <default y|n>
confirm() {
  local prompt="$1" default="$2" reply
  if ! has_tty; then [[ $default == y ]]; return; fi
  reply="$(ask "$prompt (y/n)" "$default")"
  [[ ${reply:0:1} == y || ${reply:0:1} == Y ]]
}

# ------------------------------------------------------------- env store ----

# Values copied from .env.example that mean "not configured yet".
is_placeholder() {
  case "$1" in
    ""|replace-with*|local-development-secret-change-me) return 0 ;;
    *) return 1 ;;
  esac
}

env_get() {
  [[ -f $ENV_FILE ]] || return 0
  awk -v key="$1" '
    index($0, "#") == 1 { next }
    index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$ENV_FILE"
}

# resolved_default <KEY> [fallback] -> the value to offer as the prompt default.
# Interactive: the stored value wins, so re-runs suggest what you chose before.
# Non-interactive: an exported variable wins, so a scripted run is reproducible
# and `KEY= ... -y` explicitly clears a stored value.
resolved_default() {
  local key="$1" fallback="${2-}" stored
  stored="$(env_get "$key")"
  is_placeholder "$stored" && stored=""

  if [[ $NON_INTERACTIVE == 1 && -n ${!key+set} ]]; then
    printf '%s' "${!key}"
  elif [[ -n $stored ]]; then
    printf '%s' "$stored"
  elif [[ -n ${!key+set} ]]; then
    printf '%s' "${!key}"
  else
    printf '%s' "$fallback"
  fi
}

# Updates in place (truncate, same inode) because .env is bind-mounted into the
# container. Replacing the file would detach the container from further writes.
env_set() {
  local key="$1" tmp
  export __ENV_SET_VALUE="$2"
  tmp="$(mktemp)"
  awk -v key="$key" '
    BEGIN { val = ENVIRON["__ENV_SET_VALUE"]; done = 0 }
    !done && index($0, "#") != 1 && index($0, key "=") == 1 { print key "=" val; done = 1; next }
    { print }
    END { if (!done) print key "=" val }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  unset __ENV_SET_VALUE
}

gen_hex() {
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -hex 32
  else
    ( set +o pipefail; LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64; echo )
  fi
}

# Alphanumeric only: safe in .env, in compose interpolation and in a URL.
gen_password() {
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-24
  else
    ( set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24; echo )
  fi
}

# ------------------------------------------------------------- preflight ----

preflight() {
  step "Preflight"

  detect_tty

  for tool in awk sed grep curl mktemp; do
    command -v "$tool" > /dev/null 2>&1 || die "missing required tool: $tool"
  done

  [[ -f $ENV_EXAMPLE ]] || die "run this from a Nocheh clone: $ENV_EXAMPLE not found"

  if [[ "$(uname -s)" == Linux && -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}${ID_LIKE:-}" in
      *debian*|*ubuntu*) APT=1 ;;
    esac
    ok "host: ${PRETTY_NAME:-Linux}"
  else
    ok "host: $(uname -s)"
  fi

  if [[ $APT == 0 && $SKIP_SYSTEM == 0 && $ENV_ONLY == 0 && $BOT_ONLY == 0 ]]; then
    warn "not an apt-based Linux; skipping Docker install, swap and firewall"
    SKIP_SYSTEM=1
  fi

  if [[ $NON_INTERACTIVE == 0 ]] && ! has_tty; then
    die "no terminal is attached, so the script cannot ask anything.
       Re-run interactively, or with --non-interactive and these variables set:
       APP_AUTH_USERNAME, PUBLIC_HOSTNAME, CLOUDFLARE_TUNNEL_TOKEN,
       AI_PROVIDER, NVIDIA_API_KEY, TELEGRAM_BOT_TOKEN"
  fi
}

sudo_cmd() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  elif command -v sudo > /dev/null 2>&1; then
    sudo "$@"
  else
    die "need root for '$*' but sudo is not installed"
  fi
}

# ---------------------------------------------------------------- system ----

install_docker() {
  if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
    skip "Docker and the compose plugin are already installed"
    return
  fi

  info "installing Docker Engine and the compose plugin"
  export DEBIAN_FRONTEND=noninteractive
  sudo_cmd apt-get update -qq
  sudo_cmd apt-get install -y -qq ca-certificates curl gnupg

  sudo_cmd install -m 0755 -d /etc/apt/keyrings
  local distro codename
  # shellcheck source=/dev/null
  distro="$(. /etc/os-release && echo "${ID}")"
  # shellcheck source=/dev/null
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"
  [[ -n $codename ]] || die "cannot determine the distro codename for the Docker repo"

  curl -fsSL "https://download.docker.com/linux/${distro}/gpg" \
    | sudo_cmd gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  sudo_cmd chmod a+r /etc/apt/keyrings/docker.gpg

  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$distro" "$codename" \
    | sudo_cmd tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo_cmd apt-get update -qq
  sudo_cmd apt-get install -y -qq \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  if [[ $EUID -ne 0 ]]; then
    sudo_cmd usermod -aG docker "$USER"
    warn "added $USER to the docker group; log out and back in for it to apply to your shell"
  fi
  ok "Docker installed: $(docker --version)"
}

setup_swap() {
  local mem_mb swap_kb
  mem_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  swap_kb=$(awk 'NR > 1 { total += $3 } END { print total + 0 }' /proc/swaps)

  if [[ $mem_mb -ge 1900 ]]; then
    skip "${mem_mb}MB RAM is enough for the image build"
    return
  fi
  if [[ $swap_kb -gt 0 ]]; then
    skip "${mem_mb}MB RAM with $((swap_kb / 1024))MB swap already active"
    return
  fi
  if [[ -e /swapfile ]]; then
    skip "/swapfile already exists"
    return
  fi

  info "${mem_mb}MB RAM detected; creating a 2GB swapfile so the build does not get OOM-killed"
  sudo_cmd fallocate -l 2G /swapfile || sudo_cmd dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo_cmd chmod 600 /swapfile
  sudo_cmd mkswap /swapfile > /dev/null
  sudo_cmd swapon /swapfile
  grep -q '^/swapfile' /etc/fstab 2>/dev/null \
    || printf '/swapfile none swap sw 0 0\n' | sudo_cmd tee -a /etc/fstab > /dev/null
  ok "2GB swap active"
}

setup_firewall() {
  command -v ufw > /dev/null 2>&1 || { skip "ufw is not installed"; return; }

  local ports port_list
  ports="$(awk '/^[[:space:]]*[Pp]ort[[:space:]]+[0-9]+/ { print $2 }' /etc/ssh/sshd_config 2>/dev/null || true)"
  [[ -n $ports ]] || ports="22"
  port_list="$(printf '%s' "$ports" | tr '\n' ' ')"

  if [[ $FIREWALL == ask ]]; then
    warn "enabling ufw will allow only SSH ports: $port_list"
    confirm "enable ufw with those SSH ports allowed?" y || { skip "firewall unchanged"; return; }
  fi

  local port
  for port in $ports; do
    sudo_cmd ufw allow "${port}/tcp" > /dev/null
  done
  sudo_cmd ufw --force enable > /dev/null
  ok "ufw enabled; inbound limited to SSH ($port_list). The tunnel needs no open ports."
}

# ------------------------------------------------------------------- .env ----

configure_env() {
  step "Configuration (.env)"

  if [[ ! -f $ENV_FILE ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    ok "created .env from .env.example"
  else
    skip ".env already exists; keeping every value that is already set"
  fi
  chmod 600 "$ENV_FILE"

  # --- generated secrets -----------------------------------------------
  local encryption session
  encryption="$(env_get LOCAL_ENCRYPTION_SECRET)"
  if is_placeholder "$encryption"; then
    env_set LOCAL_ENCRYPTION_SECRET "$(gen_hex)"
    ok "generated LOCAL_ENCRYPTION_SECRET"
  else
    skip "LOCAL_ENCRYPTION_SECRET already set (never rotate it: it decrypts stored memory)"
  fi

  session="$(env_get APP_AUTH_SESSION_SECRET)"
  if is_placeholder "$session"; then
    env_set APP_AUTH_SESSION_SECRET "$(gen_hex)"
    ok "generated APP_AUTH_SESSION_SECRET"
  fi

  # --- dashboard login -------------------------------------------------
  local username password
  username="$(ask "Dashboard username" "$(resolved_default APP_AUTH_USERNAME owner)")"
  [[ -n $username ]] || die "a dashboard username is required"
  env_set APP_AUTH_USERNAME "$username"

  password="$(env_get APP_AUTH_PASSWORD)"
  if is_placeholder "$password"; then
    GENERATED_PASSWORD="$(gen_password)"
    env_set APP_AUTH_PASSWORD "$GENERATED_PASSWORD"
    ok "generated a dashboard password (shown at the end)"
  else
    skip "dashboard password already set"
  fi

  # --- public hostname -------------------------------------------------
  local hostname
  if has_tty; then
    info "Public hostname routed by your Cloudflare Tunnel, e.g. nocheh.example.com"
    info "Create it at one.dash.cloudflare.com -> Networks -> Tunnels -> Public Hostname"
    info "pointing at the HTTP service ${C_BOLD}nocheh:3000${C_RESET}"
  fi
  hostname="$(ask "Public hostname (blank = local only)" "$(resolved_default PUBLIC_HOSTNAME)")"
  hostname="${hostname#http://}"
  hostname="${hostname#https://}"
  hostname="${hostname%%/*}"
  if [[ -n $hostname && $hostname != *.* ]]; then
    die "'$hostname' does not look like a hostname"
  fi
  env_set PUBLIC_HOSTNAME "$hostname"

  # Secure cookies require HTTPS, which only exists once the tunnel serves it.
  if [[ -n $hostname ]]; then
    env_set APP_AUTH_SECURE_COOKIE true
  else
    env_set APP_AUTH_SECURE_COOKIE false
  fi

  # --- tunnel token ----------------------------------------------------
  local tunnel
  tunnel="$(resolved_default CLOUDFLARE_TUNNEL_TOKEN)"
  if [[ -n $hostname ]]; then
    tunnel="$(ask_secret "Cloudflare Tunnel token" "$tunnel")"
  fi
  env_set CLOUDFLARE_TUNNEL_TOKEN "$tunnel"

  # --- AI provider -----------------------------------------------------
  local provider
  provider="$(ask "AI provider (nvidia | anthropic | none)" "$(resolved_default AI_PROVIDER nvidia)")"

  case "$provider" in
    nvidia)
      local key
      has_tty && info "Key from https://build.nvidia.com/z-ai/glm-5.2 (starts with nvapi-)"
      key="$(ask_secret "NVIDIA_API_KEY" "$(resolved_default NVIDIA_API_KEY)")"
      if [[ -z $key ]]; then
        warn "no key given; starting in dry-run (ingestion works, no analysis)"
        env_set AI_PROVIDER ""
      else
        env_set AI_PROVIDER nvidia
        env_set NVIDIA_API_KEY "$key"
        ok "provider: nvidia (default model z-ai/glm-5.2)"
      fi
      ;;
    anthropic)
      local key model
      key="$(ask_secret "ANTHROPIC_API_KEY" "$(resolved_default ANTHROPIC_API_KEY)")"
      model="$(ask "ANTHROPIC_MODEL (required, exact model id)" "$(resolved_default ANTHROPIC_MODEL)")"
      if [[ -z $key || -z $model ]]; then
        warn "key or model missing; starting in dry-run"
        env_set AI_PROVIDER ""
      else
        env_set AI_PROVIDER anthropic
        env_set ANTHROPIC_API_KEY "$key"
        env_set ANTHROPIC_MODEL "$model"
        ok "provider: anthropic ($model)"
      fi
      ;;
    *)
      env_set AI_PROVIDER ""
      warn "dry-run mode: ingestion, redaction and audit work; no analysis is produced"
      ;;
  esac

  # --- analysis mode ---------------------------------------------------
  local mode
  mode="$(ask "Analysis mode (batch = cheaper windows | immediate = per message)" \
    "$(resolved_default MESSAGE_ANALYSIS_MODE batch)")"
  [[ $mode == immediate ]] || mode="batch"
  env_set MESSAGE_ANALYSIS_MODE "$mode"

  ok ".env written ($(grep -c '^[A-Z]' "$ENV_FILE") keys, mode 600)"
}

# ------------------------------------------------------------------ start ----

resolve_docker() {
  command -v docker > /dev/null 2>&1 || die "docker is not installed; re-run without --skip-system"
  if docker info > /dev/null 2>&1; then
    DOCKER=(docker)
  elif command -v sudo > /dev/null 2>&1 && sudo -n docker info > /dev/null 2>&1; then
    DOCKER=(sudo docker)
  elif command -v sudo > /dev/null 2>&1; then
    DOCKER=(sudo docker)
    warn "using sudo for docker (group membership needs a new login session)"
  else
    die "cannot talk to the Docker daemon"
  fi
  "${DOCKER[@]}" compose version > /dev/null 2>&1 || die "the docker compose plugin is missing"
}

start_stack() {
  step "Start"
  resolve_docker

  [[ -d $ROOT_DIR/data ]] || mkdir -p "$ROOT_DIR/data"
  [[ -f $ENV_FILE ]] || die ".env is missing; Docker would create it as a directory"

  local args=(compose)
  if [[ -n "$(env_get CLOUDFLARE_TUNNEL_TOKEN)" ]]; then
    args+=(--profile tunnel)
    info "starting the app and the Cloudflare Tunnel"
  else
    info "starting the app only (no tunnel token configured)"
  fi
  args+=(up -d --build)

  ( cd "$ROOT_DIR" && "${DOCKER[@]}" "${args[@]}" )

  local port attempt
  port="$(env_get HOST_PORT)"
  [[ -n $port ]] || port=3000

  info "waiting for http://127.0.0.1:${port}/health"
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
      ok "the app is healthy on port ${port} (after $((attempt * 3))s)"
      return 0
    fi
    sleep 3
  done

  warn "the app did not become healthy in 180s; inspect: docker compose logs -f nocheh"
  return 0
}

# -------------------------------------------------------------- telegram ----

telegram_api() {
  local token="$1" method="$2"
  shift 2
  curl -fsS --max-time 15 -X POST "https://api.telegram.org/bot${token}/${method}" "$@"
}

connect_bot() {
  step "Telegram bot"

  local hostname webhook token
  hostname="$(env_get PUBLIC_HOSTNAME)"
  if [[ -z $hostname ]]; then
    skip "no public hostname; Telegram needs HTTPS. Re-run with --bot-only once the tunnel is live."
    return
  fi
  webhook="https://${hostname}/telegram/webhook"

  if has_tty; then
    info "In Telegram, open @BotFather:"
    info "  /newbot                        -> name, then a username ending in 'bot'"
    info "  /mybots -> Bot Settings -> Group Privacy -> ${C_BOLD}Turn off${C_RESET}"
    info "Privacy must be off or the bot only sees messages that mention it."
  fi

  token="$(ask_secret "Bot token from BotFather (blank = skip)" "$(resolved_default TELEGRAM_BOT_TOKEN)")"
  if [[ -z $token ]]; then
    skip "no token; connect the bot later in the dashboard or re-run with --bot-only"
    return
  fi

  local me username
  if ! me="$(telegram_api "$token" getMe 2>&1)"; then
    warn "getMe failed, token not saved: $me"
    return
  fi
  username="$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
  ok "token valid: @${username:-unknown}"

  # Must match TelegramHttpClient.setWebhook: reactions are not delivered
  # unless message_reaction is requested explicitly.
  local result
  if ! result="$(telegram_api "$token" setWebhook \
      --data-urlencode "url=${webhook}" \
      --data-urlencode 'allowed_updates=["message","edited_message","message_reaction"]' \
      -d 'drop_pending_updates=true' 2>&1)"; then
    warn "setWebhook failed: $result"
    warn "is https://${hostname}/health reachable? Cloudflare Access must not cover /telegram/webhook."
    return
  fi

  env_set TELEGRAM_BOT_TOKEN "$token"
  env_set TELEGRAM_WEBHOOK_URL "$webhook"
  ok "webhook registered: $webhook"

  local info_json last_error
  if info_json="$(telegram_api "$token" getWebhookInfo 2>/dev/null)"; then
    last_error="$(printf '%s' "$info_json" | sed -n 's/.*"last_error_message":"\([^"]*\)".*/\1/p')"
    [[ -n $last_error ]] && warn "Telegram reports a previous delivery error: $last_error"
  fi
}

# --------------------------------------------------------------- summary ----

print_credentials() {
  info "Username   $(env_get APP_AUTH_USERNAME)"
  if [[ -n $GENERATED_PASSWORD ]]; then
    printf '    Password   %s%s%s  (shown once; also in .env)\n' "$C_BOLD" "$GENERATED_PASSWORD" "$C_RESET"
  else
    info "Password   unchanged (see APP_AUTH_PASSWORD in .env)"
  fi
}

summary() {
  local hostname port
  hostname="$(env_get PUBLIC_HOSTNAME)"
  port="$(env_get HOST_PORT)"; [[ -n $port ]] || port=3000

  step "Done"
  if [[ -n $hostname ]]; then
    info "Dashboard  https://${hostname}/app"
    info "Webhook    https://${hostname}/telegram/webhook"
  else
    info "Dashboard  http://127.0.0.1:${port}/app"
  fi
  print_credentials

  printf '\n    %sStill manual:%s\n' "$C_BOLD" "$C_RESET"
  info "  1. Add the bot to your group, with BotFather group privacy off."
  info "  2. Send a message, then open the Conversations tab: the conversation id"
  info "     is the Telegram chat id. Paste it into the Connect bot allow-list."
  info "  3. Optional: paste a Telegram Desktop JSON export into Import history."

  printf '\n    %sBack up now, off this box:%s .env (LOCAL_ENCRYPTION_SECRET decrypts every\n' "$C_YELLOW" "$C_RESET"
  info "    stored memory; if it changes, the data is unreadable) and data/nocheh.sqlite."

  printf '\n    %sdocker compose logs -f nocheh%s   follow the app\n' "$C_DIM" "$C_RESET"
  printf '    %sbash scripts/bootstrap.sh%s        safe to re-run any time\n' "$C_DIM" "$C_RESET"
}

# ------------------------------------------------------------------ main ----

main() {
  preflight

  if [[ $BOT_ONLY == 1 ]]; then
    [[ -f $ENV_FILE ]] || die ".env not found; run the full bootstrap first"
    connect_bot
    return
  fi

  if [[ $SKIP_SYSTEM == 0 && $ENV_ONLY == 0 ]]; then
    step "System"
    install_docker
    setup_swap
    if [[ $FIREWALL == no ]]; then
      skip "firewall unchanged"
    else
      setup_firewall
    fi
  fi

  configure_env

  if [[ $ENV_ONLY == 1 ]]; then
    step "Done"
    print_credentials
    info ".env is ready. Start with: docker compose --profile tunnel up -d --build"
    return
  fi

  if [[ $DO_START == 1 ]]; then
    start_stack
    if [[ $DO_BOT == 1 ]]; then
      connect_bot
    else
      step "Telegram bot"
      skip "skipped (--no-bot)"
    fi
  else
    step "Start"
    skip "not starting containers (--no-start)"
  fi

  summary
}

main "$@"
