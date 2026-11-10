# The full tester's browser: Playwright's own Chromium build and the matching
# playwright-core, used only to open a fixture's dashboard. No credentials or
# state. Debian's Chromium crashed its network service on Docker Desktop's arm64
# VM ("FD ownership violation"); Playwright's image ships builds for both
# architectures. The page checker is mounted at run time.
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d
WORKDIR /tester
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --save-exact playwright-core@1.65.0
USER pwuser
ENTRYPOINT ["node"]
