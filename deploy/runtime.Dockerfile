# Build from the repository root: docker build -f deploy/runtime.Dockerfile .
# This stable runtime contains no application build or release-specific files.
FROM nginxinc/nginx-unprivileged:1.28.2-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
USER root
RUN mkdir -p /runtime /cache /releases \
    && chown 101:101 /runtime /cache
COPY deploy/nginx.conf.template /etc/entitle/nginx.conf.template
COPY --chmod=0555 deploy/runtime-entrypoint.sh /usr/local/bin/entitle-runtime
USER 101:101
ENV ENTITLE_API_UPSTREAM=entitle-api:3211 ENTITLE_PUBLIC_SCHEME=https
# Supply ENTITLE_PUBLIC_HOST as the canonical public hostname, with optional port.
EXPOSE 8080
# Use a read-only root filesystem, a read-only bind of the entire release parent
# at /releases (not current's resolved target), and separate writable tmpfs mounts
# /runtime and /cache with uid=101,gid=101,mode=0700. No published host ports.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entitle-runtime"]
