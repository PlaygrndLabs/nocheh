FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
RUN apt-get update && apt-get install -y --no-install-recommends python3 chromium ca-certificates && rm -rf /var/lib/apt/lists/*
COPY tools/runtime/sandbox.py /opt/nocheh/sandbox.py
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/nocheh/sandbox.py"]
