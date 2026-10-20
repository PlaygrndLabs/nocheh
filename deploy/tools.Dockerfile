FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
RUN apt-get update && apt-get install -y --no-install-recommends python3 chromium ca-certificates && rm -rf /var/lib/apt/lists/*
COPY tools/runtime/sandbox.py /opt/nocheh/sandbox.py
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/nocheh/sandbox.py"]
