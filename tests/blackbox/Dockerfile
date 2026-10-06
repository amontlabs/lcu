# The black-box harness image: tests/Dockerfile's Ubuntu 24.04 verification image plus the project's reference
# interpreter, CPython 3.12.10 (Ubuntu 24.04's own python3 is 3.12.3, whose argparse and shutil.rmtree messages
# differ from 3.12.10's: the oracle must run on the interpreter LCU 0.9.4 is specified against).
#
#   docker build --build-arg BASE=lcu-verification:arm64 -t lcu-blackbox:arm64 -f tests/blackbox/Dockerfile .
#
# tests/blackbox/docker.sh builds this for you. The network is needed ONLY at image-build time (the tarball);
# every harness run stays --network none. /usr/bin/python3 (3.12.3) is untouched: the Linux system helper tests
# use it, the harness and the oracle use /opt/cpython-3.12.10/bin/python3.12.
ARG BASE=lcu-verification:arm64

FROM ubuntu:24.04 AS cpython
# Published checksums of https://www.python.org/ftp/python/3.12.10/Python-3.12.10.tar.xz
# (python.org release page: MD5 0c0a6cce86d7611aed691d61e0599de0; the GPG signature is Python-3.12.10.tar.xz.asc).
# The SHA-256 below was computed on 2026-10-06 from a fresh HTTPS download whose MD5 matched the published one.
ARG PYTHON_VERSION=3.12.10
ARG PYTHON_SHA256=07ab697474595e06f06647417d3c7fa97ded07afc1a7e4454c5639919b46eaea
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl xz-utils libffi-dev libssl-dev zlib1g-dev libbz2-dev liblzma-dev \
    libsqlite3-dev libreadline-dev uuid-dev libncurses-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/python.tar.xz "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz" \
    && echo "${PYTHON_SHA256}  /tmp/python.tar.xz" | sha256sum -c - \
    && mkdir /tmp/python-src && tar -xJf /tmp/python.tar.xz -C /tmp/python-src --strip-components=1 \
    && cd /tmp/python-src \
    && ./configure --prefix=/opt/cpython-${PYTHON_VERSION} --with-ensurepip=no \
    && make -j"$(nproc)" && make install \
    && /opt/cpython-${PYTHON_VERSION}/bin/python3.12 -c "import sys; assert sys.version_info[:3] == (3, 12, 10), sys.version"

FROM ${BASE}
COPY --from=cpython /opt/cpython-3.12.10 /opt/cpython-3.12.10
# Runtime libraries of the optional extension modules (the base image already carries most of them).
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libffi8 libbz2-1.0 liblzma5 libsqlite3-0 libreadline8t64 libuuid1 libncursesw6 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && /opt/cpython-3.12.10/bin/python3.12 -c "import sys, ssl, ctypes, zlib; assert sys.version_info[:3] == (3, 12, 10)"
LABEL lcu.blackbox.python="3.12.10"
