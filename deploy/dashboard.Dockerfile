FROM nocheh-hermes:local AS hermes
FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS assets
WORKDIR /opt/hermes
COPY --from=hermes /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=hermes /opt/hermes/web ./web
COPY --from=hermes /opt/hermes/apps/shared ./apps/shared
RUN npm ci --workspace web --workspace apps/shared --ignore-scripts --no-audit --no-fund && npm run build --workspace web
WORKDIR /opt/nocheh
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/build-dashboard.mjs ./scripts/build-dashboard.mjs
COPY integrations/hermes/dashboard ./integrations/hermes/dashboard
RUN npm run build:dashboard
FROM hermes
COPY --from=assets /opt/hermes/hermes_cli/web_dist /opt/hermes/hermes_cli/web_dist
COPY integrations/hermes/dashboard_server.py /workspace/integrations/hermes/dashboard_server.py
COPY integrations/hermes/dashboard /workspace/integrations/hermes/dashboard
COPY --from=assets /opt/nocheh/integrations/hermes/dashboard/dist /workspace/integrations/hermes/dashboard/dist
CMD ["python", "-m", "integrations.hermes.dashboard_server"]
