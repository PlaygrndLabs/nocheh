"""Read-only owner inspection for live acceptance and operations.

Uses the installation's authenticated loopback API. Source content is omitted
unless --content is explicitly requested; JSON has the same default boundary.
"""

import argparse
import json
import re
import sys
import urllib.error
from urllib.parse import urlencode

from .archive import API

ID = re.compile(r"[a-f0-9]{64}\Z")


def identity(parser, value):
    if not ID.fullmatch(value):
        parser.error("expected a 64-character lowercase hexadecimal ID")
    return value


def parser_for():
    parser = argparse.ArgumentParser(prog="nocheh admin", description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--content", action="store_true", help="Include source text and payloads (sensitive)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="Service and archive status")
    events = commands.add_parser("events", help="Recent original events")
    events.add_argument("--after", default="", help="Cursor from the previous page")
    events.add_argument("--scope", default="", help="Exact conversation scope")
    events.add_argument("--kind", choices=("incoming", "assistant"), default="")
    events.add_argument("--reply", choices=("approval_pending", "pending", "running", "failed", "done", "ambiguous", "suppressed", "cancelled", "not_started"), default="")
    search = commands.add_parser("search", help="Search original events")
    search.add_argument("query")
    search.add_argument("--scope", default="")
    search.add_argument("--limit", type=int, default=20)
    event = commands.add_parser("event", help="Inspect one original and linked output metadata")
    event.add_argument("id")
    trace = commands.add_parser("trace", help="Correlate an event with linked replies and workflows")
    trace.add_argument("id")
    workflows = commands.add_parser("workflows", help="Workflow list with source and receipt IDs")
    workflows.add_argument("--family")
    workflows.add_argument("--state")
    workflows.add_argument("--event", help="Source event ID")
    workflows.add_argument("--after", default="")
    workflows.add_argument("--limit", type=int, default=50)
    workflow = commands.add_parser("workflow", help="One workflow, attempts and receipts")
    workflow.add_argument("id")
    commands.add_parser("workflow-health", help="Workflow ownership and backlog health")
    commands.add_parser("honcho", help="Connection, generations and receipt counts")
    learned = commands.add_parser("learned", help="Learned interpretations")
    learned.add_argument("--after", default="")
    learned.add_argument("--scope-kind", choices=("conversation", "project"))
    learned.add_argument("--scope-id")
    item = commands.add_parser("learning", help="One learned interpretation and history")
    item.add_argument("id")
    reviews = commands.add_parser("reviews", help="Native memory review jobs")
    reviews.add_argument("--after", default="")
    commands.add_parser("approvals", help="Pending owner actions and decisions")
    return parser


def path_for(parser, args):
    command = args.command
    if command == "status": return "/v1/status"
    if command == "events":
        if args.after: identity(parser, args.after)
        return "/v1/data?" + urlencode({"after": args.after, "scope": args.scope, "kind": args.kind, "reply": args.reply})
    if command == "search":
        if not args.query.strip(): parser.error("search query must not be empty")
        if not 1 <= args.limit <= 50: parser.error("--limit must be between 1 and 50")
        return "/v1/search?" + urlencode({"q": args.query, "scope": args.scope, "limit": args.limit})
    if command in ("event", "trace"): return "/v1/events/" + identity(parser, args.id)
    if command == "workflows":
        if not 1 <= args.limit <= 100: parser.error("--limit must be between 1 and 100")
        if args.event: identity(parser, args.event)
        return "/v1/workflows?" + urlencode({"family": args.family or "", "state": args.state or "", "event": args.event or "", "after": args.after, "limit": args.limit})
    if command == "workflow": return "/v1/workflows/" + identity(parser, args.id)
    if command == "workflow-health": return "/v1/workflows/health"
    if command == "honcho": return "/v1/memory/honcho"
    if command == "learned":
        if bool(args.scope_kind) != bool(args.scope_id): parser.error("--scope-kind and --scope-id must be used together")
        return "/v1/learned?" + urlencode({"after": args.after, **({"scope_kind": args.scope_kind, "scope_id": args.scope_id} if args.scope_kind else {})})
    if command == "learning": return "/v1/learned/" + identity(parser, args.id)
    if command == "reviews": return "/v1/memory/reviews?" + urlencode({"after": args.after})
    if command == "approvals": return "/v1/tools/actions"
    raise AssertionError(command)


def redact(value):
    """Only known metadata keys may reach default terminal or JSON output."""
    safe = {
        "id", "event_id", "source_event_id", "workflow_id", "receipt_id", "operation_id", "action_id", "job_id", "generation",
        "kind", "family", "origin", "channel", "state", "status", "stage", "assistant_state", "assistant_stage",
        "assistant_error", "assistant_attempts", "error_code", "attempts", "waiting_reason", "control_reason",
        "created_at", "updated_at", "received_at", "occurred_at", "delivered_at", "attached_at", "last_ready_at",
        "next_attempt", "observed_at", "seen_at", "refreshed_at", "next", "revision", "active_revision", "guard_epoch",
        "policy_revision", "owner_epoch", "fingerprint", "content_hash", "file_hash", "byte_size", "count", "events",
        "total", "completed", "duplicates", "pending", "ready", "syncing", "limited_memory", "attached", "verified",
        "active_step", "can_retry", "can_cancel", "retired", "representation", "primary", "storage_layout", "guard_mode",
        "service", "mode", "admission", "dispatch", "format", "scope_kind", "truncated",
    }
    containers = {"records", "workflows", "receipts", "event", "reply_messages", "runs", "outbox", "controls", "services",
                  "archive", "workers", "connection", "generations", "guard", "policy", "jobs", "artifacts", "derived",
                  "actions", "permissions", "telegram", "versions", "items", "counts"}
    if isinstance(value, list): return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: (item if key in safe and not isinstance(item, (dict, list)) else
                      redact(item) if key in containers else "[redacted]") for key, item in value.items()}
    return value


def render(value, command):
    if isinstance(value, list):
        for item in value: render(item, command)
        return
    if isinstance(value, dict):
        if command == "events" and "records" in value:
            render(value["records"], command)
            if value.get("next"): print("next:", value["next"])
            return
        if command == "workflows" and "workflows" in value:
            render(value["workflows"], command)
            if value.get("next"): print("next:", value["next"])
            return
        if command == "search":
            print(" ".join(str(value.get(key, "")) for key in ("id", "kind", "occurred_at", "assistant_state")))
            return
        if command in ("events", "workflows", "reviews", "learned") and "id" in value:
            print(" ".join(str(value.get(key, "")) for key in ("id", "kind" if command == "events" else "family", "state" if command == "workflows" else "assistant_state", "received_at" if command == "events" else "updated_at")))
            return
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def main(arguments=None):
    parser = parser_for()
    arguments = list(sys.argv[1:] if arguments is None else arguments)
    # Match epa's useful global-flag placement without making each subcommand
    # define separate, potentially inconsistent privacy defaults.
    global_flags = [item for item in arguments if item in ("--json", "--content")]
    args = parser.parse_args(global_flags + [item for item in arguments if item not in ("--json", "--content")])
    path = path_for(parser, args)
    try:
        api = API()
        value = api.call(path, timeout=30)
        if args.command == "trace":
            workflows = api.call("/v1/workflows?" + urlencode({"event": args.id, "limit": 100}), timeout=30)
            value = {"event": value, "workflows": workflows}
    except (FileNotFoundError, KeyError, ValueError):
        print("admin: installation configuration unavailable; initialize the selected installation", file=sys.stderr)
        return 2
    except urllib.error.HTTPError as error:
        try: detail = json.load(error).get("error", "request_failed")
        except (ValueError, AttributeError): detail = "request_failed"
        print(f"admin: {detail} (HTTP {error.code})", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError):
        print("admin: installation API unavailable", file=sys.stderr)
        return 1
    if not args.content: value = redact(value)
    if args.json: print(json.dumps(value, ensure_ascii=False, indent=2, default=str))
    else: render(value, args.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
