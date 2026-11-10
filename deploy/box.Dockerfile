# The sealed job box: no network, keys or Hermes; only shell tools, git and Python for a job's commands. The GitHub
# fetcher runs this image too (ADR-0209). In the box, git has no network and only reads the copy in /repo.
FROM python:3.14.10-slim-trixie@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f AS box
# Box commands (uid 65532) read /repo/code, which uid 65531 owns. Symlinks stay the small files the writer made, nothing
# runs from git, and git shares the box's one CPU and its memory with the writer.
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils findutils grep gawk tar procps ripgrep git ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    git config --system safe.directory /repo/code && git config --system --add safe.directory /repo/code/.git && \
    git config --system core.pager cat && git config --system core.checkStat minimal && \
    git config --system core.fsmonitor false && git config --system core.hooksPath /dev/null && \
    git config --system core.symlinks false && git config --system gc.auto 0 && git config --system maintenance.auto false && \
    git config --system protocol.allow never && git config --system protocol.file.allow always && \
    git config --system pack.threads 1 && git config --system index.threads 1 && git config --system checkout.workers 1 && \
    git config --system core.deltaBaseCacheLimit 32m && \
    find / -xdev -type f -perm /6000 -exec chmod ug-s {} + && \
    test -z "$(find / -xdev -type f -perm /6000)"
COPY tools/runtime/box_server.py tools/runtime/box_put.py tools/runtime/box_repo.py tools/runtime/repo_fetch.py /opt/box/

# Flattened, so the box keeps none of the base image's variables: it has only those the launcher sets.
FROM scratch
COPY --from=box / /
USER 65532:65532
WORKDIR /work
CMD ["python3", "-I", "/opt/box/box_server.py"]
