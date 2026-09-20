FROM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS builder

ARG GOPROXY=https://proxy.golang.org|https://goproxy.io|direct
ENV GOPROXY=${GOPROXY}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git && rm -rf /var/lib/apt/lists/*
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Upstream refreshes and replays a 401 inside one client request. Nocheh needs
# the 401 returned so any later attempt enters the mandatory guard again.
RUN sed -i 's/; okRefresh {/; false \&\& okRefresh {/' sdk/cliproxy/auth/conductor_execution.go && \
    test "$(grep -c 'false && okRefresh' sdk/cliproxy/auth/conductor_execution.go)" = 2
ARG VERSION=dev
ARG COMMIT=c76dfd4e0edabab9000628b1560ab8ab379eadb8
ARG BUILD_DATE=unknown
RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false -ldflags="-s -w -X 'main.Version=${VERSION}' -X 'main.Commit=${COMMIT}' -X 'main.BuildDate=${BUILD_DATE}'" -o ./CLIProxyAPI ./cmd/server/

FROM debian:bookworm@sha256:6ebd97fa83deb272194a2cf015b3d26a4d538e9ad3a7a79d544c8af5b0a01443
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /CLIProxyAPI
COPY --from=builder /app/CLIProxyAPI ./CLIProxyAPI
ARG COMMIT=c76dfd4e0edabab9000628b1560ab8ab379eadb8
LABEL org.opencontainers.image.revision=${COMMIT}
EXPOSE 8317
CMD ["./CLIProxyAPI", "-config", "/state/config.yaml"]
