"""Fetch exact public upstream revisions and their locked dependencies. No login."""

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(os.environ.get('NOCHEH_INSTALLATION_ROOT', Path(__file__).resolve().parents[3])).resolve()
LOCK = json.loads((ROOT / "deploy/upstreams.lock.json").read_text())
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
    if (destination/".git").is_dir():
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=destination, text=True).strip()
        if actual != spec["revision"]:
            # A new pin moves an untouched checkout; local edits are never discarded.
            if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=destination, text=True).strip():
                raise SystemExit(f"{name}: existing checkout has local changes and differs from lock; use a separate clean workspace")
            run("git", "fetch", "--depth", "1", "origin", spec["revision"], cwd=destination)
            run("git", "checkout", "--detach", spec["revision"], cwd=destination)
        run("git", "diff", "--exit-code", "HEAD", cwd=destination)
    elif (not (destination/".nocheh-source-revision").is_file()
          or (destination/".nocheh-source-revision").read_text().strip() != spec["revision"]):
        raise SystemExit(f"{name}: cached source revision is unavailable")
    (destination/".nocheh-source-revision").write_text(spec["revision"]+'\n')
    if (destination / ".env").exists():
        raise SystemExit(f"{name}: compatibility checkout must not contain .env")
    return destination


def main():
    parser = argparse.ArgumentParser()
    parser.parse_args()
    for binary in ("git", "uv"):
        if not shutil.which(binary):
            parser.error(f"Install {binary} first")
    hermes = checkout("hermes-agent", LOCK["hermes"])
    env = dict(os.environ, UV_CACHE_DIR=str(WORK / "uv-cache"),
               UV_PROJECT_ENVIRONMENT=str(WORK / "hermes-venv"))
    run("uv", "sync", "--project", str(hermes), "--python", LOCK["python"],
        "--frozen", "--no-dev", "--no-install-project", env=env)
    print("Compatibility dependencies ready; no live model checks have run.")


if __name__ == "__main__":
    main()
