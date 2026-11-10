FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
RUN apt-get update && apt-get install -y --no-install-recommends python3 chromium ca-certificates && rm -rf /var/lib/apt/lists/*
COPY tools/runtime/sandbox.py /opt/nocheh/sandbox.py
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/nocheh/sandbox.py"]
