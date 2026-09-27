import contextlib
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from tools.cli import admin


EVENT = "a" * 64
WORKFLOW = "b" * 64


class FakeAPI:
    calls = []

    def call(self, path, timeout=30):
        self.calls.append((path, timeout))
        if path.startswith("/v1/events/"):
            return {"id": EVENT, "received_at": "2026-09-27T12:00:00Z", "event": {"text": "private phrase", "scope": "telegram:private:42"},
                    "reply_messages": [{"id": "c" * 64, "text": "agent reply", "received_at": "2026-09-27T12:01:00Z"}]}
        if path.startswith("/v1/workflows?"):
            return {"workflows": [{"id": WORKFLOW, "source_event_id": EVENT, "state": "completed", "receipts": [{"receipt_id": "d" * 64}]}], "event_filter": EVENT, "next": None}
        return {"records": [], "next": None}


class AdminCliTests(unittest.TestCase):
    def setUp(self):
        FakeAPI.calls = []

    def run_cli(self, *arguments):
        output = io.StringIO()
        with patch.object(admin, "API", FakeAPI), contextlib.redirect_stdout(output):
            result = admin.main(arguments)
        return result, json.loads(output.getvalue())

    def test_trace_correlates_event_replies_and_workflows_without_content(self):
        result, data = self.run_cli("trace", EVENT, "--json")
        self.assertEqual(result, 0)
        self.assertEqual(data["event"]["reply_messages"][0]["id"], "c" * 64)
        self.assertEqual(data["event"]["reply_messages"][0]["text"], "[redacted]")
        self.assertEqual(data["event"]["event"]["scope"], "[redacted]")
        self.assertEqual(data["workflows"]["workflows"][0]["source_event_id"], EVENT)
        self.assertEqual(data["workflows"]["workflows"][0]["receipts"][0]["receipt_id"], "d" * 64)
        self.assertIn("event=" + EVENT, FakeAPI.calls[1][0])

    def test_trace_latest_selects_newest_incoming_event_with_scope(self):
        class LatestAPI(FakeAPI):
            def call(self, path, timeout=30):
                if path.startswith("/v1/data?"):
                    self.calls.append((path, timeout))
                    return {"records": [{"id": EVENT, "received_at": "2026-09-27T12:00:00Z"}], "next": None}
                return super().call(path, timeout)

        output = io.StringIO()
        with patch.object(admin, "API", LatestAPI), contextlib.redirect_stdout(output):
            self.assertEqual(admin.main(["trace", "latest", "--scope", "telegram:private:42", "--json"]), 0)
        self.assertEqual(json.loads(output.getvalue())["event"]["id"], EVENT)
        self.assertIn("scope=telegram%3Aprivate%3A42", FakeAPI.calls[0][0])
        self.assertEqual(FakeAPI.calls[1][0], "/v1/events/" + EVENT)

    def test_trace_latest_empty_scope_fails_closed(self):
        error_output = io.StringIO()
        with patch.object(admin, "API", FakeAPI), contextlib.redirect_stderr(error_output):
            self.assertEqual(admin.main(["trace", "latest", "--json"]), 1)
        self.assertIn("no captured incoming event", error_output.getvalue())

    def test_content_requires_explicit_flag(self):
        _, data = self.run_cli("--content", "event", EVENT, "--json")
        self.assertEqual(data["event"]["text"], "private phrase")
        self.assertEqual(data["reply_messages"][0]["text"], "agent reply")

    def test_invalid_id_does_not_call_api(self):
        with patch.object(admin, "API", FakeAPI), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                admin.main(["event", "wrong"])
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(FakeAPI.calls, [])

    def test_workflow_filter_is_encoded(self):
        self.run_cli("workflows", "--event", EVENT, "--json")
        self.assertIn("event=" + EVENT, FakeAPI.calls[0][0])

    def test_old_api_cannot_silently_return_unfiltered_workflows(self):
        class OldAPI(FakeAPI):
            def call(self, path, timeout=30):
                value = super().call(path, timeout)
                if path.startswith("/v1/workflows?"):
                    value.pop("event_filter")
                return value

        error_output = io.StringIO()
        with patch.object(admin, "API", OldAPI), contextlib.redirect_stderr(error_output), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(admin.main(["trace", EVENT, "--json"]), 1)
        self.assertIn("lacks the event workflow filter", error_output.getvalue())

    def test_unknown_new_api_fields_are_redacted(self):
        value = {"id": EVENT, "agent_output": "private answer", "payload": {"id": "secret chat identity"},
                 "reply_messages": [{"id": "c" * 64, "new_text_field": "private answer"}]}
        filtered = admin.redact(value)
        self.assertEqual(filtered["agent_output"], "[redacted]")
        self.assertEqual(filtered["payload"], "[redacted]")
        self.assertEqual(filtered["reply_messages"][0]["new_text_field"], "[redacted]")
        self.assertEqual(filtered["reply_messages"][0]["id"], "c" * 64)

    def test_api_failure_is_actionable_without_echoing_response_body(self):
        class FailingAPI:
            def call(self, path, timeout=30):
                raise urllib.error.HTTPError(path, 403, "forbidden", {}, io.BytesIO(b'{"error":"owner_access_denied","text":"private data"}'))

        error_output = io.StringIO()
        with patch.object(admin, "API", FailingAPI), contextlib.redirect_stderr(error_output):
            self.assertEqual(admin.main(["event", EVENT]), 1)
        self.assertIn("owner_access_denied (HTTP 403)", error_output.getvalue())
        self.assertNotIn("private data", error_output.getvalue())


if __name__ == "__main__":
    unittest.main()
