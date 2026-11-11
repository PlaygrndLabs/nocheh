FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS development
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

FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "dist/src/main.js"]

# The Telegram mini app: its server and the built pages, nothing else.
FROM runtime AS mini-app
COPY --from=development --chown=node:node /app/dashboard/dist ./dashboard/dist
CMD ["node", "dist/src/mini-app.js"]

# The database service already holds the installation administrator credential.
# Run store provisioning there before declaring PostgreSQL healthy, so application
# processes retain only their restricted per-store credentials.
FROM postgres:18.6-trixie@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6 AS store-postgres
# Node 26 links libatomic, which the PostgreSQL image does not ship.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
RUN node --version
COPY --from=runtime /app/node_modules ./node_modules
COPY --from=runtime /app/dist ./dist
COPY deploy/store-postgres-entrypoint.sh /usr/local/bin/store-postgres-entrypoint
RUN chmod 0755 /usr/local/bin/store-postgres-entrypoint
# The 18+ images default to /var/lib/postgresql/18/docker; Nocheh's volume mounts the data directory itself.
ENV PGDATA=/var/lib/postgresql/data
ENTRYPOINT ["store-postgres-entrypoint"]
CMD ["postgres"]

FROM docker:29.9.3-cli@sha256:2357639ad1ea7d0194134bf3292622fd4e562483966ed674e5d7c945b5f3b28d AS docker-cli

# Trusted installation administration; agent images never inherit this target.
# Install management tools before copying application output so source edits do
# not repeat apt-get on every watched dashboard rebuild.
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS management-base
# python3-cryptography signs the GitHub app's requests for short repo keys (ADR-0210).
# openssh-client lets nocheh-machines make machine keys and run approved commands on the owner's machines.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml python3-cryptography git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
# Compose runs management as NOCHEH_UID, and ssh refuses a uid without a passwd entry ("No user exists for uid").
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
RUN (getent group ${LOCAL_GID} >/dev/null || groupadd --gid ${LOCAL_GID} nocheh) && \
    (getent passwd ${LOCAL_UID} >/dev/null || useradd --no-log-init --uid ${LOCAL_UID} --gid ${LOCAL_GID} --no-create-home --home-dir /tmp --shell /usr/sbin/nologin nocheh)

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
