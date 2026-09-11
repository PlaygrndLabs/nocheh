ARG HERMES_IMAGE=nocheh-hermes:local
FROM ${HERMES_IMAGE} AS hermes
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS assets
WORKDIR /opt/hermes
COPY --from=hermes /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=hermes /opt/hermes/web ./web
COPY --from=hermes /opt/hermes/apps/shared ./apps/shared
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN npm ci --workspace web --workspace apps/shared --ignore-scripts --no-audit --no-fund
WORKDIR /opt/nocheh
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/patch-native-dashboard.py /tmp/patch-native-dashboard.py
RUN python3 /tmp/patch-native-dashboard.py /opt/hermes && cd /opt/hermes && npm run build --workspace web -- --base=/hermes/
COPY scripts/build-dashboard.mjs ./scripts/build-dashboard.mjs
COPY integrations/hermes/dashboard ./integrations/hermes/dashboard
COPY web ./web
RUN npm run build:dashboard
FROM hermes
COPY --from=assets /opt/hermes/hermes_cli/web_dist /opt/hermes/hermes_cli/web_dist
COPY integrations/hermes/dashboard_server.py /workspace/integrations/hermes/dashboard_server.py
COPY integrations/hermes/dashboard /workspace/integrations/hermes/dashboard
COPY --from=assets /opt/nocheh/integrations/hermes/dashboard/dist /workspace/integrations/hermes/dashboard/dist
CMD ["python", "-m", "integrations.hermes.dashboard_server"]
