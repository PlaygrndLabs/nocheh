FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS development
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.dashboard.json ./
COPY SPECS.md ./SPECS.md
COPY tools ./tools
COPY deploy/upstreams.lock.json ./deploy/upstreams.lock.json
COPY dashboard ./dashboard
COPY src ./src
COPY test ./test
RUN npm run build && chown ${LOCAL_UID}:${LOCAL_GID} /app /app/dashboard && chown -R ${LOCAL_UID}:${LOCAL_GID} /app/dist /app/dashboard/dist
USER node
CMD ["npm", "run", "dev"]

FROM development AS build
USER root
RUN npm prune --omit=dev

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "dist/src/main.js"]

# The database service already holds the installation administrator credential.
# Run store provisioning there before declaring PostgreSQL healthy, so application
# processes retain only their restricted per-store credentials.
FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826 AS store-postgres
WORKDIR /app
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /app/node_modules ./node_modules
COPY --from=runtime /app/dist ./dist
COPY deploy/store-postgres-entrypoint.sh /usr/local/bin/store-postgres-entrypoint
RUN chmod 0755 /usr/local/bin/store-postgres-entrypoint
ENTRYPOINT ["store-postgres-entrypoint"]
CMD ["postgres"]

FROM docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli

# Trusted installation administration; agent images never inherit this target.
# Install management tools before copying application output so source edits do
# not repeat apt-get on every watched dashboard rebuild.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS management-base
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

FROM management-base AS management
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY tools ./tools
COPY services ./services
COPY deploy ./deploy
COPY --from=development /app/dashboard/dist ./dashboard/dist
ENV PYTHONDONTWRITEBYTECODE=1 NOCHEH_CONTAINER=1 HOME=/tmp
ENTRYPOINT ["python3", "-m", "tools.runtime.container_service"]
