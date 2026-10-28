#!/bin/bash
set -euo pipefail
umask 077
base=/var/backups/iraqi-film-forge
backup=$(find "$base" -mindepth 2 -maxdepth 2 -name COMPLETE -printf '%h\n' | sort -r | head -1)
[[ "$backup" =~ ^/var/backups/iraqi-film-forge/[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
sha256sum --check --status "$backup/SHA256SUMS"
db="iff_restore_check_$(date -u +%Y%m%d%H%M%S)"
stage=$(mktemp -d /var/tmp/iff-restore-check.XXXXXX)
cleanup(){
 [[ "$db" =~ ^iff_restore_check_[0-9]+$ ]] && runuser -u postgres -- dropdb --if-exists "$db"
 [[ "$stage" =~ ^/var/tmp/iff-restore-check\.[a-zA-Z0-9]+$ ]] && rm -r -- "$stage"
}
trap cleanup EXIT
runuser -u postgres -- createdb "$db"
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges -d "$db" < "$backup/database.dump"
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d "$db" -c "SELECT version FROM iff_migrations; SELECT count(*) AS restored_records FROM iff_records;"
tar -xzf "$backup/files.tar.gz" -C "$stage"
echo 'RESTORE_CHECK_OK: separate disposable database and private directory; source untouched'
