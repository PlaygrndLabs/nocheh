"""Small authenticated service around native Hermes and its mounted profile state."""
from __future__ import annotations

from services.hermes.environment import secret as environment_secret, parallel

import base64
import asyncio
import re
import contextlib
import hmac
import json
import logging
import os
import signal
import subprocess
import sys
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .subscription import resolve_credentials, detect_literals, DetectorContractError, ProviderNotConfigured, part_model

MODEL = os.environ.get("NOCHEH_MODEL", "claude-sonnet-5-5")
ROOT = Path(__file__).resolve().parents[2]
PROFILE_HOME = Path(os.environ["HERMES_HOME"])
TOKEN = environment_secret('SERVICE_TOKEN')
CALL_LOCK = threading.RLock()


class AttachmentTooLarge(Exception):
    """A Telegram file the bot can never download, so its retrieval settles."""


class DetectorSlots:
    """Secret-guard checks run side by side up to the owner's Settings value.
    Checks for replies take a free slot before any waiting background check,
    and background learning leaves one slot free for replies when it can."""
    def __init__(self, size):
        self.size, self.used, self.background, self.waiting = size, 0, 0, 0
        self.changed = threading.Condition()

    @contextlib.contextmanager
    def slot(self, background=False):
        with self.changed:
            if background:
                self.changed.wait_for(lambda: not self.waiting and self.used < self.size
                                      and self.background < max(1, self.size - 1))
                self.background += 1
            else:
                self.waiting += 1
                try: self.changed.wait_for(lambda: self.used < self.size)
                finally:
                    self.waiting -= 1
                    self.changed.notify_all()
            self.used += 1
        try:
            yield
        finally:
            with self.changed:
                self.used -= 1
                if background: self.background -= 1
                self.changed.notify_all()


DETECTOR_SLOTS = DetectorSlots(parallel('NOCHEH_PARALLEL_GUARD_CHECKS', 3, 4))
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
        # Voice notes are archived without transcription.
        config.write_text(
            f"model:\n  provider: openai\n  default: {MODEL}\n"
            "stt:\n  enabled: false\n"
            "plugins:\n  enabled: [nocheh]\nfallback_models: []\n"
        )
    plugin = PROFILE_HOME / "plugins/nocheh"
    plugin.parent.mkdir(exist_ok=True)
    target = os.path.relpath(ROOT / "services/hermes", plugin.parent)
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
            # A document, image or recording to read arrives whole, as base64 of up to 50 MB.
            if not 0 < length <= (70 if self.path in ('/internal/extract', '/internal/transcribe', '/internal/image') else 36) * 1024 * 1024:
                return self.reply(413, {"error": "invalid_body_size"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.reply(400, {"error": "expected_object"})
            # File capture and receipts must not queue behind model inference.
            # Detection can also be called by the guard during an active chat.
            lock = DETECTOR_SLOTS.slot(body.get('priority') == 'background') if self.path == '/internal/detect' else \
                {'/internal/chat':CALL_LOCK}.get(self.path,contextlib.nullcontext())
            with lock:
                result = self.dispatch(body)
            self.reply(200, result)
        except ProviderNotConfigured:
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/file') else 'unknown','kind':'provider_not_configured'})
            self.reply(503, {'error':'provider_not_configured'})
        except AttachmentTooLarge:
            self.reply(413, {'error':'attachment_too_large'})
        except DetectorContractError as error:
            ERRORS.append({'route':'/internal/detect','kind':str(error),'shape':error.shape})
            self.reply(503, {'error':'detector_contract_rejected'})
        except ValueError as error:
            if self.path == '/internal/manage':
                code = str(error) if str(error) in ('configuration_conflict', 'unsupported_preference',
                    'profile_scope_denied', 'invalid_preference', 'invalid_persona') else 'invalid_management_request'
                return self.reply(409 if code == 'configuration_conflict' else 400, {'error': code})
            self.reply(400, {'error': 'invalid_request'})
        except (KeyError, TypeError):
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/file') else 'unknown','kind':'invalid_request'})
            self.reply(400, {"error": "invalid_request"})
        except Exception as error:
            status = getattr(error, "status_code", 503)
            status = status if isinstance(status, int) and status in (401, 403, 429, 503) else 503
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect','/internal/file') else 'unknown','kind':type(error).__name__,'status':status})
            self.reply(status, {"error": "quota_paused" if status == 429 else "subscription_unavailable",
                                "error_type": type(error).__name__})

    def dispatch(self, body):
        if self.path in ('/internal/run/start','/internal/run/resume','/internal/run/events','/internal/run/cancel'):
            if body.get('channel') in ('browser','scheduler','background'):
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
        if self.path == '/internal/extract':
            from .document_text import extract
            return extract(body)
        if self.path == '/internal/transcribe':
            from .voice_text import transcribe
            return transcribe(body)
        if self.path == '/internal/image':
            from .image_text import read_image
            return read_image(body)
        if self.path == '/internal/memory/filter':
            from .privacy import filter_knowledge
            return filter_knowledge(resolve_credentials(),MODEL,body)
        if self.path == '/internal/memory/recall':
            from .native_memory import recall
            return recall(PROFILE_HOME,body)
        if self.path == '/internal/memory/review':
            from .review_worker import start,observe
            from .scopes import Scopes
            if body.get('observe_only') is True:return observe(PROFILE_HOME,Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE')),body)
            return start(PROFILE_HOME,Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE')),MODEL,resolve_credentials(),body)
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
        if self.path == '/internal/telegram/approval':
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            return ASSISTANT.approval(body)
        if self.path == '/internal/telegram/refusal':
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            return ASSISTANT.refusal(body)
        if self.path == '/internal/telegram/notice':
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            return ASSISTANT.notice(body)
        if self.path == '/internal/dispatch':
            if ASSISTANT is None:raise RuntimeError('assistant_not_started')
            return ASSISTANT.call(body)
        if self.path == '/internal/status':
            from services.hermes.request_boundary import FAILURES, FAILURE_DETAILS, COUNTS
            return {'guard_failures':list(FAILURES),'guard_failure_details':list(FAILURE_DETAILS),'model_boundary':dict(COUNTS),
                    'chat':dict(CHAT_STATUS),'errors':list(ERRORS)}
        if self.path == '/internal/file':
            from telegram import Bot
            bot_token = environment_secret('TELEGRAM_BOT_TOKEN', required=False)
            if not bot_token:
                raise RuntimeError('telegram_not_configured')
            ref = body['file_id']
            if not isinstance(ref, str) or not ref or len(ref) > 1024:
                raise ValueError('invalid_file_id')
            async def download():
                from telegram.error import BadRequest
                async with Bot(bot_token) as bot:
                    try:
                        file = await bot.get_file(ref)
                    except BadRequest as error:
                        # The Bot API refuses files over 20 MB; retrying never helps.
                        if 'too big' in str(error).lower():
                            raise AttachmentTooLarge() from error
                        raise
                    if file.file_size and file.file_size > 50*1024*1024:
                        raise AttachmentTooLarge()
                    return await file.download_as_bytearray()
            raw = asyncio.run(download())
            if len(raw) > 50*1024*1024:
                raise AttachmentTooLarge()
            return {'bytes_base64': base64.b64encode(raw).decode()}
        if self.path == '/internal/telegram/chat':
            # Owner-requested presentation refresh: getChat only, never a send
            # or a poll, so the single polling authority is unaffected.
            from telegram import Bot
            from telegram.error import BadRequest, ChatMigrated, Forbidden
            bot_token = environment_secret('TELEGRAM_BOT_TOKEN', required=False)
            if not bot_token:
                raise RuntimeError('telegram_not_configured')
            chat_id = body.get('chat_id')
            if not isinstance(chat_id, str) or not re.fullmatch(r'-?[1-9][0-9]{0,18}', chat_id):
                raise ValueError('invalid_chat_id')
            async def read_chat():
                async with Bot(bot_token) as bot:
                    try:
                        found = await bot.get_chat(int(chat_id))
                    except ChatMigrated as error:
                        return {'chat_id': chat_id, 'state': 'migrated', 'migrate_to_chat_id': str(error.new_chat_id)}
                    except Forbidden:
                        return {'chat_id': chat_id, 'state': 'not_member'}
                    except BadRequest:
                        return {'chat_id': chat_id, 'state': 'not_found'}
                    return {'chat_id': str(found.id), 'state': 'available', 'type': found.type, 'title': found.title,
                            'username': found.username, 'is_forum': bool(getattr(found, 'is_forum', False))}
            return asyncio.run(read_chat())
        if self.path == "/internal/usage/price":
            # Prices Honcho's reported memory tokens with Hermes's own pricing table; counts only, no content.
            from services.hermes.usage import price
            rows = body.get("rows")
            if isinstance(rows, list):
                # A row for the reply model, such as a background job's estimate, is priced as the model replies use.
                reply = {"model": MODEL or "", "provider": os.environ.get("NOCHEH_REPLY_ROUTE_PROVIDER") or "openai",
                         "base_url": os.environ.get("NOCHEH_REPLY_ROUTE_URL") or ""}
                rows = [{**row, **reply} if isinstance(row, dict) and row.get("part") == "reply" else row for row in rows]
            return {"costs": price(rows)}
        if self.path in ("/internal/chat", "/internal/detect"):
            text = body["text"]
            if not isinstance(text, str) or len(text) > 100000:
                raise ValueError("invalid_text")
            return chat(text) if self.path.endswith("chat") else {"literals": detect_literals(text, resolve_credentials("guard"), part_model("guard"), body.get("prompts"))}
        raise ValueError("unknown_route")


def main():
    global ASSISTANT, ADMIN, SCHEDULER
    if len(TOKEN) < 24:
        raise SystemExit("Service token is missing or too short")
    logging.disable(logging.CRITICAL)
    configure()
    from services.hermes.request_boundary import install
    install()
    from services.hermes.compatibility_patch import install as install_native_gate
    install_native_gate()
    from services.hermes.assistant_gateway import AssistantGateway
    from services.hermes.scopes import Scopes
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
    # Finished delivery journals expire before the boot rescans read them.
    from . import journal_retention
    spool,managed_runs,journal_days=Path(os.environ.get('NOCHEH_SPOOL_DIR','/data/spool')),PROFILE_HOME/'nocheh-managed-runs',journal_retention.retention_days()
    journal_retention.prune(spool,managed_runs,journal_days)
    journal_stop=threading.Event();journal_retention.start(spool,managed_runs,journal_days,journal_stop)
    ASSISTANT=AssistantGateway(PROFILE_HOME,str(spool),policy,bot_token,MODEL,resolve_credentials,restart_after_failure)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({"event": "ready", "service": "hermes"}), flush=True)
    # One process-wide redirect, installed before starting threads. Per-request
    # redirects race and can restore another request's secret-bearing output.
    with open(os.devnull,'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        ASSISTANT.start()
        ADMIN = admin = subprocess.Popen([sys.executable, '-m', 'services.hermes.native_admin'], stdout=quiet, stderr=quiet)
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
            journal_stop.set()
            MANAGED.stop()
            SCHEDULER.stop()
            admin.terminate()
            try: admin.wait(timeout=10)
            except subprocess.TimeoutExpired: admin.kill(); admin.wait()
            ASSISTANT.stop()
    if restarting.is_set():raise SystemExit(1)


if __name__ == "__main__":
    main()
