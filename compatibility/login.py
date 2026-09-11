"""Fresh Hermes-owned device login. Never import another application's refresh token."""

if __package__:
    from .probe import ROOT, configure_probe_home, verify_pin
else:
    from probe import ROOT, configure_probe_home, verify_pin


def save_login_result(result):
    """The native device flow returns an envelope; the store expects its tokens."""
    from hermes_cli.auth_codex import _save_codex_tokens
    from integrations.hermes.subscription import SubscriptionCredentials

    if not isinstance(result, dict) or result.get("auth_mode") != "chatgpt":
        raise ValueError("Expected a native ChatGPT device-login result")
    tokens = result.get("tokens")
    if not isinstance(tokens, dict) or not isinstance(tokens.get("refresh_token"), str) or not tokens["refresh_token"].strip():
        raise ValueError("Device login returned no refresh token")
    SubscriptionCredentials(tokens.get("access_token"), result.get("base_url"))
    _save_codex_tokens(tokens, last_refresh=result.get("last_refresh"))


def main():
    verify_pin()
    home = ROOT / "data/compat/hermes-auth"
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (home / "auth.json").exists():
        raise SystemExit("Hermes compatibility login already exists; use the probe to verify refresh.")
    configure_probe_home(home)
    from hermes_cli.auth_codex import _codex_device_code_login
    save_login_result(_codex_device_code_login())
    print("Hermes-owned subscription login saved in the ignored compatibility profile.")


if __name__ == "__main__":
    main()
