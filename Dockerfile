FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS development
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json ./
COPY scripts ./scripts
COPY compatibility/upstreams.lock.json ./compatibility/upstreams.lock.json
COPY integrations/hermes/dashboard ./integrations/hermes/dashboard
COPY web ./web
COPY src ./src
COPY test ./test
RUN npm run build && chown -R ${LOCAL_UID}:${LOCAL_GID} /app
USER node
CMD ["npm", "run", "dev"]

FROM development AS build
USER root
RUN npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "dist/src/main.js"]

# The database service already holds the installation administrator credential.
# Run store provisioning there before declaring PostgreSQL healthy, so application
# processes retain only their restricted per-store credentials.
FROM postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0 AS store-postgres
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
FROM runtime AS management
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY scripts ./scripts
COPY integrations ./integrations
COPY experiments ./experiments
COPY compatibility ./compatibility
COPY deploy ./deploy
COPY --from=development /app/web/dist ./web/dist
ENV PYTHONDONTWRITEBYTECODE=1 NOCHEH_CONTAINER=1 HOME=/tmp
ENTRYPOINT ["python3", "-m", "scripts.container_service"]
