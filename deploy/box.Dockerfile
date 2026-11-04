# The sealed job box: no network, keys or Hermes; only shell tools and Python for a job's commands.
FROM python:3.14.9-slim-trixie@sha256:35caba83af2fe6da9a5d922f9b0156f21d1246a48278c58a08bd253303ba42e8 AS box
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils findutils grep gawk tar procps ripgrep && \
    rm -rf /var/lib/apt/lists/* && find / -xdev -type f -perm /6000 -exec chmod ug-s {} + && \
    test -z "$(find / -xdev -type f -perm /6000)"
COPY tools/runtime/box_server.py tools/runtime/box_put.py /opt/box/

# Flattened, so the box keeps none of the base image's variables: it has only those the launcher sets.
FROM scratch
COPY --from=box / /
USER 65532:65532
WORKDIR /work
CMD ["python3", "-I", "/opt/box/box_server.py"]
