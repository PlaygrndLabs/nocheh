# The full tester's browser: Chromium and the repository's pinned playwright-core,
# used only to open a fixture's dashboard. No credentials or state. The page
# checker is mounted at run time, so the image changes only with its pins.
FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /tester
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --save-exact playwright-core@1.64.1
USER 1000:1000
ENTRYPOINT ["node"]
