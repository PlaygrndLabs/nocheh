FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends python3 chromium ca-certificates && rm -rf /var/lib/apt/lists/*
COPY tools/runtime/sandbox.py /opt/nocheh/sandbox.py
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/nocheh/sandbox.py"]
