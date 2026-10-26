FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv
FROM python:3.14.9-slim-trixie@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8 AS sqlite
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Match the pinned upstream's SQLite WAL-corruption fix.
RUN curl -fSL --retry 3 https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp && cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_RTREE -DSQLITE_THREADSAFE=1' \
    ./configure --prefix=/opt/sqlite --disable-static && make -j2 && make install

FROM python:3.14.9-slim-trixie@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8 AS native-runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=sqlite /opt/sqlite/lib /opt/sqlite/lib
ENV LD_LIBRARY_PATH=/opt/sqlite/lib PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never \
    PYTHONPATH=/opt/hermes:/workspace PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    HERMES_HOME=/workspace/data/local/hermes
ARG HERMES_REVISION=d923a5eb487a17c0a68801bba9ef0f56c81040a8
ARG HERMES_VERSION=0.22.2
COPY --from=hermes_source . /opt/hermes
COPY deploy/hermes-plugin-requirements.txt /tmp/hermes-plugin-requirements.txt
# The pinned upstream supports only Python 3.14; keep the interpreter explicit
# because newer uv releases default to a later Python. The upstream stamp
# writer records the pinned release, so native version surfaces report it and
# treat updates as externally managed.
RUN test "$(cat /opt/hermes/.nocheh-source-revision)" = "$HERMES_REVISION" && cd /opt/hermes && \
    uv sync --frozen --no-dev --no-install-project --extra messaging --python /usr/local/bin/python && \
    uv pip install --python /opt/venv/bin/python --require-hashes --no-deps -r /tmp/hermes-plugin-requirements.txt && \
    python scripts/write_install_stamp.py --output /opt/hermes/install-stamp.json --commit "$HERMES_REVISION" \
      --base-version "$HERMES_VERSION" --distance 0 --source docker --distribution docker --update-mechanism external && \
    rm -rf /opt/hermes/.git /opt/hermes/.nocheh-source-revision /root/.cache/uv /tmp/hermes-plugin-requirements.txt
LABEL org.opencontainers.image.revision=${HERMES_REVISION}
RUN python -c "import sqlite3, sys; assert sys.version_info[:2] == (3, 14); assert sqlite3.sqlite_version_info >= (3,51,3)"
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
RUN /usr/sbin/useradd --uid ${LOCAL_UID} --create-home nocheh && mkdir -p /workspace /reports && chown ${LOCAL_UID}:${LOCAL_GID} /workspace /reports
WORKDIR /workspace
COPY --chown=${LOCAL_UID}:${LOCAL_GID} services ./services
COPY --chown=${LOCAL_UID}:${LOCAL_GID} deploy/upstreams.lock.json ./deploy/upstreams.lock.json
COPY --chown=${LOCAL_UID}:${LOCAL_GID} tools ./tools
# Every third-party library the plugin imports must exist in the pinned environment.
RUN python -c "import yaml, telegram, httpx, openai, starlette, uvicorn, PIL"
USER nocheh
CMD ["python", "-m", "services.hermes.runtime"]


FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS tui-assets
WORKDIR /opt/hermes
COPY --from=native-runtime /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=native-runtime /opt/hermes/ui-tui ./ui-tui
COPY --from=native-runtime /opt/hermes/apps/shared ./apps/shared
COPY --from=native-runtime /opt/hermes/web/package.json ./web/package.json
# The workspace build script compiles through the shared upstream frontend builders.
COPY --from=native-runtime /opt/hermes/scripts/build ./scripts/build
COPY tools/build/patch-native-tui.py /tmp/patch-native-tui.py
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && python3 /tmp/patch-native-tui.py /opt/hermes
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace ui-tui --workspace apps/shared --ignore-scripts --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=20000 --fetch-timeout=120000 && \
    npm run build --workspace ui-tui && test -f /opt/hermes/ui-tui/dist/entry.js

FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS dashboard-assets
WORKDIR /opt/hermes
COPY --from=native-runtime /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=native-runtime /opt/hermes/web ./web
COPY --from=native-runtime /opt/hermes/apps/shared ./apps/shared
COPY --from=native-runtime /opt/hermes/scripts/build ./scripts/build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN npm ci --workspace web --workspace apps/shared --ignore-scripts --no-audit --no-fund
COPY tools/build/patch-native-dashboard.py /tmp/patch-native-dashboard.py
COPY tools/build/native-browser-delivery.ts /tmp/native-browser-delivery.ts
COPY tools/build/native-browser-recovery.tsx /tmp/native-browser-recovery.tsx
# The patch sets the /hermes/ base in the Vite config; the upstream builder takes no build flags.
RUN python3 /tmp/patch-native-dashboard.py /opt/hermes && cd /opt/hermes && npm run build --workspace web && \
    test -f /opt/hermes/hermes_cli/web_dist/index.html

FROM native-runtime
COPY --from=dashboard-assets /opt/hermes/hermes_cli/web_dist /opt/hermes/hermes_cli/web_dist
COPY --from=tui-assets /usr/local/bin/node /usr/local/bin/node
COPY --from=tui-assets /opt/hermes/ui-tui/dist /opt/hermes/ui-tui/dist
# Each isolated turn starts a fresh interpreter on a read-only root. Compile
# the pinned libraries during the image build instead of recompiling them on
# every request (runtime bytecode writes remain disabled).
USER root
RUN python -m compileall -q /opt/venv/lib/python3.14/site-packages /workspace/services /workspace/tools \
    /opt/hermes/agent /opt/hermes/gateway /opt/hermes/tools /opt/hermes/hermes_cli /opt/hermes/tui_gateway \
    /opt/hermes/cron /opt/hermes/plugins /opt/hermes/pm /opt/hermes/*.py
USER nocheh
CMD ["python", "-m", "services.hermes.runtime"]
