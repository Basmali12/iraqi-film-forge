#!/bin/bash
# Certbot deploy hook AFTER the owner approves public IP HTTPS activation.
set -euo pipefail
umask 077
[[ $(hostname) == muhtaj-app && $EUID == 0 ]] || exit 1
lineage=${RENEWED_LINEAGE:-}
[[ "$lineage" == /etc/iraqi-film-forge-acme/live/iff-hosthatch-ip ]] || exit 1
# Staging/untrusted certificates MUST NEVER be installed.
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt -untrusted "$lineage/chain.pem" "$lineage/cert.pem" >/dev/null
openssl x509 -in "$lineage/cert.pem" -checkip 167.104.162.4 -checkend 3600 -noout >/dev/null
cmp -s <(openssl x509 -in "$lineage/cert.pem" -pubkey -noout) <(openssl pkey -in "$lineage/privkey.pem" -pubout)
base=/var/lib/caddy/iff-ip-tls
install -d -o root -g caddy -m 0750 "$base" "$base/releases"
release="$base/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -o root -g caddy -m 0750 "$release"
install -o root -g caddy -m 0640 "$lineage/fullchain.pem" "$release/fullchain.pem"
install -o root -g caddy -m 0640 "$lineage/privkey.pem" "$release/privkey.pem"
old=$(readlink "$base/current" || true)
ln -s "$release" "$base/.next-$$"
mv -Tf "$base/.next-$$" "$base/current"
if ! runuser -u caddy -- /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || ! systemctl reload caddy; then
    if [[ -n "$old" && "$old" == "$base/releases/"* ]]; then
        ln -s "$old" "$base/.rollback-$$";mv -Tf "$base/.rollback-$$" "$base/current"
        systemctl reload caddy
    fi
    echo 'CERTIFICATE_RELOAD_FAILED_REVIEW_REQUIRED' >&2
    exit 1
fi
echo 'Iraqi Film Forge trusted IP certificate loaded; no application/Modal secrets logged.'
