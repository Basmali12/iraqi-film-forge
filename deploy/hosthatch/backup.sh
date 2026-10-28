#!/bin/bash
set -euo pipefail
umask 077
exec 9>/run/lock/iraqi-film-forge-backup.lock
flock -n 9 || exit 0
base=/var/backups/iraqi-film-forge
install -d -m 0700 "$base"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$base/$stamp"
mkdir -m 0700 "$target"
# The app's database user is deliberately not a database owner.
runuser -u postgres -- pg_dump -Fc iraqi_film_forge > "$target/database.dump"
# Files stay outside PostgreSQL; do not copy the encryption key into this archive.
tar --exclude='./transfer-cache' --exclude='./metadata-cache' -czf "$target/files.tar.gz" -C /var/lib/iraqi-film-forge .
sha256sum "$target/database.dump" "$target/files.tar.gz" > "$target/SHA256SUMS"
touch "$target/COMPLETE"
# Keep 7 complete daily backups; incomplete attempts are preserved for inspection.
mapfile -t old < <(find "$base" -mindepth 2 -maxdepth 2 -name COMPLETE -printf '%h\n' | sort -r | tail -n +8)
for folder in "${old[@]}"; do
 [[ "$folder" =~ ^/var/backups/iraqi-film-forge/[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
 rm -r -- "$folder"
done
printf 'Backup completed: %s\n' "$stamp"
