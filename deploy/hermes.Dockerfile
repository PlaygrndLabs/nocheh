FROM ghcr.io/wangnov/codex-asr@sha256:8fd68262922d4b8348be4f71ed7638b03577842d8b06d323d28b564e68860808 AS asr
FROM ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 AS uv
FROM python:3.11.16-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84 AS sqlite
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Match the pinned upstream's SQLite WAL-corruption fix.
RUN curl -fSL --retry 3 https://sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz && \
    echo '0e9483900e92cd5de8fd48d16bf9200145a61f7fd5be542a5ac81d8a9516eb9c  /tmp/sqlite.tar.gz' | sha256sum -c - && \
    tar -xzf /tmp/sqlite.tar.gz -C /tmp && cd /tmp/sqlite-autoconf-3530400 && \
    CFLAGS='-O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_RTREE -DSQLITE_THREADSAFE=1' \
    ./configure --prefix=/opt/sqlite --disable-static && make -j2 && make install

FROM python:3.11.16-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=asr /usr/local/bin/codex-asr /usr/local/bin/rust-silk /usr/local/bin/
COPY --from=sqlite /opt/sqlite/lib /opt/sqlite/lib
ENV LD_LIBRARY_PATH=/opt/sqlite/lib PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never \
    PYTHONPATH=/opt/hermes:/workspace PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    HERMES_HOME=/workspace/data/local/hermes CODEX_ASR_SILK_DECODER=/usr/local/bin/rust-silk
ARG HERMES_REVISION=7166071fcaadb36df26f6d753dda97da6b5d699e
RUN git init /opt/hermes && cd /opt/hermes && git remote add origin https://github.com/NousResearch/hermes-agent.git && \
    git fetch --depth 1 origin "$HERMES_REVISION" && git checkout --detach FETCH_HEAD && \
    uv sync --frozen --no-dev --no-install-project --extra messaging --python /usr/local/bin/python && \
    rm -rf /opt/hermes/.git /root/.cache/uv
RUN python -c "import sqlite3; assert sqlite3.sqlite_version_info >= (3,51,3)"
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
RUN /usr/sbin/useradd --uid ${LOCAL_UID} --create-home nocheh && mkdir -p /workspace /reports && chown ${LOCAL_UID}:${LOCAL_GID} /workspace /reports
WORKDIR /workspace
COPY --chown=${LOCAL_UID}:${LOCAL_GID} integrations ./integrations
COPY --chown=${LOCAL_UID}:${LOCAL_GID} compatibility/fixtures ./compatibility/fixtures
COPY --chown=${LOCAL_UID}:${LOCAL_GID} scripts ./scripts
USER nocheh
CMD ["python", "-m", "integrations.hermes.runtime"]
