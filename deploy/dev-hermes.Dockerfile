# The base is a locally verified pinned Hermes image with no installation state
# or credentials. Only this checkout's integration code is layered on top.
ARG HERMES_BASE=nocheh-hermes:local
FROM ${HERMES_BASE}
ARG LOCAL_UID=1000
ARG LOCAL_GID=1000
USER root
COPY --chown=${LOCAL_UID}:${LOCAL_GID} integrations ./integrations
COPY --chown=${LOCAL_UID}:${LOCAL_GID} scripts ./scripts
COPY --chown=${LOCAL_UID}:${LOCAL_GID} compatibility/fixtures ./compatibility/fixtures
COPY --chown=${LOCAL_UID}:${LOCAL_GID} compatibility/upstreams.lock.json ./compatibility/upstreams.lock.json
USER nocheh
