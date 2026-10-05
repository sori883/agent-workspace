FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates openssh-client procps bash \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir google-antigravity==0.1.20

COPY bin/ax-task-runner /usr/local/bin/ax-task-runner
COPY .sources/ax/cmd/ax-task-runner/antigravity_bootstrap.py /usr/local/bin/antigravity_bootstrap.py

ENTRYPOINT ["/usr/local/bin/ax-task-runner"]
