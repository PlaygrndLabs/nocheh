FROM node:22-bookworm AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-bookworm AS web-build

WORKDIR /app/web
COPY web/package.json ./
RUN npm install
COPY web ./
RUN npm run build

FROM node:22-bookworm AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web/dist
EXPOSE 3000
CMD ["node", "dist/src/dev-server.js"]
