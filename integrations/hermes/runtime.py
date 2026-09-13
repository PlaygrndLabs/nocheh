"""Small authenticated service around native Hermes and its mounted profile state."""
from __future__ import annotations

from integrations.hermes.environment import secret as environment_secret

import base64
import asyncio
import contextlib
import hmac
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .subscription import resolve_credentials, refresh_credentials, detect_literals, DetectorContractError, reasoning_route

MODEL = os.environ.get("NOCHEH_MODEL", "gpt-5.6-sol")
ROOT = Path(__file__).resolve().parents[2]
PROFILE_HOME = Path(os.environ["HERMES_HOME"])
TOKEN = environment_secret('SERVICE_TOKEN')
CALL_LOCK = threading.RLock()
DETECTOR_LOCK = threading.RLock()
TRANSCRIPTION_LOCK = threading.RLock()
CHAT_STATUS = {'stage':'idle'}
ERRORS = deque(maxlen=20)
ASSISTANT = None
ADMIN = None
SCHEDULER = None
MANAGED = None


def configure():
    PROFILE_HOME.mkdir(parents=True, exist_ok=True)
    config = PROFILE_HOME / "config.yaml"
    if not config.exists():
        provider = 'openai-codex' if reasoning_route() == 'native' else 'openai'
        config.write_text(
            f"model:\n  provider: {provider}\n  default: {MODEL}\n"
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
        provider=credentials.provider, api_mode=credentials.api_mode, model=MODEL,
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


def login_present():
    if reasoning_route() == 'native':return (PROFILE_HOME/'auth.json').is_file()
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(os.environ.get('SPEECH_URL','http://speech:8783')+'/health',timeout=3) as response:
            return json.load(response).get('login_present') is True
    except Exception:return False


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
        route=reasoning_route()
        return self.reply(200, {"ok": True, "service": "hermes", "model": MODEL,
                                "login_present": login_present(), "reasoning_route":route,
                                "refresh_owner":"cliproxy" if route=='shared' else 'hermes',
                                "telegram": ASSISTANT.health()['state'] if ASSISTANT else 'not_started',
                                "telegram_details": ASSISTANT.health() if ASSISTANT else {},
                                "administration": "running" if ADMIN and ADMIN.poll() is None else "unavailable",
                                "managed_runs":len(MANAGED.runs.active) if MANAGED else 0,
                                "scheduler": SCHEDULER.status if SCHEDULER else 'not_started'})

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
            # File capture and receipts must not queue behind model inference.
            # Detection can also be called by the guard during an active chat.
            lock = {'/internal/chat':CALL_LOCK,'/internal/detect':DETECTOR_LOCK,
                    '/internal/transcribe':TRANSCRIPTION_LOCK}.get(self.path,contextlib.nullcontext())
            with lock:
                result = self.dispatch(body)
            self.reply(200, result)
        except DetectorContractError as error:
            ERRORS.append({'route':'/internal/detect','kind':str(error)})
            self.reply(503, {'error':'detector_contract_rejected'})
        except ValueError as error:
            if self.path == '/internal/manage':
                code = str(error) if str(error) in ('configuration_conflict', 'unsupported_preference',
                    'profile_scope_denied', 'invalid_preference') else 'invalid_management_request'
                return self.reply(409 if code == 'configuration_conflict' else 400, {'error': code})
            self.reply(400, {'error': 'invalid_request'})
        except (KeyError, TypeError):
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/transcribe','/internal/file') else 'unknown','kind':'invalid_request'})
            self.reply(400, {"error": "invalid_request"})
        except Exception as error:
            status = getattr(error, "status_code", 503)
            status = status if isinstance(status, int) and status in (401, 403, 429, 503) else 503
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/refresh','/internal/transcribe','/internal/file') else 'unknown','kind':type(error).__name__,'status':status})
            self.reply(status, {"error": "quota_paused" if status == 429 else "subscription_unavailable",
                                "error_type": type(error).__name__})

    def dispatch(self, body):
        if self.path in ('/internal/run/start','/internal/run/resume','/internal/run/events','/internal/run/cancel'):
            if body.get('channel') in ('browser','scheduler'):
                if MANAGED is None:raise RuntimeError('managed_runtime_not_started')
                if self.path.endswith('/start'):return MANAGED.start(body)
                return getattr(MANAGED.runs,self.path.rsplit('/',1)[-1])(body)
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            if body.get('channel','telegram')!='telegram':raise ValueError('runtime_channel_unavailable')
            inspecting=self.path.endswith('/resume') and body.get('observe_only') is True
            if self.path.endswith(('/start','/resume')) and not inspecting and (ASSISTANT.loop is None or ASSISTANT.status!='connected'):raise RuntimeError('telegram_not_ready')
            result=getattr(ASSISTANT.runs,self.path.rsplit('/',1)[-1])(body)
            if self.path.endswith('/resume') and body.get('observe_only') is True and result.get('state')=='not_found':
                return ASSISTANT._reconcile_run(body) or result
            return result
        if self.path=='/internal/browser/events':
            if MANAGED is None:raise RuntimeError('managed_runtime_not_started')
            return MANAGED.events(body)
        if self.path=='/internal/schedule/advance':
            if SCHEDULER is None:raise RuntimeError('scheduler_not_started')
            return SCHEDULER.advance(body)
        if self.path == '/internal/security/transport':
            from .security_transport import broker_transport
            return broker_transport(resolve_credentials(),MODEL if body.get('metadata') is True else None)
        if self.path == '/internal/memory/filter':
            from .privacy import filter_knowledge
            return filter_knowledge(resolve_credentials(),MODEL,body)
        if self.path == '/internal/memory/recall':
            from .native_memory import recall
            return recall(PROFILE_HOME,body)
        if self.path == '/internal/memory/review':
            from .review_worker import review,observe
            from .scopes import Scopes
            if body.get('observe_only') is True:return observe(PROFILE_HOME,Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE')),body)
            return review(PROFILE_HOME,Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE')),MODEL,resolve_credentials(),body)
        if self.path == '/internal/manage':
            from .management import dispatch
            from .scopes import Scopes
            return dispatch(PROFILE_HOME, MODEL, Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE')), body)
        if self.path == '/internal/browser-credentials':
            from .scopes import Scopes, Scope, verify_capability
            from .native_admin import Administration,audience_revision
            policy=Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE'))
            administration=Administration(None,PROFILE_HOME,MODEL,policy,TOKEN,revision_reader=lambda space:audience_revision(TOKEN,space))
            name,path=administration.profile(body['profile']);scope=administration.binding(name)
            if scope.chat_id!=body['scope']:raise ValueError('profile_scope_denied')
            claims=verify_capability(body['archive_credential'],TOKEN,scope,body['event_id'])
            if not scope.owner and claims.get('revision')!=scope.revision:raise ValueError('browser_audience_changed')
            credentials=resolve_credentials()
            return {'model':MODEL,**credentials.runtime()}
        if self.path == '/internal/action':
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            return ASSISTANT.action(body)
        if self.path == '/internal/dispatch':
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            return ASSISTANT.call(body)
        if self.path == '/internal/status':
            from integrations.hermes.request_boundary import FAILURES, COUNTS
            return {'guard_failures':list(FAILURES),'model_boundary':dict(COUNTS),'chat':dict(CHAT_STATUS),'errors':list(ERRORS)}
        if self.path == '/internal/file':
            from telegram import Bot
            bot_token = environment_secret('TELEGRAM_BOT_TOKEN', required=False)
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
            return {"refreshed": refresh_credentials(), "owner": "cliproxy" if reasoning_route() == "shared" else "hermes"}
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
    global ASSISTANT, ADMIN, SCHEDULER
    if len(TOKEN) < 24:
        raise SystemExit("Service token is missing or too short")
    logging.disable(logging.CRITICAL)
    configure()
    from integrations.hermes.request_boundary import install
    install()
    from integrations.hermes.compatibility_patch import install as install_native_gate
    install_native_gate()
    from integrations.hermes.assistant_gateway import AssistantGateway
    from integrations.hermes.scopes import Scopes
    policy=Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE'))
    bot_token=environment_secret('TELEGRAM_BOT_TOKEN', required=False)
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8781"))), Handler)
    restarting=threading.Event()
    def restart_after_failure():
        if restarting.is_set():return
        restarting.set()
        # Let diagnostics observe the failure, then exit the entire process so no
        # orphaned getUpdates request can compete with the replacement adapter.
        timer=threading.Timer(15,server.shutdown);timer.daemon=True;timer.start()
    ASSISTANT=AssistantGateway(PROFILE_HOME,os.environ.get('NOCHEH_SPOOL_DIR','/data/spool'),policy,bot_token,MODEL,resolve_credentials,restart_after_failure)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({"event": "ready", "service": "hermes"}), flush=True)
    # One process-wide redirect, installed before starting threads. Per-request
    # redirects race and can restore another request's secret-bearing output.
    with open(os.devnull,'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        ASSISTANT.start()
        ADMIN = admin = subprocess.Popen([sys.executable, '-m', 'integrations.hermes.native_admin'], stdout=quiet, stderr=quiet)
        from .native_admin import Administration,audience_revision
        from .scheduler import Scheduler
        administration=Administration(None,PROFILE_HOME,MODEL,policy,TOKEN,revision_reader=lambda space:audience_revision(TOKEN,space))
        from .managed_async import ManagedAsync
        global MANAGED
        SCHEDULER=Scheduler(administration,resolve_credentials)
        MANAGED=ManagedAsync(administration,resolve_credentials,scheduler=SCHEDULER)
        SCHEDULER.managed_flush=MANAGED.flush
        SCHEDULER.start()
        try: server.serve_forever()
        finally:
            MANAGED.stop()
            SCHEDULER.stop()
            admin.terminate()
            try: admin.wait(timeout=10)
            except subprocess.TimeoutExpired: admin.kill(); admin.wait()
            ASSISTANT.stop()
    if restarting.is_set():raise SystemExit(1)


if __name__ == "__main__":
    main()
