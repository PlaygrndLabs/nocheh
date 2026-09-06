"""Offline contract tests against the pinned, real Hermes interfaces.

Transport responses are simulated; these tests do not establish live compatibility.
"""

import base64
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from compatibility.probe import ROOT, configure_probe_home, docker_asr, report_exit_code, validate_audio
from integrations.hermes.subscription import SubscriptionCredentials, detect_literals
from integrations.hermes.transcription import SubscriptionTranscriptionProvider, process_environment


class SubscriptionContracts(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ))
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        configure_probe_home(self.home)
        self.enterContext(patch("socket.socket.connect", side_effect=AssertionError("Offline test attempted network")))
        # Never import the real user's Codex tokens when exercising native recovery.
        self.enterContext(patch("hermes_cli.auth._import_codex_cli_tokens", return_value=None))
        from hermes_cli.plugins import _ensure_plugins_discovered
        _ensure_plugins_discovered()
        self.audio = ROOT / "compatibility/fixtures/subscription-speech.ogg"
        self.credentials = Mock(return_value=SubscriptionCredentials("synthetic-token"))

    def provider(self, *, output=None, code=0, error="", side_effect=None):
        runner = Mock(side_effect=side_effect, return_value=subprocess.CompletedProcess(
            ["codex-asr"], code, json.dumps(output) if output is not None else "", error))
        return SubscriptionTranscriptionProvider(self.credentials, runner), runner

    def test_transcript_preserves_unicode_spaces_and_line_endings(self):
        original = "  سلام، Aws stays Aws.\r\nCafe\u0301\t🙂  "
        provider, _ = self.provider(output={"text": original})
        self.assertEqual(provider.transcribe(self.audio)["transcript"], original)

    def test_each_request_resolves_current_credentials(self):
        self.credentials.side_effect = [SubscriptionCredentials("old"), SubscriptionCredentials("new")]
        provider, runner = self.provider(output={"text": "speech"})
        provider.transcribe(self.audio)
        provider.transcribe(self.audio)
        self.assertEqual([call.args[2] for call in runner.call_args_list], ["old", "new"])

    def test_failed_requests_are_classified_without_leaking_upstream_body(self):
        cases = [(401, "auth_required", False), (403, "access_denied", False),
                 (429, "quota_paused", True), (503, "transcription_failed", True)]
        for status, reason, retryable in cases:
            with self.subTest(status=status):
                provider, runner = self.provider(code=1, error=f"HTTP {status}: private response synthetic-token")
                result = provider.transcribe(self.audio)
                self.assertEqual((result["error"], result["retryable"]), (reason, retryable))
                self.assertNotIn("private response", json.dumps(result))
                self.assertNotIn("synthetic-token", json.dumps(result))
                self.assertEqual(runner.call_count, 1)  # Retry scheduling belongs to the archive worker.

    def test_timeout_is_retryable_and_does_not_retry_internally(self):
        provider, runner = self.provider(side_effect=subprocess.TimeoutExpired("codex-asr", 100))
        result = provider.transcribe(self.audio)
        self.assertEqual(result["error"], "transcription_timeout")
        self.assertTrue(result["retryable"])
        self.assertEqual(runner.call_count, 1)

    def test_docker_timeout_removes_only_the_probe_container(self):
        with patch("compatibility.probe.subprocess.run", side_effect=[
            subprocess.TimeoutExpired("docker", 110), subprocess.CompletedProcess([], 0)
        ]) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                docker_asr(self.audio, None, "synthetic-token")
        start, cleanup = run.call_args_list
        name = start.args[0][start.args[0].index("--name") + 1]
        self.assertEqual(cleanup.args[0], ["docker", "rm", "-f", name])
        self.assertNotIn("CODEX_ASR_BEARER", cleanup.kwargs["env"])
        self.assertNotIn("synthetic-token", " ".join(start.args[0]))

    def test_quota_during_credential_refresh_pauses_before_audio_upload(self):
        from hermes_cli.auth_codex import _codex_quota_exhausted_error
        self.credentials.side_effect = _codex_quota_exhausted_error(60)
        provider, runner = self.provider(output={"text": "speech"})
        result = provider.transcribe(self.audio)
        self.assertEqual(result["error"], "quota_paused")
        self.assertTrue(result["retryable"])
        runner.assert_not_called()

    def test_invalid_response_is_not_a_successful_empty_transcript(self):
        for output in ({"text": " "}, {"text": 4}, [], {"result": "speech"}):
            with self.subTest(output=output):
                provider, _ = self.provider(output=output)
                self.assertFalse(provider.transcribe(self.audio)["success"])

    def test_missing_audio_makes_zero_requests(self):
        provider, runner = self.provider(output={"text": "speech"})
        self.assertFalse(provider.transcribe(self.home / "missing.ogg")["success"])
        runner.assert_not_called()
        self.credentials.assert_not_called()

    def test_native_dispatch_failure_never_uses_another_provider(self):
        from agent.transcription_registry import get_provider
        from tools import transcription_tools
        provider, runner = self.provider(code=1, error="HTTP 429: retry later")
        native = get_provider("nocheh-subscription")
        native._credentials, native._runner = self.credentials, runner
        with patch.object(transcription_tools, "_transcribe_local") as local, \
                patch.object(transcription_tools, "_transcribe_openai") as paid:
            result = transcription_tools.transcribe_audio(str(self.audio))
        self.assertEqual(result["error"], "quota_paused")
        self.assertEqual(result["provider"], "nocheh-subscription")
        local.assert_not_called()
        paid.assert_not_called()
        runner.assert_called_once()

    def test_native_dispatch_success_uses_plugin(self):
        from agent.transcription_registry import get_provider
        from tools.transcription_tools import transcribe_audio
        provider, runner = self.provider(output={"text": "Friday\n"})
        native = get_provider("nocheh-subscription")
        native._credentials, native._runner = self.credentials, runner
        self.assertEqual(transcribe_audio(str(self.audio))["transcript"], "Friday\n")
        runner.assert_called_once()

    def test_native_plugin_discovery_registers_the_provider(self):
        from agent.transcription_registry import get_provider
        provider = get_provider("nocheh-subscription")
        self.assertIsNotNone(provider)
        self.assertEqual(provider.name, "nocheh-subscription")

    def test_partial_live_probe_cannot_pass_the_phase_gate(self):
        report = {"checks": {name: {"status": "passed"} for name in ("chat", "detector", "transcription")}}
        self.assertEqual(report_exit_code(report), 2)
        self.assertFalse(report["phase1_live_ready"])
        report["checks"]["native_credential_refresh_live"] = {"status": "passed"}
        report["checks"]["vps_verification"] = {"status": "pending"}
        self.assertEqual(report_exit_code(report), 2)
        report["checks"]["vps_verification"] = {"status": "passed"}
        self.assertEqual(report_exit_code(report), 0)

    def test_fixture_has_actual_opus_frames(self):
        self.assertGreater(validate_audio(self.audio)["duration_seconds"], 7)

    def test_speech_process_does_not_inherit_paid_credentials_or_proxies(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "paid", "HTTPS_PROXY": "redirect", "OTHER_SECRET": "private"}):
            env = process_environment("subscription")
        self.assertEqual(env["CODEX_ASR_BEARER"], "subscription")
        self.assertFalse({"OPENAI_API_KEY", "HTTPS_PROXY", "OTHER_SECRET"} & env.keys())

    def test_subscription_endpoint_cannot_be_redirected(self):
        with self.assertRaises(ValueError):
            SubscriptionCredentials("token", "https://untrusted.example/codex")
        self.assertNotIn("synthetic-token", repr(self.credentials()))

    def test_detector_rejects_rewrites_and_invalid_contracts(self):
        text = "Aws pass: abC123 سلام"
        for output in ({"literals": ["ABC123"]}, {"literals": [""]}, {"literals": [3]},
                       {"literals": "abC123"}, {"literals": [], "rewritten": text}, []):
            with self.subTest(output=output), patch("integrations.hermes.subscription._call_subscription", return_value=self.response(output)):
                with self.assertRaises(ValueError):
                    detect_literals(text, self.credentials(), "test-model")

    def test_detector_accepts_only_verbatim_candidates(self):
        with patch("integrations.hermes.subscription._call_subscription", return_value=self.response({"literals": ["abC123"]})) as call:
            self.assertEqual(detect_literals("Aws pass: abC123", self.credentials(), "test-model"), ["abC123"])
        self.assertEqual(call.call_args.args[1], "test-model")

    @staticmethod
    def response(output):
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(output)))])

    def test_native_refresh_persists_rotation_before_next_resolution(self):
        import httpx
        from hermes_cli.auth_codex import _save_codex_tokens, resolve_codex_runtime_credentials
        payload = base64.urlsafe_b64encode(json.dumps({"exp": time.time() + 3600}).encode()).decode().rstrip("=")
        next_token = "h." + payload + ".s"
        _save_codex_tokens({"access_token": "old", "refresh_token": "refresh-old"})
        response = httpx.Response(200, json={"access_token": next_token, "refresh_token": "refresh-new"})
        with patch("hermes_cli.auth_codex._codex_http_client") as factory:
            client = factory.return_value.__enter__.return_value
            client.post.return_value = response
            resolved = resolve_codex_runtime_credentials(force_refresh=True)
            again = resolve_codex_runtime_credentials()
        self.assertEqual(resolved["api_key"], next_token)
        self.assertEqual(again["api_key"], next_token)
        client.post.assert_called_once()
        stored = json.loads((self.home / "auth.json").read_text())
        self.assertEqual(stored["providers"]["openai-codex"]["tokens"]["refresh_token"], "refresh-new")

    def test_native_device_login_envelope_is_saved_as_readable_credentials(self):
        from compatibility.login import save_login_result
        from hermes_cli.auth_codex import _read_codex_tokens
        save_login_result({
            "tokens": {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh"},
            "base_url": "https://chatgpt.com/backend-api/codex", "auth_mode": "chatgpt",
            "last_refresh": "2026-09-06T00:00:00Z", "source": "device-code",
        })
        stored = _read_codex_tokens()
        self.assertEqual(stored["tokens"]["access_token"], "synthetic-access")
        self.assertEqual(stored["tokens"]["refresh_token"], "synthetic-refresh")
        self.assertEqual(stored["last_refresh"], "2026-09-06T00:00:00Z")

    def test_incomplete_device_login_cannot_overwrite_credentials(self):
        from compatibility.login import save_login_result
        from hermes_cli.auth_codex import _save_codex_tokens
        _save_codex_tokens({"access_token": "existing", "refresh_token": "existing-refresh"})
        before = (self.home / "auth.json").read_bytes()
        with self.assertRaises(ValueError):
            save_login_result({"auth_mode": "chatgpt", "tokens": {"access_token": "incomplete"}})
        self.assertEqual((self.home / "auth.json").read_bytes(), before)

    def test_native_refresh_quota_retains_credentials_and_requests_pause(self):
        import httpx
        from hermes_cli.auth import AuthError
        from hermes_cli.auth_codex import _save_codex_tokens, resolve_codex_runtime_credentials
        _save_codex_tokens({"access_token": "old", "refresh_token": "refresh-old"})
        before = (self.home / "auth.json").read_bytes()
        with patch("hermes_cli.auth_codex._codex_http_client") as factory:
            factory.return_value.__enter__.return_value.post.return_value = httpx.Response(
                429, json={"error": "quota"}, headers={"Retry-After": "60"})
            with self.assertRaises(AuthError) as raised:
                resolve_codex_runtime_credentials(force_refresh=True)
        self.assertFalse(raised.exception.relogin_required)
        self.assertEqual((self.home / "auth.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
