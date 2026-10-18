#!/bin/bash
# Gère les serveurs créés depuis le panel (unités gp-<id>, dossiers /srv/games/<id>).
# Installation : sudo install -m 755 scripts/gp-service.sh /usr/local/bin/gp-service
# sudoers      : user ALL=(root) NOPASSWD: /usr/local/bin/gp-service
# Les serveurs tournent sous le compte système gpgames (groupe gameservers), jamais sous root ni sous le compte du panel.
# ponytail: un seul compte pour tous les serveurs créés, un compte par serveur si l'isolation entre eux compte.
set -euo pipefail

ROOT=/srv/games
cmd=${1:-}
id=${2:-}
owner=${SUDO_USER:?à lancer via sudo}

[[ "$id" =~ ^[a-z0-9-]{1,48}$ ]] || { echo "id invalide" >&2; exit 2; }
dir="$ROOT/$id"
unit="/etc/systemd/system/gp-$id.service"

case "$cmd" in
  prepare)
    getent group gameservers >/dev/null || groupadd --system gameservers
    id gpgames &>/dev/null || useradd --system --gid gameservers --home-dir "$ROOT" --shell /usr/sbin/nologin gpgames
    install -d -m 755 "$ROOT"
    # setgid : tout ce qui est créé dedans reste au groupe gameservers (panel et jeu y écrivent tous les deux).
    install -d -m 2770 -o "$owner" -g gameservers "$dir"
    ;;
  create)
    type=${3:-}; ram=${4:-}; exe=${5:-}
    [[ "$ram" =~ ^[0-9]{1,2}$ ]] || { echo "ram invalide" >&2; exit 2; }
    env=""
    case "$type" in
      mc) exec_start="/usr/bin/java -Xms1G -Xmx${ram}G -jar server.jar nogui" ;;
      ac)
        [[ "$exe" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "exe invalide" >&2; exit 2; }
        exec_start="$dir/$exe" ;;
      lmu|fs)
        [[ "$exe" =~ ^[A-Za-z0-9\ ._-]+\.exe$ ]] || { echo "exe invalide" >&2; exit 2; }
        exec_start="/usr/bin/wine \"$dir/$exe\""
        env="Environment=WINEPREFIX=$dir/.wine
Environment=WINEDEBUG=-all
Environment=DISPLAY=" ;;
      *) echo "type invalide" >&2; exit 2 ;;
    esac
    cat > "$unit" <<EOF
[Unit]
Description=Garage Pikes $id
After=network.target

[Service]
User=gpgames
Group=gameservers
WorkingDirectory=$dir
Environment=HOME=$dir
$env
UMask=0007
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$dir
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ExecStart=$exec_start
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    ;;
  start|stop|restart)
    systemctl "$cmd" "gp-$id"
    ;;
  remove)
    systemctl disable --now "gp-$id" 2>/dev/null || true
    rm -f "$unit"
    systemctl daemon-reload
    # rm -rf ne suit pas les liens symboliques (content AC partagé).
    rm -rf --one-file-system "$dir"
    ;;
  *)
    echo "usage: gp-service prepare|create|start|stop|restart|remove <id> [type ram exe]" >&2
    exit 2
    ;;
esac
