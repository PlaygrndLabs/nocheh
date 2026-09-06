"""Hermes STT provider backed by the existing codex-asr binary, not a local model."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from agent.transcription_provider import TranscriptionProvider
from hermes_cli.auth_constants import AuthError, CODEX_RATE_LIMITED_CODE
from .subscription import resolve_credentials


def process_environment(token: str) -> dict[str, str]:
    # Provider keys, unrelated OAuth credentials and caller-configured proxies are
    # not inherited by the speech process. Token is never placed on the command line.
    allowed = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env["CODEX_ASR_BEARER"] = token
    env["CODEX_ASR_REQUEST_TIMEOUT_SECONDS"] = "90"
    return env


def run_asr(path: Path, language: str | None, token: str) -> subprocess.CompletedProcess:
    args = ["codex-asr", str(path), "--json"]
    if language:
        args += ["--language", language]
    return subprocess.run(args, env=process_environment(token), capture_output=True, text=True, timeout=100)


def safe_failure(result: subprocess.CompletedProcess) -> dict:
    # Upstream errors may include response bodies; expose only a classified status.
    match = re.search(r"HTTP\s+(\d{3})", result.stderr or "")
    status = int(match.group(1)) if match else None
    reason = {401: "auth_required", 403: "access_denied", 429: "quota_paused"}.get(status, "transcription_failed")
    return {
        "success": False, "transcript": "", "provider": "nocheh-subscription",
        "error": reason, "status_code": status,
        "retryable": status == 429 or (status is not None and status >= 500),
    }


class SubscriptionTranscriptionProvider(TranscriptionProvider):
    def __init__(self, credential_resolver=resolve_credentials, runner=run_asr):
        self._credentials = credential_resolver
        self._runner = runner

    @property
    def name(self):
        return "nocheh-subscription"

    @property
    def display_name(self):
        return "Nocheh ChatGPT subscription transcription"

    def is_available(self):
        if self._runner is not run_asr:
            return True  # Explicitly injected probe/test runner owns availability.
        if not shutil.which("codex-asr"):
            return False
        try:
            from hermes_cli.auth_codex import _read_codex_tokens
            return bool(_read_codex_tokens().get("tokens", {}).get("access_token"))
        except Exception:
            return False

    def transcribe(self, file_path, *, model=None, language=None, **extra):
        path = Path(file_path)
        try:
            if not path.is_file() or path.stat().st_size == 0:
                return self._error("audio_missing_or_empty", False)
            if path.stat().st_size > 25 * 1024 * 1024:
                return self._error("audio_requires_chunking", False)
            # Resolve for every request: Hermes, not the bridge, owns token refresh.
            credentials = self._credentials()
            result = self._runner(path, language, credentials.access_token)
            if result.returncode:
                return safe_failure(result)
            body = json.loads(result.stdout)
            transcript = body.get("text") if isinstance(body, dict) else None
            if not isinstance(transcript, str) or not transcript.strip():
                return self._error("invalid_transcription_response", False)
            # Do not strip/normalize actual content; whitespace is preserved too.
            return {"success": True, "transcript": transcript, "provider": self.name}
        except subprocess.TimeoutExpired:
            return self._error("transcription_timeout", True)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._error("invalid_transcription_response", False)
        except AuthError as exc:
            if exc.code == CODEX_RATE_LIMITED_CODE:
                return self._error("quota_paused", True)
            return self._error("auth_required" if exc.relogin_required else "auth_unavailable", not exc.relogin_required)
        except Exception:
            return self._error("transcription_dependency_or_auth_error", False)

    def _error(self, reason, retryable):
        return {"success": False, "transcript": "", "provider": self.name,
                "error": reason, "retryable": retryable}
