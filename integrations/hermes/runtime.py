"""Small authenticated service around native Hermes and its mounted profile state."""
from __future__ import annotations

import base64
import asyncio
import contextlib
import hmac
import io
import json
import logging
import os
import signal
import tempfile
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .subscription import resolve_credentials, detect_literals, DetectorContractError

MODEL = os.environ.get("NOCHEH_MODEL", "gpt-5.6-sol")
ROOT = Path(__file__).resolve().parents[2]
PROFILE_HOME = Path(os.environ["HERMES_HOME"])
TOKEN = Path(os.environ["SERVICE_TOKEN_FILE"]).read_text().strip()
CALL_LOCK = threading.RLock()
DETECTOR_LOCK = threading.RLock()
CHAT_STATUS = {'stage':'idle'}
ERRORS = deque(maxlen=20)


def configure():
    PROFILE_HOME.mkdir(parents=True, exist_ok=True)
    config = PROFILE_HOME / "config.yaml"
    if not config.exists():
        config.write_text(
            f"model:\n  provider: openai-codex\n  default: {MODEL}\n"
            "stt:\n  enabled: true\n  provider: nocheh-subscription\n"
            "plugins:\n  enabled: [nocheh]\nfallback_models: []\n"
        )
    plugin = PROFILE_HOME / "plugins/nocheh"
    plugin.parent.mkdir(exist_ok=True)
    target = os.path.relpath(ROOT / "integrations/hermes", plugin.parent)
    if plugin.is_symlink() and os.readlink(plugin) != target:
        plugin.unlink()
    if not plugin.exists():
        plugin.symlink_to(target, target_is_directory=True)


def chat(text: str):
    CHAT_STATUS.update(stage='initializing')
    from run_agent import AIAgent
    credentials = resolve_credentials()
    agent = AIAgent(
        provider="openai-codex", api_mode="codex_responses", model=MODEL,
        api_key=credentials.access_token, base_url=credentials.base_url,
        enabled_toolsets=[], max_iterations=2, run_budget_seconds=90,
        skip_context_files=True, skip_memory=True, skip_background_review=True,
        quiet_mode=True, save_trajectories=False, reasoning_config={"effort": "low"},
    )
    try:
        CHAT_STATUS.update(stage='running')
        result = agent.run_conversation(text)
        if result.get("failed") or not result.get("final_response"):
            from agent.error_surface import build_error_surface_from_result
            surface=build_error_surface_from_result(result) or {}
            CHAT_STATUS.update(stage='failed', api_calls=result.get('api_calls'), failure_kind=surface.get('reason','unknown'))
            raise RuntimeError("native_chat_failed")
        CHAT_STATUS.update(stage='passed',api_calls=result.get('api_calls'))
        return {"text": result["final_response"], "model": MODEL, "api_calls": result.get("api_calls")}
    finally:
        agent.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not_found"})
        return self.reply(200, {"ok": True, "service": "hermes", "model": MODEL,
                                "login_present": (PROFILE_HOME / "auth.json").is_file(), "telegram": "not_started"})

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + TOKEN).encode()):
            return self.reply(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 36 * 1024 * 1024:
                return self.reply(413, {"error": "invalid_body_size"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.reply(400, {"error": "expected_object"})
            # Hermes writes some diagnostics to stdout even in quiet mode.
            # Detection can be requested by the main model's guard while its
            # conversation lock is held. A separate lock prevents that deadlock.
            lock = contextlib.nullcontext() if self.path == '/internal/status' else DETECTOR_LOCK if self.path == '/internal/detect' else CALL_LOCK
            with lock, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = self.dispatch(body)
            self.reply(200, result)
        except DetectorContractError as error:
            ERRORS.append({'route':'/internal/detect','kind':str(error)})
            self.reply(503, {'error':'detector_contract_rejected'})
        except (ValueError, KeyError, TypeError):
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/transcribe','/internal/file') else 'unknown','kind':'invalid_request'})
            self.reply(400, {"error": "invalid_request"})
        except Exception as error:
            status = getattr(error, "status_code", 503)
            status = status if isinstance(status, int) and status in (401, 403, 429, 503) else 503
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/refresh','/internal/transcribe','/internal/file') else 'unknown','kind':type(error).__name__,'status':status})
            self.reply(status, {"error": "quota_paused" if status == 429 else "subscription_unavailable",
                                "error_type": type(error).__name__})

    def dispatch(self, body):
        if self.path == '/internal/status':
            from integrations.hermes.request_boundary import FAILURES, COUNTS
            return {'guard_failures':list(FAILURES),'model_boundary':dict(COUNTS),'chat':dict(CHAT_STATUS),'errors':list(ERRORS)}
        if self.path == '/internal/file':
            from telegram import Bot
            token_path = os.environ.get('TELEGRAM_BOT_TOKEN_FILE')
            bot_token = Path(token_path).read_text().strip() if token_path else ''
            if not bot_token:
                raise RuntimeError('telegram_not_configured')
            ref = body['file_id']
            if not isinstance(ref, str) or not ref or len(ref) > 1024:
                raise ValueError('invalid_file_id')
            async def download():
                async with Bot(bot_token) as bot:
                    file = await bot.get_file(ref)
                    if file.file_size and file.file_size > 50*1024*1024:
                        raise ValueError('attachment_size_limit')
                    return await file.download_as_bytearray()
            raw = asyncio.run(download())
            if len(raw) > 50*1024*1024:
                raise ValueError('attachment_size_limit')
            return {'bytes_base64': base64.b64encode(raw).decode()}
        if self.path == "/internal/refresh":
            from hermes_cli.auth_codex import _read_codex_tokens, _save_codex_tokens, refresh_codex_oauth_pure
            tokens = _read_codex_tokens()["tokens"]
            _save_codex_tokens(refresh_codex_oauth_pure(tokens["access_token"], tokens["refresh_token"]))
            return {"refreshed": True}
        if self.path in ("/internal/chat", "/internal/detect"):
            text = body["text"]
            if not isinstance(text, str) or len(text) > 100000:
                raise ValueError("invalid_text")
            return chat(text) if self.path.endswith("chat") else {"literals": detect_literals(text, resolve_credentials(), MODEL)}
        if self.path == "/internal/transcribe":
            from tools.transcription_tools import transcribe_audio
            raw = base64.b64decode(body["audio_base64"], validate=True)
            if not raw or len(raw) > 25 * 1024 * 1024:
                raise ValueError("invalid_audio")
            suffix = body.get("suffix", ".ogg")
            if suffix not in (".ogg", ".oga", ".mp3", ".wav", ".m4a", ".mp4", ".flac"):
                raise ValueError("invalid_audio_suffix")
            with tempfile.NamedTemporaryFile(suffix=suffix) as audio:
                audio.write(raw); audio.flush()
                return transcribe_audio(audio.name)
        raise ValueError("unknown_route")


def main():
    if len(TOKEN) < 24:
        raise SystemExit("Service token is missing or too short")
    logging.disable(logging.CRITICAL)
    configure()
    from integrations.hermes.request_boundary import install
    install()
    from integrations.hermes.compatibility_patch import install as install_native_gate
    install_native_gate()
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8781"))), Handler)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({"event": "ready", "service": "hermes"}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
