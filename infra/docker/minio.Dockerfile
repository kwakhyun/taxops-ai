# syntax=docker/dockerfile:1.7
# Local/CI S3 fixture only. The original official images and binaries are no
# longer downloadable. Build the same releases from verified official sources;
# do not substitute an untrusted mirror or change production AWS S3 settings.
FROM golang:1.24-bookworm AS source-builder
ENV CGO_ENABLED=0 GOMAXPROCS=2
WORKDIR /src

FROM source-builder AS minio-builder
# RELEASE.2025-04-22T22-12-26Z
ADD --checksum=sha256:7eb30a913fea30f18069abf194e1e78e4983b558cc526911ae1c11396a9859a5 https://codeload.github.com/minio/minio/tar.gz/0d7408fc9969caf07de6a8c3a84f9fbb10a6739e /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -p 2 -ldflags="-s -w" -o /out/minio .

FROM source-builder AS mc-builder
# RELEASE.2025-04-16T18-13-26Z
ADD --checksum=sha256:4cd13e34daeeb8481c3ba8686b082f161b8dc1f7aad52d715a706a587349c6ae https://codeload.github.com/minio/mc/tar.gz/b00526b153a31b36767991a4f5ce2cced435ee8e /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -p 2 -ldflags="-s -w" -o /out/mc .

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

FROM runtime AS server
COPY --from=minio-builder /out/minio /usr/local/bin/minio
COPY --from=minio-builder /src/LICENSE /usr/share/doc/minio/LICENSE
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]

FROM runtime AS client
COPY --from=mc-builder /out/mc /usr/local/bin/mc
COPY --from=mc-builder /src/LICENSE /usr/share/doc/mc/LICENSE
ENTRYPOINT ["/usr/local/bin/mc"]
