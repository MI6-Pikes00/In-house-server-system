#!/bin/sh
# Envoie une notification ntfy. Usage : alerte "titre" "message"
# Installation : sudo install -m 700 scripts/alerte.sh /usr/local/sbin/alerte
# /etc/alerte.env (root, 600) contient NTFY_URL=https://ntfy.sh/<sujet-long-et-aléatoire>
set -eu
. /etc/alerte.env
curl -fsS --max-time 10 -H "Title: $1" -d "${2:-}" "$NTFY_URL" >/dev/null
