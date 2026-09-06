"""Live synthetic acceptance against the running container service."""
import argparse
import base64
import json
import os
import platform
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--output", default="/reports/container-compatibility.json")
    args = parser.parse_args()
    if not args.live:
        parser.error("--live is required to use subscription quota")
    token = Path(os.environ["SERVICE_TOKEN_FILE"]).read_text().strip()
    def call(path, body):
        request = urllib.request.Request("http://127.0.0.1:8781" + path,
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    checks = {}
    cases = {
        "refresh": lambda: call("/internal/refresh", {})["refreshed"] is True,
        "chat": lambda: call("/internal/chat", {"text": "Reply exactly NOCHEH_COMPAT_OK with no other text."})["text"].strip() == "NOCHEH_COMPAT_OK",
        "detector": lambda: call("/internal/detect", {"text": "Aws password: juniper-ONLY-7642. Friday is the deadline."})["literals"] == ["juniper-ONLY-7642"],
        "transcription": lambda: "friday" in call("/internal/transcribe", {"audio_base64": base64.b64encode(Path("/workspace/compatibility/fixtures/subscription-speech.ogg").read_bytes()).decode()})["transcript"].lower(),
    }
    for name, fn in cases.items():
        start = time.monotonic()
        try:
            checks[name] = {"status": "passed" if fn() else "failed"}
        except Exception as error:
            checks[name] = {"status": "failed", "error_type": type(error).__name__}
        checks[name]["duration_ms"] = round(1000 * (time.monotonic() - start))
        print(json.dumps({"check": name, **checks[name]}), flush=True)
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "environment": "local-compose",
              "os": platform.system(), "machine": platform.machine(), "synthetic_inputs_only": True, "checks": checks}
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
    return 0 if all(c["status"] == "passed" for c in checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
