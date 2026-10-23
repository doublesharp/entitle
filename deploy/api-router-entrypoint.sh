#!/bin/sh
# Reload a validated internal route while existing Nginx workers drain requests.
set -eu
state=/routing/active-slot
current=
master=
render() {
    slot=$1
    cat > /runtime/candidate.conf <<CONFIG
worker_processes auto;
pid /runtime/nginx.pid;
error_log /dev/null crit;
events { worker_connections 1024; }
http {
    access_log off;
    server_tokens off;
    client_body_temp_path /cache/client;
    proxy_temp_path /cache/proxy;
    fastcgi_temp_path /cache/fastcgi;
    uwsgi_temp_path /cache/uwsgi;
    scgi_temp_path /cache/scgi;
    upstream entitle_api { server entitle-api-$slot:3211; keepalive 16; }
    server {
        listen 3211;
        client_max_body_size 0;
        location = /healthz { add_header X-Entitle-Slot $slot always; return 200 '$slot'; }
        location / {
            proxy_pass http://entitle_api;
            proxy_http_version 1.1;
            proxy_request_buffering off;
            proxy_buffering off;
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
            proxy_set_header Host \$http_host;
            proxy_set_header X-Forwarded-Host \$http_x_forwarded_host;
            proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;
            proxy_set_header X-Forwarded-For \$http_x_forwarded_for;
            proxy_set_header X-Real-IP \$http_x_real_ip;
            proxy_set_header Forwarded '';
            proxy_set_header Connection '';
            proxy_hide_header X-Entitle-Slot;
            add_header X-Entitle-Slot $slot always;
        }
    }
}
CONFIG
}
select_route() {
    next=$(cat "$state" 2>/dev/null) || return 1
    case "$next" in blue|green) ;; *) return 1 ;; esac
    [ "$next" != "$current" ] || return 0
    # Do not send traffic to an unavailable candidate, even if the file changed.
    headers=$(wget -S -q -T 5 -O /dev/null "http://entitle-api-$next:3211/api/v1/ready" 2>&1) || return 1
    role=$(printf '%s\n' "$headers" | awk 'tolower($1)=="x-entitle-server-role:" {gsub("\r", "", $2); print $2}')
    identity=$(printf '%s\n' "$headers" | awk 'tolower($1)=="x-entitle-deployment-slot:" {gsub("\r", "", $2); print $2}')
    [ "$role" = api ] && [ "$identity" = "$next" ] || return 1
    render "$next"
    nginx -t -c /runtime/candidate.conf >/dev/null 2>&1 || return 1
    mv /runtime/candidate.conf /runtime/nginx.conf
    if [ -n "$master" ]; then
        nginx -s reload -c /runtime/nginx.conf >/dev/null 2>&1 || return 1
    fi
    current=$next
}
# Fail startup if there is no healthy, explicit initial route.
select_route || { echo 'API router requires a healthy blue or green route' >&2; exit 1; }
nginx -c /runtime/nginx.conf -g 'daemon off;' &
master=$!
stop() {
    kill -QUIT "$master" 2>/dev/null || true
    wait "$master"
    exit $?
}
trap stop TERM INT
while kill -0 "$master" 2>/dev/null; do
    sleep 1 &
    wait $! || true
    select_route || true
done
wait "$master"
