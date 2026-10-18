#!/bin/sh
# Alerte une fois par port en écoute absent de /etc/alerte/ports-autorises (un numéro par ligne).
# Installation : sudo install -m 700 scripts/alerte-ports.sh /usr/local/sbin/alerte-ports (timer dans docs/SECURITE.md)
set -eu
umask 077
autorises=${AUTORISES:-/etc/alerte/ports-autorises}
deja=${DEJA:-/var/lib/alerte/ports-signales}
mkdir -p "$(dirname "$deja")"
touch "$deja"
now=$(mktemp)
trap 'rm -f "$now"' EXIT
ss -Hltnu > "$now"
# Comparaison sur le seul numéro de port : tcp et udp partagent la liste autorisée.
nouveaux=$(awk 'NR == FNR { ok[$1]; next } { n = split($5, a, ":"); if (!(a[n] in ok)) print $1 "/" a[n] }' "$autorises" "$now" \
  | sort -u | grep -vxFf "$deja" || true)
[ -z "$nouveaux" ] && exit 0
${ALERTE:-/usr/local/sbin/alerte} "Port inattendu en écoute" "$(hostname) : $nouveaux"
printf '%s\n' "$nouveaux" >> "$deja"
