"""Small authenticated service around native Hermes and its mounted profile state."""
from __future__ import annotations

from services.hermes.environment import secret as environment_secret, parallel

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
# The agent login: Nocheh's calls here carry it, and Hermes's calls to Nocheh too (ADR-0291). main() refuses to start
# without it, with a plain reason; a missing one refuses every call here.
TOKEN = environment_secret('AGENT_KEY', False)
CALL_LOCK = threading.RLock()


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
ADMIN = None
SCHEDULER = None
MANAGED = None
AGENT = None


def configure():
    PROFILE_HOME.mkdir(parents=True, exist_ok=True)
    # The locked-down container's HOME is /tmp/home, empty after each restart (ADR-0251); tools that expect their
    # home to exist find it. Under make dev it is the mounted state folder, which exists.
    home = os.environ.get('HOME', '')
    if os.path.isabs(home):
        with contextlib.suppress(OSError):
            Path(home).mkdir(parents=True, exist_ok=True, mode=0o700)
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
                                "administration": "running" if ADMIN and ADMIN.poll() is None else "unavailable",
                                "managed_runs":len(MANAGED.runs.active) if MANAGED else 0,
                                "agent_turns":len(AGENT.runs.active) if AGENT else 0,
                                "scheduler": SCHEDULER.status if SCHEDULER else 'not_started'})

    def do_POST(self):
        if not TOKEN or not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + TOKEN).encode()):
            return self.reply(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            # A document, image or recording to read arrives whole, as base64 of up to 50 MB.
            if not 0 < length <= (70 if self.path in ('/internal/extract', '/internal/transcribe', '/internal/image') else 36) * 1024 * 1024:
                return self.reply(413, {"error": "invalid_body_size"})
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.reply(400, {"error": "expected_object"})
            # Other routes must not queue behind model inference.
            # Detection can also be called by the guard during an active chat.
            lock = DETECTOR_SLOTS.slot(body.get('priority') == 'background') if self.path == '/internal/detect' else \
                {'/internal/chat':CALL_LOCK}.get(self.path,contextlib.nullcontext())
            with lock:
                result = self.dispatch(body)
            self.reply(200, result)
        except ProviderNotConfigured:
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect') else 'unknown','kind':'provider_not_configured'})
            self.reply(503, {'error':'provider_not_configured'})
        except DetectorContractError as error:
            ERRORS.append({'route':'/internal/detect','kind':str(error),'shape':error.shape})
            self.reply(503, {'error':'detector_contract_rejected'})
        except ValueError as error:
            if self.path == '/internal/manage':
                code = str(error) if str(error) in ('configuration_conflict', 'unsupported_preference',
                    'profile_scope_denied', 'invalid_preference', 'invalid_persona', 'cron_job_not_found', 'cron_already_pending',
                    'cron_definition_not_captured', 'cron_operation_unavailable', 'cron_topic_scope_unavailable',
                    'cron_change_refused') else 'invalid_management_request'
                return self.reply(409 if code == 'configuration_conflict' else 400, {'error': code})
            self.reply(400, {'error': 'invalid_request'})
        except (KeyError, TypeError):
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect') else 'unknown','kind':'invalid_request'})
            self.reply(400, {"error": "invalid_request"})
        except Exception as error:
            status = getattr(error, "status_code", 503)
            status = status if isinstance(status, int) and status in (401, 403, 429, 503) else 503
            ERRORS.append({'route':self.path if self.path in ('/internal/chat','/internal/detect') else 'unknown','kind':type(error).__name__,'status':status})
            self.reply(status, {"error": "quota_paused" if status == 429 else "subscription_unavailable",
                                "error_type": type(error).__name__})

    def dispatch(self, body):
        # Telegram turns return their reply, which Nocheh sends; Hermes never talks to Telegram.
        if self.path in ('/internal/turn/start','/internal/turn/resume','/internal/turn/events','/internal/turn/cancel'):
            if AGENT is None:raise RuntimeError('agent_not_started')
            return getattr(AGENT,self.path.rsplit('/',1)[-1])(body)
        # Schedules and background jobs; a Telegram turn has only the turn routes. The dashboard chat page is off
        # until Nocheh has its own chat page (Telegram only), so no browser run starts here.
        if self.path in ('/internal/run/start','/internal/run/resume','/internal/run/events','/internal/run/cancel'):
            if body.get('channel') not in ('scheduler','background'):raise ValueError('runtime_channel_unavailable')
            if MANAGED is None:raise RuntimeError('managed_runtime_not_started')
            if self.path.endswith('/start'):return MANAGED.start(body)
            return getattr(MANAGED.runs,self.path.rsplit('/',1)[-1])(body)
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
        if self.path == '/internal/manage' and body.get('action') == 'schedules':
            # The owner's Schedules pages: Hermes's schedule stores, through the owner adapter the command line uses (ADR-0266).
            from .scopes import Scopes
            from .native_admin import Administration
            from .native_cron import owner_schedules
            policy=Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE'))
            return owner_schedules(Administration(None,PROFILE_HOME,MODEL,policy,TOKEN),body)
        if self.path == '/internal/manage':
            from .management import dispatch
            from .scopes import Scopes
            return dispatch(PROFILE_HOME, MODEL, Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE')), body)
        if self.path == '/internal/status':
            from services.hermes.request_boundary import FAILURES, FAILURE_DETAILS, COUNTS
            return {'guard_failures':list(FAILURES),'guard_failure_details':list(FAILURE_DETAILS),'model_boundary':dict(COUNTS),
                    'chat':dict(CHAT_STATUS),'errors':list(ERRORS)}
        if self.path == "/internal/usage/price":
            # Prices Honcho's reported memory tokens with Hermes's own pricing table; counts only, no content.
            from services.hermes.usage import price, reply_rates
            reply = {"model": MODEL or "", "provider": os.environ.get("NOCHEH_REPLY_ROUTE_PROVIDER") or "openai",
                     "base_url": os.environ.get("NOCHEH_REPLY_ROUTE_URL") or ""}
            # A background job freezes the reply model's rates on its card and prices its steps' tokens with them.
            if body.get("rates") == "reply":
                return {"rates": reply_rates(reply["model"], reply["provider"], reply["base_url"])}
            rows = body.get("rows")
            if isinstance(rows, list):
                # A row for the reply model is priced as the model replies use.
                rows = [{**row, **reply} if isinstance(row, dict) and row.get("part") == "reply" else row for row in rows]
            return {"costs": price(rows)}
        if self.path in ("/internal/chat", "/internal/detect"):
            text = body["text"]
            if not isinstance(text, str) or len(text) > 100000:
                raise ValueError("invalid_text")
            return chat(text) if self.path.endswith("chat") else {"literals": detect_literals(text, resolve_credentials("guard"), part_model("guard"), body.get("prompts"))}
        raise ValueError("unknown_route")


def main():
    global ADMIN, SCHEDULER, AGENT
    from services.hermes.environment import agent_key, refuse_master_key, session_token
    refuse_master_key()
    try: agent_key()
    except ValueError as error: raise SystemExit(str(error) + '; run ./bin/nocheh up') from None
    session_token()
    logging.disable(logging.CRITICAL)
    configure()
    from services.hermes.request_boundary import install
    install()
    from services.hermes.compatibility_patch import install as install_native_gate
    install_native_gate()
    from services.hermes.scopes import Scopes
    policy=Scopes.load(os.environ.get('ASSISTANT_POLICY_FILE'))
    server = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8781"))), Handler)
    # Finished run journals expire before the boot rescans read them.
    from . import journal_retention
    spool,managed_runs,journal_days=Path(os.environ.get('NOCHEH_SPOOL_DIR','/data/spool')),PROFILE_HOME/'nocheh-managed-runs',journal_retention.retention_days()
    journal_retention.prune(spool,managed_runs,journal_days)
    journal_stop=threading.Event();journal_retention.start(spool,managed_runs,journal_days,journal_stop)
    from services.hermes.agent_turns import AgentTurns
    AGENT=AgentTurns(PROFILE_HOME,str(spool),policy,MODEL,resolve_credentials)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    print(json.dumps({"event": "ready", "service": "hermes"}), flush=True)
    # One process-wide redirect, installed before starting threads. Per-request
    # redirects race and can restore another request's secret-bearing output.
    with open(os.devnull,'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        AGENT.open()
        ADMIN = admin = subprocess.Popen([sys.executable, '-m', 'services.hermes.native_admin'], stdout=quiet, stderr=quiet)
        from .native_admin import Administration
        from .scheduler import Scheduler
        administration=Administration(None,PROFILE_HOME,MODEL,policy,TOKEN)
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
            AGENT.stop()
            SCHEDULER.stop()
            admin.terminate()
            try: admin.wait(timeout=10)
            except subprocess.TimeoutExpired: admin.kill(); admin.wait()


if __name__ == "__main__":
    main()
