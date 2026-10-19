FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS development
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

FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "dist/src/main.js"]

# The database service already holds the installation administrator credential.
# Run store provisioning there before declaring PostgreSQL healthy, so application
# processes retain only their restricted per-store credentials.
FROM postgres:18.6-trixie@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336 AS store-postgres
WORKDIR /app
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /app/node_modules ./node_modules
COPY --from=runtime /app/dist ./dist
COPY deploy/store-postgres-entrypoint.sh /usr/local/bin/store-postgres-entrypoint
RUN chmod 0755 /usr/local/bin/store-postgres-entrypoint
# The 18+ images default to /var/lib/postgresql/18/docker; Nocheh's volume mounts the data directory itself.
ENV PGDATA=/var/lib/postgresql/data
ENTRYPOINT ["store-postgres-entrypoint"]
CMD ["postgres"]

FROM docker:29.9.1-cli@sha256:6fae2214c3121a28d5aa639d09032f61310b7c9c75ffbad1025f261a1b621800 AS docker-cli

# Trusted installation administration; agent images never inherit this target.
# Install management tools before copying application output so source edits do
# not repeat apt-get on every watched dashboard rebuild.
FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS management-base
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
