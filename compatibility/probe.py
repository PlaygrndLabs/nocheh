"""Synthetic Phase 1 probe. No private corpus, provider API keys or implicit spending.

Run through the pinned Hermes virtualenv; see compatibility/README.md.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import io
import json
import logging
import os
import platform
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "compatibility/upstreams.lock.json").read_text())
UPSTREAM = ROOT / "data/compat/upstreams/hermes-agent"
sys.path[:0] = [str(ROOT), str(UPSTREAM)]


def configure_probe_home(home: Path):
    # Keep user configuration, provider keys and plugins out of this probe.
    if (home / ".env").exists():
        raise ValueError("Compatibility profile must not contain a provider .env file")
    allowed = {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT"}
    for key in list(os.environ):
        if key not in allowed:
            del os.environ[key]
    os.environ["HERMES_HOME"] = str(home)
    (home / "config.yaml").write_text(
        "stt:\n  enabled: true\n  provider: nocheh-subscription\n"
        "model:\n  provider: openai-codex\n  default: " + LOCK["model"] + "\n"
        "fallback_models: []\nplugins:\n  enabled: [nocheh]\n"
    )
    plugin = home / "plugins/nocheh"
    plugin.parent.mkdir(exist_ok=True)
    if not plugin.is_symlink() and not plugin.exists():
        plugin.symlink_to(ROOT / "integrations/hermes", target_is_directory=True)


def read_probe_credentials(auth_file: Path):
    """Read only the current external token; never copy or rotate its refresh token."""
    from integrations.hermes.subscription import SubscriptionCredentials
    data = json.loads(auth_file.read_text())
    if data.get("auth_mode") not in {"chatgpt", "chatgpt_auth_tokens"}:
        raise ValueError("Probe needs ChatGPT login")
    token = data["tokens"]["access_token"]
    payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))
    if payload.get("exp", 0) <= time.time() + 120:
        raise ValueError("Probe access token is expiring; refresh through its owning application")
    return SubscriptionCredentials(token)


def read_hermes_probe_credentials():
    # The explicit live refresh check below uses Hermes's own refresh/save APIs.
    # Avoid the generic resolver's legacy fallback to another application's store.
    from hermes_cli.auth_codex import _read_codex_tokens
    from integrations.hermes.subscription import SubscriptionCredentials
    return SubscriptionCredentials(_read_codex_tokens()["tokens"]["access_token"])


def docker_asr(path, language, token):
    from integrations.hermes.transcription import process_environment
    container_name = "nocheh-compat-" + uuid.uuid4().hex
    command = [
        "docker", "run", "--rm", "--name", container_name, "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:size=64m",
        "--mount", f"type=bind,source={path.parent.resolve()},target=/audio,readonly",
        "--env", "CODEX_ASR_BEARER", "--env", "CODEX_ASR_REQUEST_TIMEOUT_SECONDS",
        LOCK["codex_asr"]["image"], f"/audio/{path.name}", "--json",
    ]
    if language:
        command += ["--language", language]
    try:
        return subprocess.run(command, env=process_environment(token), capture_output=True, text=True, timeout=110)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        # Killing the docker CLI alone does not stop the remote container.
        cleanup_env = process_environment("")
        cleanup_env.pop("CODEX_ASR_BEARER")
        subprocess.run(["docker", "rm", "-f", container_name], env=cleanup_env,
                       capture_output=True, timeout=15)
        raise


def verify_pin():
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip()
    if actual != LOCK["hermes"]["revision"]:
        raise ValueError("Hermes revision does not match compatibility lock")
    subprocess.run(["git", "diff", "--quiet", "HEAD"], cwd=UPSTREAM, check=True)


def validate_audio(path: Path):
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_name,duration",
        "-of", "json", str(path)], text=True))
    streams = metadata.get("streams", [])
    if not streams or streams[0].get("codec_name") != "opus" or float(streams[0].get("duration", 0)) <= 0:
        raise ValueError("Probe requires nonempty Ogg/Opus audio")
    return {"codec": "opus", "duration_seconds": float(streams[0]["duration"])}


def report_exit_code(report):
    checks = report["checks"]
    required = ("chat", "detector", "transcription", "native_credential_refresh_live", "target_verification")
    failed = any(check["status"] == "failed" for check in checks.values())
    report["phase1_live_ready"] = not failed and all(checks.get(name, {}).get("status") == "passed" for name in required)
    if failed:
        return 1
    return 0 if report["phase1_live_ready"] else 2


def run_case(report, name, fn):
    started = time.monotonic()
    try:
        # Native diagnostic output can include request bodies. Reports contain
        # only our bounded, classified metadata, even when Hermes prints an error.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            detail = fn()
        result = {"status": "passed", "detail": detail}
    except Exception as exc:
        result = {"status": "failed", "error_type": type(exc).__name__}
        status = getattr(exc, "status_code", None)
        if isinstance(status, int):
            result["http_status"] = status
        if isinstance(exc, TranscriptionProbeError):
            result["error_code"] = exc.reason
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    report["checks"][name] = result
    print(json.dumps({"check": name, **result}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Use subscription quota with synthetic inputs")
    parser.add_argument("--auth-file", type=Path, default=Path.home() / ".codex/auth.json")
    parser.add_argument("--auth-source", choices=("codex", "hermes"), default="codex")
    parser.add_argument("--environment", choices=("local", "vps"), default="local")
    parser.add_argument("--audio", type=Path, default=ROOT / "compatibility/fixtures/subscription-speech.ogg")
    parser.add_argument("--only", choices=("all", "chat", "detector", "transcription"), default="all")
    parser.add_argument("--output", type=Path, default=ROOT / "data/compat/local-report.json")
    args = parser.parse_args()
    if not args.live:
        parser.error("Pass --live explicitly to use subscription quota")
    if args.environment == "vps" and platform.system() != "Linux":
        parser.error("VPS verification must run on the target Linux host")
    verify_pin()
    if (UPSTREAM / ".env").exists():
        parser.error("Probe requires a clean upstream checkout with no .env")
    if args.auth_source == "hermes":
        home = ROOT / "data/compat/hermes-auth"
        if not (home / "auth.json").is_file():
            parser.error("Run compatibility/login.py to create a Hermes-owned login first")
        configure_probe_home(home)
        return run_probes(args)
    with tempfile.TemporaryDirectory(prefix="probe-home-", dir=ROOT / "data/compat") as home:
        configure_probe_home(Path(home))
        return run_probes(args)


def run_probes(args):
    logging.disable(logging.CRITICAL)
    from integrations.hermes.subscription import detect_literals
    credential_resolver = read_hermes_probe_credentials if args.auth_source == "hermes" else lambda: read_probe_credentials(args.auth_file)
    credentials = credential_resolver()
    fixture = json.loads((ROOT / "compatibility/fixtures/subscription-speech.json").read_text())
    report = {
        "schema_version": 1, "recorded_at": datetime.now(timezone.utc).isoformat(),
        "environment": args.environment, "os": platform.system(), "machine": platform.machine(),
        "auth_source": args.auth_source,
        "upstreams": LOCK, "model": LOCK["model"],
        "synthetic_inputs_only": args.audio.is_file() and hashlib.sha256(args.audio.read_bytes()).hexdigest() == fixture["sha256"],
        "checks": {}, "phase1_live_ready": False,
    }

    def chat():
        from run_agent import AIAgent
        agent = AIAgent(
            provider="openai-codex", api_mode="codex_responses", model=LOCK["model"],
            api_key=credentials.access_token, base_url=credentials.base_url,
            enabled_toolsets=[], max_iterations=2, run_budget_seconds=90,
            skip_context_files=True, skip_memory=True, skip_background_review=True,
            quiet_mode=True, save_trajectories=False, reasoning_config={"effort": "low"},
        )
        try:
            if agent.tools:
                raise AssertionError("Compatibility chat must not expose tools")
            result = agent.run_conversation("Reply exactly NOCHEH_COMPAT_OK with no other text.")
            if result.get("failed") or result.get("final_response", "").strip() != "NOCHEH_COMPAT_OK":
                raise AssertionError("Native Hermes response failed the sentinel check")
            return {"sentinel_matched": True, "api_calls": result.get("api_calls")}
        finally:
            agent.close()

    def detector():
        text = "Hey Mak, the test password is juniper-ONLY-7642. سلام، Friday is the deadline."
        literals = detect_literals(text, credentials, LOCK["model"])
        if set(literals) != {"juniper-ONLY-7642"}:
            raise AssertionError("Detector did not identify exactly the planted literal")
        clean = detect_literals("Hey Mak, Friday is the Juniper deadline. سلام", credentials, LOCK["model"])
        if clean:
            raise AssertionError("Detector changed ordinary prose")
        return {"planted_literal_matched": True, "clean_text_matches": 0}

    def transcription():
        audio_metadata = validate_audio(args.audio)
        from agent.transcription_registry import get_provider
        from hermes_cli.plugins import _ensure_plugins_discovered
        from tools.transcription_tools import transcribe_audio
        _ensure_plugins_discovered()
        provider = get_provider("nocheh-subscription")
        if provider is None:
            raise AssertionError("Native Hermes plugin discovery did not register Nocheh STT")
        # Only the credential source and binary runner differ in this probe.
        # Discovery, provider implementation and native dispatch are unchanged.
        provider._credentials = credential_resolver
        provider._runner = docker_asr
        result = transcribe_audio(str(args.audio))
        if not result.get("success"):
            # Safe classified details only; never upstream bodies or authorization headers.
            raise TranscriptionProbeError(result.get("error", "unknown"), result.get("status_code"))
        normalized = result["transcript"].lower()
        if "juniper" not in normalized or "friday" not in normalized:
            raise AssertionError("Transcript failed the spoken-content check")
        return {"content_matched": True, "characters": len(result["transcript"]), **audio_metadata,
                "audio_sha256": hashlib.sha256(args.audio.read_bytes()).hexdigest()}

    def refresh():
        nonlocal credentials
        from hermes_cli.auth_codex import _read_codex_tokens, _save_codex_tokens, refresh_codex_oauth_pure
        from integrations.hermes.subscription import SubscriptionCredentials
        owned = _read_codex_tokens()["tokens"]
        refreshed = refresh_codex_oauth_pure(owned["access_token"], owned["refresh_token"])
        _save_codex_tokens(refreshed)
        credentials = SubscriptionCredentials(refreshed["access_token"])
        # Following chat/detector/STT checks verify the refreshed token works.
        return {"native_refresh_completed": True}

    if args.auth_source == "hermes":
        run_case(report, "native_credential_refresh_live", refresh)
    else:
        report["checks"]["native_credential_refresh_live"] = {"status": "pending", "reason": "Needs Hermes-owned OAuth login; external refresh tokens are not copied"}
    for name, fn in (("chat", chat), ("detector", detector), ("transcription", transcription)):
        if args.only in ("all", name):
            run_case(report, name, fn)
    passed = args.only == "all" and all(report["checks"].get(name, {}).get("status") == "passed" for name in
                 ("chat", "detector", "transcription", "native_credential_refresh_live"))
    report["checks"]["target_verification"] = {"status": "passed" if passed else "pending", "environment": args.environment}
    report["checks"]["vps_verification"] = (report["checks"]["target_verification"] if args.environment == "vps"
        else {"status": "deferred", "reason": "Owner selected local Compose; ADR-0019"})
    exit_code = report_exit_code(report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    return exit_code


class TranscriptionProbeError(Exception):
    def __init__(self, reason, status_code):
        # Hermes can return free-form failures. Keep reports to our known codes.
        known = {"auth_required", "auth_unavailable", "access_denied", "quota_paused", "transcription_failed",
                 "audio_missing_or_empty", "audio_requires_chunking", "invalid_transcription_response",
                 "transcription_timeout", "transcription_dependency_or_auth_error"}
        self.reason = reason if reason in known else "native_transcription_dispatch_failed"
        super().__init__(self.reason)
        self.status_code = status_code


if __name__ == "__main__":
    raise SystemExit(main())
