FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv
FROM python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS sqlite
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Match the pinned upstream's SQLite WAL-corruption fix.
RUN curl -fSL --retry 3 https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp && cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_RTREE -DSQLITE_THREADSAFE=1' \
    ./configure --prefix=/opt/sqlite --disable-static && make -j2 && make install

FROM python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS native-runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=sqlite /opt/sqlite/lib /opt/sqlite/lib
ENV LD_LIBRARY_PATH=/opt/sqlite/lib PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never \
    PYTHONPATH=/opt/hermes:/workspace PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    HERMES_HOME=/workspace/data/local/hermes
ARG HERMES_REVISION=ae2a81ccc00e9b7c06301523e5bb09608397149c
ARG HERMES_VERSION=0.23.2
COPY --from=hermes_source . /opt/hermes
COPY deploy/hermes-plugin-requirements.txt /tmp/hermes-plugin-requirements.txt
# The pinned upstream supports only Python 3.14; keep the interpreter explicit
# because newer uv releases default to a later Python. The upstream stamp
# writer records the pinned release, so native version surfaces report it and
# treat updates as externally managed.
RUN test "$(cat /opt/hermes/.nocheh-source-revision)" = "$HERMES_REVISION" && cd /opt/hermes && \
    uv sync --frozen --no-dev --no-install-project --extra messaging --extra anthropic --extra mcp --python /usr/local/bin/python && \
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
RUN python -c "import yaml, telegram, httpx, openai, anthropic, starlette, uvicorn, PIL, mcp, httpx2"
USER nocheh
CMD ["python", "-m", "services.hermes.runtime"]


# Upstream installs its Node workspaces with the pnpm pinned in pm/lock.json.
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS frontend-tools
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY --from=native-runtime /opt/hermes /opt/hermes
COPY tools/build/install-pinned-pnpm.py /tmp/install-pinned-pnpm.py
WORKDIR /opt/hermes
RUN python3 /tmp/install-pinned-pnpm.py /opt/hermes /opt/pnpm && ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm && pnpm --version

FROM frontend-tools AS tui-assets
COPY tools/build/patch-native-tui.py /tmp/patch-native-tui.py
RUN python3 /tmp/patch-native-tui.py /opt/hermes
RUN node scripts/build/node-deps.mjs --source /opt/hermes --workspace ui-tui && \
    node scripts/build/tui.mjs --source /opt/hermes --out /opt/products/tui && test -f /opt/products/tui/dist/entry.js

# The dashboard build takes prepared icons; upstream renders them with the pinned Python environment.
FROM native-runtime AS icons
RUN python -I /opt/hermes/scripts/generate_icons.py --source /opt/hermes --out /tmp/hermes-icons

FROM frontend-tools AS dashboard-assets
COPY tools/build/patch-native-dashboard.py /tmp/patch-native-dashboard.py
COPY tools/build/native-browser-delivery.ts /tmp/native-browser-delivery.ts
COPY tools/build/native-browser-recovery.tsx /tmp/native-browser-recovery.tsx
COPY --from=icons /tmp/hermes-icons /tmp/hermes-icons
# The patch sets the /hermes/ base in the Vite config; the upstream builder takes no build flags.
RUN python3 /tmp/patch-native-dashboard.py /opt/hermes && \
    node scripts/build/node-deps.mjs --source /opt/hermes --workspace web && \
    node scripts/build/web.mjs --source /opt/hermes --icons /tmp/hermes-icons --out /opt/products/web && \
    test -f /opt/products/web/index.html

FROM native-runtime
COPY --from=dashboard-assets /opt/products/web /opt/hermes/hermes_cli/web_dist
COPY --from=tui-assets /usr/local/bin/node /usr/local/bin/node
# The TUI product is its bundled dist plus a package.json that marks it as an ES module.
COPY --from=tui-assets /opt/products/tui /opt/hermes/ui-tui
# Each isolated turn starts a fresh interpreter on a read-only root. Compile
# the pinned libraries during the image build instead of recompiling them on
# every request (runtime bytecode writes remain disabled).
USER root
RUN python -m compileall -q /opt/venv/lib/python3.14/site-packages /workspace/services /workspace/tools \
    /opt/hermes/agent /opt/hermes/gateway /opt/hermes/tools /opt/hermes/hermes_cli /opt/hermes/tui_gateway \
    /opt/hermes/cron /opt/hermes/plugins /opt/hermes/pm /opt/hermes/*.py
USER nocheh
CMD ["python", "-m", "services.hermes.runtime"]
