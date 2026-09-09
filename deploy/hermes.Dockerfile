FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS asr-builder
ARG CODEX_ASR_REVISION=479f6a7a3db81fe2a23d4755b0ccbeb4400317d4
ARG RUST_SILK_VERSION=0.1.3
RUN git init /src && cd /src && git remote add origin https://github.com/Wangnov/codex-asr.git && \
    git fetch --depth 1 origin "$CODEX_ASR_REVISION" && git checkout --detach FETCH_HEAD && \
    cargo build --release --locked --bin codex-asr && cp target/release/codex-asr /usr/local/bin/ && \
    cargo install rust-silk --version "$RUST_SILK_VERSION" --locked --root /usr/local

FROM debian:bookworm@sha256:6ebd97fa83deb272194a2cf015b3d26a4d538e9ad3a7a79d544c8af5b0a01443 AS asr
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && \
    useradd --system --uid 10001 --gid nogroup --home-dir /nonexistent --shell /usr/sbin/nologin codex-asr
COPY --from=asr-builder /usr/local/bin/codex-asr /usr/local/bin/rust-silk /usr/local/bin/
ENV CODEX_ASR_SILK_DECODER=/usr/local/bin/rust-silk
USER 10001:65534
ENTRYPOINT ["codex-asr"]

FROM ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 AS uv
FROM python:3.11.16-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84 AS sqlite
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Match the pinned upstream's SQLite WAL-corruption fix.
RUN curl -fSL --retry 3 https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp && cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_RTREE -DSQLITE_THREADSAFE=1' \
    ./configure --prefix=/opt/sqlite --disable-static && make -j2 && make install

FROM python:3.11.16-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84 AS native-runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=asr /usr/local/bin/codex-asr /usr/local/bin/rust-silk /usr/local/bin/
COPY --from=sqlite /opt/sqlite/lib /opt/sqlite/lib
ENV LD_LIBRARY_PATH=/opt/sqlite/lib PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never \
    PYTHONPATH=/opt/hermes:/workspace PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    HERMES_HOME=/workspace/data/local/hermes CODEX_ASR_SILK_DECODER=/usr/local/bin/rust-silk
ARG HERMES_REVISION=7166071fcaadb36df26f6d753dda97da6b5d699e
COPY --from=hermes_source . /opt/hermes
RUN test "$(cat /opt/hermes/.nocheh-source-revision)" = "$HERMES_REVISION" && cd /opt/hermes && \
    uv sync --frozen --no-dev --no-install-project --extra messaging --python /usr/local/bin/python && \
    rm -rf /opt/hermes/.git /opt/hermes/.nocheh-source-revision /root/.cache/uv
LABEL org.opencontainers.image.revision=${HERMES_REVISION}
RUN python -c "import sqlite3; assert sqlite3.sqlite_version_info >= (3,51,3)"
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
RUN /usr/sbin/useradd --uid ${LOCAL_UID} --create-home nocheh && mkdir -p /workspace /reports && chown ${LOCAL_UID}:${LOCAL_GID} /workspace /reports
WORKDIR /workspace
COPY --chown=${LOCAL_UID}:${LOCAL_GID} integrations ./integrations
COPY --chown=${LOCAL_UID}:${LOCAL_GID} compatibility/fixtures ./compatibility/fixtures
COPY --chown=${LOCAL_UID}:${LOCAL_GID} compatibility/upstreams.lock.json ./compatibility/upstreams.lock.json
COPY --chown=${LOCAL_UID}:${LOCAL_GID} scripts ./scripts
USER nocheh
CMD ["python", "-m", "integrations.hermes.runtime"]


FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS tui-assets
WORKDIR /opt/hermes
COPY --from=native-runtime /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=native-runtime /opt/hermes/ui-tui ./ui-tui
COPY --from=native-runtime /opt/hermes/apps/shared ./apps/shared
COPY --from=native-runtime /opt/hermes/web/package.json ./web/package.json
COPY scripts/patch-native-tui.py /tmp/patch-native-tui.py
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && python3 /tmp/patch-native-tui.py /opt/hermes
RUN npm ci --workspace ui-tui --workspace apps/shared --ignore-scripts --no-audit --no-fund && npm run build --workspace ui-tui

FROM native-runtime
COPY --from=tui-assets /usr/local/bin/node /usr/local/bin/node
COPY --from=tui-assets /opt/hermes/ui-tui/dist /opt/hermes/ui-tui/dist
CMD ["python", "-m", "integrations.hermes.runtime"]
