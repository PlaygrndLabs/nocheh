FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS web-build
ARG VERSION=1ae656c
ARG CPAMP_REVISION=1ae656c82990c480f3f104326a08c6e0001eeb4c
WORKDIR /app
COPY .nocheh-source-revision ./
RUN test "$(cat .nocheh-source-revision)" = "$CPAMP_REVISION"
COPY package*.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
COPY --from=nocheh_source scripts/patch-cpamp.mjs /tmp/patch-cpamp.mjs
RUN node /tmp/patch-cpamp.mjs /app
WORKDIR /app/apps/web
RUN VERSION=$VERSION npm run build

FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS service-build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY apps/manager-server ./apps/manager-server
COPY --from=web-build /app/apps/web/dist/index.html ./apps/manager-server/internal/httpapi/web/management.html
WORKDIR /src/apps/manager-server
RUN go mod download
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -o /out/cpa-manager-plus ./cmd/cpa-manager-plus

FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
ARG CPAMP_REVISION=1ae656c82990c480f3f104326a08c6e0001eeb4c
RUN apk add --no-cache ca-certificates wget tzdata
WORKDIR /app
COPY --from=service-build /out/cpa-manager-plus /usr/local/bin/cpa-manager-plus
ENV HTTP_ADDR=0.0.0.0:18317 USAGE_DATA_DIR=/data USAGE_DB_PATH=/data/usage.sqlite
LABEL org.opencontainers.image.revision=${CPAMP_REVISION}
EXPOSE 18317
ENTRYPOINT ["cpa-manager-plus"]
