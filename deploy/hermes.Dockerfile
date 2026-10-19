FROM ghcr.io/astral-sh/uv:0.12.24@sha256:3af4716e991d6956a41e573eab705d0ee08500cd829ed30293eb8472f372c65a AS uv
FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89 AS sqlite
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Match the pinned upstream's SQLite WAL-corruption fix.
RUN curl -fSL --retry 3 https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp && cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_RTREE -DSQLITE_THREADSAFE=1' \
    ./configure --prefix=/opt/sqlite --disable-static && make -j2 && make install

FROM python:3.11.17-slim-bookworm@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89 AS native-runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=sqlite /opt/sqlite/lib /opt/sqlite/lib
ENV LD_LIBRARY_PATH=/opt/sqlite/lib PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never \
    PYTHONPATH=/opt/hermes:/workspace PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    HERMES_HOME=/workspace/data/local/hermes
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
COPY --chown=${LOCAL_UID}:${LOCAL_GID} services ./services
COPY --chown=${LOCAL_UID}:${LOCAL_GID} deploy/upstreams.lock.json ./deploy/upstreams.lock.json
COPY --chown=${LOCAL_UID}:${LOCAL_GID} tools ./tools
USER nocheh
CMD ["python", "-m", "services.hermes.runtime"]


FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS tui-assets
WORKDIR /opt/hermes
COPY --from=native-runtime /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=native-runtime /opt/hermes/ui-tui ./ui-tui
COPY --from=native-runtime /opt/hermes/apps/shared ./apps/shared
COPY --from=native-runtime /opt/hermes/web/package.json ./web/package.json
COPY tools/build/patch-native-tui.py /tmp/patch-native-tui.py
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && python3 /tmp/patch-native-tui.py /opt/hermes
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace ui-tui --workspace apps/shared --ignore-scripts --no-audit --no-fund \
      --fetch-retries=5 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=20000 --fetch-timeout=120000 && \
    npm run build --workspace ui-tui

FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dashboard-assets
WORKDIR /opt/hermes
COPY --from=native-runtime /opt/hermes/package.json /opt/hermes/package-lock.json ./
COPY --from=native-runtime /opt/hermes/web ./web
COPY --from=native-runtime /opt/hermes/apps/shared ./apps/shared
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN npm ci --workspace web --workspace apps/shared --ignore-scripts --no-audit --no-fund
COPY tools/build/patch-native-dashboard.py /tmp/patch-native-dashboard.py
COPY tools/build/native-browser-delivery.ts /tmp/native-browser-delivery.ts
COPY tools/build/native-browser-recovery.tsx /tmp/native-browser-recovery.tsx
RUN python3 /tmp/patch-native-dashboard.py /opt/hermes && cd /opt/hermes && npm run build --workspace web -- --base=/hermes/

FROM native-runtime
COPY --from=dashboard-assets /opt/hermes/hermes_cli/web_dist /opt/hermes/hermes_cli/web_dist
COPY --from=tui-assets /usr/local/bin/node /usr/local/bin/node
COPY --from=tui-assets /opt/hermes/ui-tui/dist /opt/hermes/ui-tui/dist
# Each isolated turn starts a fresh interpreter on a read-only root. Compile
# the pinned libraries during the image build instead of recompiling them on
# every request (runtime bytecode writes remain disabled).
USER root
RUN python -m compileall -q /opt/venv/lib/python3.11/site-packages /workspace/services /workspace/tools \
    /opt/hermes/agent /opt/hermes/gateway /opt/hermes/tools /opt/hermes/hermes_cli \
    /opt/hermes/run_agent.py /opt/hermes/hermes_state.py /opt/hermes/model_tools.py \
    /opt/hermes/toolsets.py /opt/hermes/hermes_constants.py /opt/hermes/utils.py
USER nocheh
CMD ["python", "-m", "services.hermes.runtime"]
