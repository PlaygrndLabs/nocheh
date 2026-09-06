FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS development
WORKDIR /app
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
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
