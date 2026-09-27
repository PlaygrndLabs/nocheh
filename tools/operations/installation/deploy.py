"""Deploy the app service in an existing local or VPS Compose installation."""

import argparse
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

from tools.operations.installation.configuration import DEFAULT_STATE, ROOT, compose_command, compose_environment, env_path


def run(command, *, cwd=ROOT, env=None, capture=False):
    return subprocess.run(command, cwd=cwd, env=env, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def revision(value):
    if not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("--revision must be a full 40-character commit ID")
    return value


def checkout(rev):
    head = run(["git", "rev-parse", "HEAD"], capture=True).stdout.strip()
    if head != rev:
        raise ValueError("checkout HEAD differs from --revision")
    if run(["git", "status", "--porcelain"], capture=True).stdout.strip():
        raise ValueError("checkout contains uncommitted or untracked files")
    if not env_path(DEFAULT_STATE).is_file():
        raise ValueError("installation .env is missing")


def local(rev, apply):
    checkout(rev)
    env = compose_environment(DEFAULT_STATE)
    command = compose_command(DEFAULT_STATE)
    ids = run(command + ["ps", "-q", "nocheh-app"], env=env, capture=True).stdout.split()
    if len(ids) != 1:
        raise ValueError("expected exactly one running app in this installation")
    owner = run(["docker", "inspect", "--format", "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}", ids[0]],
                capture=True).stdout.strip()
    if Path(owner).resolve() != ROOT:
        raise ValueError("running app belongs to another checkout")
    print(json.dumps({"target": "local", "revision": rev, "service": "nocheh-app", "installation": str(ROOT), "apply": apply}))
    if not apply:
        return 0
    run(command + ["build", "nocheh-app"], env=env)
    run(command + ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "nocheh-app"], env=env)
    print("App service is healthy. Run live acceptance separately.")
    return 0


def remote(rev, host, root, apply):
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", host):
        raise ValueError("--host must be an SSH host or user@host without options")
    if not root.startswith("/") or any(char in root for char in "\r\n\0"):
        raise ValueError("--root must be an absolute VPS checkout path")
    script = " && ".join((
        "cd " + shlex.quote(root),
        "test -z \"$(git status --porcelain)\"",
        "test \"$(git branch --show-current)\" = main",
        "git fetch origin main",
        "git merge-base --is-ancestor " + shlex.quote(rev) + " origin/main",
        "git merge --ff-only " + shlex.quote(rev),
        "test \"$(git rev-parse HEAD)\" = " + shlex.quote(rev),
        "./bin/nocheh deploy local --apply --revision " + shlex.quote(rev),
    ))
    print(json.dumps({"target": "vps", "revision": rev, "host": host, "root": root, "apply": apply}))
    if not apply:
        return 0
    run(["ssh", "-o", "BatchMode=yes", "--", host, shlex.join(["bash", "-lc", script])])
    return 0


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="target", required=True)
    for target in ("local", "vps"):
        command = commands.add_parser(target)
        command.add_argument("--revision", required=True, help="Exact integrated commit ID")
        command.add_argument("--apply", action="store_true", help="Execute the rollout; otherwise show the plan")
        if target == "vps":
            command.add_argument("--host", required=True, help="SSH host or user@host")
            command.add_argument("--root", required=True, help="Absolute existing installation checkout")
    args = parser.parse_args(arguments)
    try:
        rev = revision(args.revision)
        return local(rev, args.apply) if args.target == "local" else remote(rev, args.host, args.root, args.apply)
    except (ValueError, subprocess.CalledProcessError, OSError) as error:
        detail = str(error) if not isinstance(error, subprocess.CalledProcessError) else f"command failed (exit {error.returncode})"
        print("deploy: " + detail, file=sys.stderr)
        return 1
