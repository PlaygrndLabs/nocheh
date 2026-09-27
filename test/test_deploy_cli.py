import contextlib
import io
import unittest
from unittest.mock import patch

from tools.operations.installation import deploy


REV = "a" * 40


class DeployCliTests(unittest.TestCase):
    def test_local_plan_checks_revision_checkout_and_container_owner(self):
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            if command[:3] == ["git", "rev-parse", "HEAD"]:
                return type("Result", (), {"stdout": REV + "\n"})()
            if command[:3] == ["git", "status", "--porcelain"]:
                return type("Result", (), {"stdout": ""})()
            if command[-3:] == ["ps", "-q", "nocheh-app"]:
                return type("Result", (), {"stdout": "container-id\n"})()
            return type("Result", (), {"stdout": str(deploy.ROOT) + "\n"})()

        with patch.object(deploy, "run", side_effect=fake_run), patch.object(deploy, "env_path") as path, patch.object(deploy, "compose_environment", return_value={}), patch.object(deploy, "compose_command", return_value=["docker", "compose"]), contextlib.redirect_stdout(io.StringIO()):
            path.return_value.is_file.return_value = True
            self.assertEqual(deploy.main(["local", "--revision", REV]), 0)
        self.assertFalse(any("build" in command or "up" in command for command in calls))

    def test_vps_plan_never_contacts_host(self):
        with patch.object(deploy, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.main(["vps", "--host", "owner@example.org", "--root", "/srv/nocheh", "--revision", REV]), 0)
        run.assert_not_called()

    def test_local_rejects_foreign_app_before_build(self):
        calls = []

        def fake_run(command, **kwargs):
            calls.append(command)
            if command[:3] == ["git", "rev-parse", "HEAD"]:
                return type("Result", (), {"stdout": REV})()
            if command[:3] == ["git", "status", "--porcelain"]:
                return type("Result", (), {"stdout": ""})()
            if command[-3:] == ["ps", "-q", "nocheh-app"]:
                return type("Result", (), {"stdout": "container-id"})()
            return type("Result", (), {"stdout": "/another/checkout"})()

        with patch.object(deploy, "run", side_effect=fake_run), patch.object(deploy, "env_path") as path, patch.object(deploy, "compose_environment", return_value={}), patch.object(deploy, "compose_command", return_value=["docker", "compose"]), contextlib.redirect_stderr(io.StringIO()):
            path.return_value.is_file.return_value = True
            self.assertEqual(deploy.main(["local", "--revision", REV, "--apply"]), 1)
        self.assertFalse(any("build" in command or "up" in command for command in calls))

    def test_vps_rejects_ssh_option_injection(self):
        with patch.object(deploy, "run") as run, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(deploy.main(["vps", "--host=-oProxyCommand=sh", "--root", "/srv/nocheh", "--revision", REV, "--apply"]), 1)
        run.assert_not_called()

    def test_vps_apply_pins_remote_git_and_invokes_local_rollout(self):
        with patch.object(deploy, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.main(["vps", "--host", "owner@example.org", "--root", "/srv/nocheh", "--revision", REV, "--apply"]), 0)
        command = run.call_args.args[0]
        self.assertIn("BatchMode=yes", command)
        self.assertIn("merge-base --is-ancestor", command[-1])
        self.assertIn("deploy local --apply --revision", command[-1])
