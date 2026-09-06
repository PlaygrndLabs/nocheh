"""Fetch exact public upstream revisions and their locked dependencies. No login."""

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "compatibility/upstreams.lock.json").read_text())
WORK = ROOT / "data/compat"


def run(*args, cwd=None, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def checkout(name, spec):
    destination = WORK / "upstreams" / name
    if not destination.exists():
        destination.mkdir(parents=True)
        run("git", "init", str(destination))
        run("git", "remote", "add", "origin", spec["repository"], cwd=destination)
        run("git", "fetch", "--depth", "1", "origin", spec["revision"], cwd=destination)
        run("git", "checkout", "--detach", spec["revision"], cwd=destination)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=destination, text=True).strip()
    if actual != spec["revision"]:
        raise SystemExit(f"{name}: existing checkout differs from lock; use a separate clean workspace")
    run("git", "diff", "--exit-code", "HEAD", cwd=destination)
    if (destination / ".env").exists():
        raise SystemExit(f"{name}: compatibility checkout must not contain .env")
    return destination


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-image", action="store_true", help="Prepare offline contract tests only")
    args = parser.parse_args()
    required = ["git", "uv", "ffprobe"] + ([] if args.skip_image else ["docker"])
    for binary in required:
        if not shutil.which(binary):
            parser.error(f"Install {binary} first")
    hermes = checkout("hermes-agent", LOCK["hermes"])
    checkout("codex-asr", LOCK["codex_asr"])
    env = dict(os.environ, UV_CACHE_DIR=str(WORK / "uv-cache"),
               UV_PROJECT_ENVIRONMENT=str(WORK / "hermes-venv"))
    run("uv", "sync", "--project", str(hermes), "--python", LOCK["python"],
        "--frozen", "--no-dev", "--no-install-project", env=env)
    if not args.skip_image:
        run("docker", "pull", LOCK["codex_asr"]["image"])
    print("Compatibility dependencies ready; no live model checks have run.")


if __name__ == "__main__":
    main()
