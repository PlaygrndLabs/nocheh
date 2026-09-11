FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
RUN apt-get update && apt-get install -y --no-install-recommends python3 chromium ca-certificates && rm -rf /var/lib/apt/lists/*
COPY integrations/tools/sandbox.py /opt/nocheh/sandbox.py
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/nocheh/sandbox.py"]
