# The full tester's browser: Playwright's own Chromium build and the matching
# playwright-core, used only to open a fixture's dashboard. No credentials or
# state. Debian's Chromium crashed its network service on Docker Desktop's arm64
# VM ("FD ownership violation"); Playwright's image ships builds for both
# architectures. The page checker is mounted at run time.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /tester
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --save-exact playwright-core@1.64.1
USER pwuser
ENTRYPOINT ["node"]
