# Durcissement du serveur

Plan ordonné pour appliquer le durcissement sans te couper l'accès. Chaque étape donne la commande, la vérification, le résultat attendu et le retour arrière. « À vérifier » signale un point qui dépend de ta version de Debian : la commande indiquée permet de trancher.

Adresses utilisées dans les exemples : serveur `192.168.0.55`, LAN `192.168.0.0/24`, WireGuard `10.8.0.0/24`. Remplace-les par les tiennes.

## 0. Avant de commencer

```bash
cat /etc/os-release            # Debian 12 (bookworm) ou 13 (trixie) : quelques écarts sont signalés plus bas
sudo apt install lynis
sudo lynis audit system --quick
sudo grep hardening_index /var/log/lynis-report.dat   # note le score de départ
```

Garde une session SSH ouverte pendant toutes les étapes 2 à 6 : c'est ton retour arrière si une règle te bloque.

## 1. Tableau des ports

| Port | Proto | Service | Exposition |
|---|---|---|---|
| 25565 | TCP | Minecraft Fabric (MSH) | Public, redirigé par la box |
| 25566 | TCP | Minecraft Paper (MSH) | Public, redirigé par la box |
| 9603 | TCP + UDP | Assetto Corsa | Public, redirigé par la box |
| 9604 | TCP | Assetto Corsa HTTP (lobby) | Public, redirigé par la box |
| port choisi à la création | selon le jeu | Serveurs `gp-*` (Le Mans Ultimate, Farming Simulator) | Public seulement si tu y joues ; ports exacts à lire dans leur config |
| 51820 | UDP | WireGuard | Public, redirigé par la box |
| 22 | TCP | SSH | LAN et WireGuard seulement |
| 4444 | TCP | Panel | LAN et WireGuard seulement, jamais redirigé |
| 25585, 25586 | TCP | RCON des serveurs d'origine | Fermé (le panel s'y connecte en local) |
| port du jeu ± 10000 | TCP | RCON des serveurs Minecraft créés | Fermé |
| port interne du Java derrière MSH | TCP | Minecraft réel | Fermé (à lire dans `server.properties`) |

Le RCON de Minecraft écoute sur toutes les interfaces quand `server-ip` est vide : seul le pare-feu le ferme. Ne le redirige jamais depuis la box.

Le panel n'écoute plus sur `0.0.0.0` : il prend `panel.host` dans `config.json` (`127.0.0.1` par défaut). Mets l'IP LAN du serveur et fixe-la par une réservation DHCP sur la box.

## 2. Clé SSH (avant toute modification de sshd)

Depuis ton PC :

```bash
ssh-keygen -t ed25519
ssh-copy-id user@192.168.0.55
ssh -o PasswordAuthentication=no user@192.168.0.55 true && echo CLE_OK
```

**Attendu** : `CLE_OK`. Tant que ce n'est pas le cas, ne passe pas à l'étape 3.

## 3. Configuration SSH

Sur Debian, `sshd_config` inclut `/etc/ssh/sshd_config.d/*.conf` en tête de fichier, et pour chaque option c'est la première valeur lue qui gagne. Un drop-in préfixé `00-` passe donc avant le fichier principal et les autres drop-ins.

```bash
sudo tee /etc/ssh/sshd_config.d/00-durcissement.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers user
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

**Vérifier** : `sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers|maxauthtries|logingracetime|x11forwarding|allowtcpforwarding) '`, puis ouvre une nouvelle connexion depuis un autre terminal.
**Attendu** : les valeurs ci-dessus, et la nouvelle connexion passe par la clé.
**Rollback** (depuis la session restée ouverte) : `sudo rm /etc/ssh/sshd_config.d/00-durcissement.conf && sudo systemctl reload ssh`.

À vérifier sur Debian 13 : `systemctl is-active ssh.socket`. Si le socket est actif, recharge `ssh.service` comme ci-dessus, le résultat de `sshd -T` reste la référence.

## 4. Pare-feu UFW (IPv4 et IPv6)

```bash
sudo apt install ufw
grep IPV6 /etc/default/ufw          # attendu : IPV6=yes
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.0.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.0.0/24 to any port 4444 proto tcp
sudo ufw allow in on wg0 to any port 22 proto tcp
sudo ufw allow in on wg0 to any port 4444 proto tcp
sudo ufw allow 51820/udp
sudo ufw allow 25565:25566/tcp
sudo ufw allow 9603
sudo ufw allow 9604/tcp
sudo ufw enable
```

Pas de `ufw limit` sur SSH : il n'est joignable que depuis le LAN et WireGuard, et Fail2ban couvre les échecs.

**Vérifier** : `sudo ufw status verbose`, puis une nouvelle connexion SSH.
**Attendu** : `Default: deny (incoming)`, les règles ci-dessus en v4 et en v6, SSH toujours accessible.
**Rollback** : `sudo ufw disable`.

## 5. WireGuard pour le panel et SSH depuis l'extérieur

```bash
sudo apt install wireguard
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/serveur.key; wg pubkey < /etc/wireguard/serveur.key > /etc/wireguard/serveur.pub'
sudo sh -c 'umask 077; cat > /etc/wireguard/wg0.conf' <<'EOF'
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PostUp = wg set %i private-key /etc/wireguard/serveur.key

[Peer]
# PC portable
PublicKey = <clé publique du client>
AllowedIPs = 10.8.0.2/32
EOF
sudo systemctl enable --now wg-quick@wg0
```

Client :

```ini
[Interface]
Address = 10.8.0.2/32
PrivateKey = <clé privée du client>

[Peer]
PublicKey = <contenu de /etc/wireguard/serveur.pub>
Endpoint = <ton-domaine-ddns>:51820
AllowedIPs = 10.8.0.1/32, 192.168.0.55/32
PersistentKeepalive = 25
```

Avec `192.168.0.55/32` dans `AllowedIPs`, tu utilises la même adresse pour le panel (`https://192.168.0.55:4444`) chez toi et à l'extérieur. Pas besoin d'activer `ip_forward` : le client ne joint que le serveur lui-même.

**Vérifier** : `sudo wg show` depuis le serveur après connexion du client, puis `curl -k https://192.168.0.55:4444` depuis le client en 4G.
**Attendu** : un `latest handshake` récent, et la page du panel.
**Rollback** : `sudo systemctl disable --now wg-quick@wg0`.

## 6. Comptes dédiés et sandboxing des serveurs

Les unités du dépôt ne tournent plus sous ton compte `user` (celui de SSH et de sudo) :

| Unité | Compte | Écriture autorisée |
|---|---|---|
| `msh-fabric`, `msh-paper`, `minecraft-fabric`, `minecraft-paper` | `minecraft` | `/opt/minecraft` |
| `assetto` | `assetto` | `/opt/assetto` |
| `gp-*` (créés depuis le panel) | `gpgames` | `/srv/games/<id>` |
| `minecraft-panel` | `panel` | non sandboxé (passe par sudo) |

Tous partagent le groupe `gameservers` avec `UMask=0007` : le panel peut éditer les fichiers des jeux, les autres comptes du système ne voient rien. Les unités de jeu ont `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` : un serveur de jeu compromis ne peut ni appeler sudo, ni écrire hors de son dossier, ni lire `/home`.

Migration, une fois, **avant** de copier les nouvelles unités :

```bash
sudo systemctl stop minecraft-panel msh-fabric msh-paper assetto
sudo groupadd --system gameservers
sudo useradd --system --gid gameservers --home-dir /opt/minecraft-panel --shell /usr/sbin/nologin panel
sudo useradd --system --gid gameservers --home-dir /opt/assetto --shell /usr/sbin/nologin assetto
sudo usermod -aG gameservers minecraft
sudo usermod -aG systemd-journal panel
sudo usermod -aG gameservers user      # SFTP depuis ton compte

# Panel : dossier fermé aux comptes des jeux (config.json, sessions, clé TLS)
sudo chown -R panel:gameservers /opt/minecraft-panel
sudo chmod 700 /opt/minecraft-panel
sudo chmod 600 /opt/minecraft-panel/config.json /opt/minecraft-panel/ssl/key.pem

# Jeux : groupe gameservers, setgid sur les dossiers
sudo chown -R minecraft:gameservers /opt/minecraft
sudo chown -R assetto:gameservers /opt/assetto
[ -d /srv/games ] && sudo chgrp -R gameservers /srv/games
for d in /opt/minecraft /opt/assetto /srv/games; do
  [ -d "$d" ] || continue
  sudo chmod -R g+rwX,o-rwx "$d"
  sudo find "$d" -type d -exec chmod g+s {} +
done

# Wine : le préfixe doit appartenir au compte qui lance Wine
sudo -u assetto env HOME=/opt/assetto WINEPREFIX=/opt/assetto/.wine64 wineboot --init
```

Si Assetto Corsa ne démarre pas avec un préfixe neuf, copie l'ancien : `sudo cp -a /home/user/.wine64 /opt/assetto/.wine64 && sudo chown -R assetto:gameservers /opt/assetto/.wine64`.

sudo pour le panel : remplace `/etc/sudoers.d/gp-service` par une liste fermée (`sudo visudo -f /etc/sudoers.d/garage-panel`) :

```
panel ALL=(root) NOPASSWD: /usr/local/bin/gp-service, /usr/local/bin/switch-to-assetto.sh, /usr/local/bin/switch-to-minecraft.sh, /usr/bin/systemctl start msh-fabric, /usr/bin/systemctl stop msh-fabric, /usr/bin/systemctl restart msh-fabric, /usr/bin/systemctl start msh-paper, /usr/bin/systemctl stop msh-paper, /usr/bin/systemctl restart msh-paper, /usr/bin/systemctl restart assetto
```

Supprime l'ancienne ligne pour `user`, puis installe les unités et redémarre :

```bash
sudo rm /etc/sudoers.d/gp-service && sudo visudo -c
sudo install -m 755 scripts/gp-service.sh /usr/local/bin/gp-service
sudo cp systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl start minecraft-panel msh-fabric msh-paper
```

Serveurs `gp-*` créés avant la migration : pour chacun (valeurs dans `servers.json`), régénère l'unité et rends le préfixe Wine au nouveau compte.

```bash
sudo SUDO_USER=panel gp-service prepare <id>
sudo SUDO_USER=panel gp-service create <id> <type> <ram> "<exe>"
[ -d /srv/games/<id>/.wine ] && sudo chown -R gpgames:gameservers /srv/games/<id>/.wine
```

**Vérifier** : `systemctl show -p User,Group minecraft-panel msh-fabric msh-paper assetto`, `sudo -l -U panel`, `systemd-analyze security msh-fabric assetto`.
**Attendu** : les comptes du tableau, la liste sudo ci-dessus seulement, un score d'exposition nettement plus bas qu'avant (`UNSAFE` vers `MEDIUM`).
**Rollback** : `git checkout <commit précédent> -- systemd/ scripts/gp-service.sh`, recopie les unités, `sudo chown -R user:user` sur les dossiers et remets l'ancien sudoers.

## 7. Fail2ban

Debian 12 et 13 n'installent plus rsyslog : `/var/log/auth.log` n'existe pas et la jail SSH doit lire le journal systemd.

```bash
sudo apt install fail2ban python3-systemd
sudo tee /etc/fail2ban/filter.d/garage-panel.conf >/dev/null <<'EOF'
[Definition]
failregex = Echec connexion panel depuis <HOST>$
EOF
sudo tee /etc/fail2ban/action.d/ntfy.conf >/dev/null <<'EOF'
[Definition]
actionban = /usr/local/sbin/alerte "Fail2ban <name>" "<ip> bannie"
EOF
sudo tee /etc/fail2ban/jail.d/garage.local >/dev/null <<'EOF'
[DEFAULT]
bantime = 1h
bantime.increment = true
findtime = 10m
action = %(action_)s
         ntfy

[sshd]
enabled = true
backend = systemd
maxretry = 3

[garage-panel]
enabled = true
backend = auto
port = 4444
logpath = /var/log/minecraft-panel/auth.log
maxretry = 5
EOF
sudo fail2ban-client -t && sudo systemctl restart fail2ban
```

Le panel écrit désormais une ligne `Echec connexion panel depuis <ip>` à chaque mauvais mot de passe. Rotation du fichier :

```bash
sudo tee /etc/logrotate.d/minecraft-panel >/dev/null <<'EOF'
/var/log/minecraft-panel/auth.log {
  weekly
  rotate 8
  compress
  delaycompress
  missingok
  copytruncate
}
EOF
```

**Vérifier** : `sudo fail2ban-client status sshd`, `sudo fail2ban-client status garage-panel`, `sudo fail2ban-regex /var/log/minecraft-panel/auth.log /etc/fail2ban/filter.d/garage-panel.conf` après un faux mot de passe.
**Attendu** : deux jails actives, une ligne `Failregex: 1 total`.
**Rollback** : `sudo rm /etc/fail2ban/jail.d/garage.local && sudo systemctl restart fail2ban`.

L'action `ntfy` suppose l'étape 10 faite : fais-la avant, ou retire temporairement la ligne `ntfy`.

## 8. sysctl réseau

```bash
sudo tee /etc/sysctl.d/90-garage.conf >/dev/null <<'EOF'
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
kernel.kptr_restrict = 2
kernel.yama.ptrace_scope = 1
EOF
sudo sysctl --system
```

**Vérifier** : `sysctl net.ipv4.conf.all.rp_filter net.ipv4.tcp_syncookies kernel.yama.ptrace_scope`.
**Attendu** : `1`, `1`, `1`. À vérifier : `sysctl -a 2>/dev/null | grep '\.rp_filter'`, un fichier de `/usr/lib/sysctl.d` peut laisser certaines interfaces à `2` (mode souple), ce qui reste acceptable.
**Rollback** : `sudo rm /etc/sysctl.d/90-garage.conf` puis redémarrage.

## 9. Mises à jour automatiques

```bash
sudo apt install unattended-upgrades apt-listchanges
sudo dpkg-reconfigure -plow unattended-upgrades
sudo tee /etc/apt/apt.conf.d/52garage >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "05:00";
EOF
```

**Vérifier** : `sudo unattended-upgrade --dry-run --debug 2>&1 | grep -Ei 'origins|allowed'`.
**Attendu** : la ligne des origines contient `Debian-Security`.
**Rollback** : `sudo rm /etc/apt/apt.conf.d/52garage`.

Le redémarrage de 05:00 coupe les parties en cours, et avec un disque chiffré il bloque sur la phrase de passe (voir étape 13). Les dépôts hors Debian (WineHQ, Node.js) et les jars Paper, Fabric et leurs mods ne sont pas couverts : à mettre à jour à la main.

## 10. Alertes en temps réel (ntfy)

```bash
sudo install -m 700 scripts/alerte.sh /usr/local/sbin/alerte
sudo install -m 700 scripts/alerte-ports.sh /usr/local/sbin/alerte-ports
sudo sh -c 'umask 077; echo "NTFY_URL=https://ntfy.sh/$(openssl rand -hex 16)" > /etc/alerte.env'
sudo cat /etc/alerte.env            # abonne ton téléphone à ce sujet dans l'app ntfy
sudo /usr/local/sbin/alerte "Test" "ça marche"
```

Le sujet ntfy sert de secret : il n'est que dans `/etc/alerte.env` (root, 600), jamais dans les scripts.

**Échec d'une unité** (mises à jour, sauvegarde, surveillance des ports) :

```bash
sudo tee /etc/systemd/system/alerte-echec@.service >/dev/null <<'EOF'
[Unit]
Description=Alerte échec %i

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/alerte "Échec %i" "journalctl -u %i"
EOF
sudo mkdir -p /etc/systemd/system/apt-daily-upgrade.service.d
printf '[Unit]\nOnFailure=alerte-echec@%%n.service\n' | sudo tee /etc/systemd/system/apt-daily-upgrade.service.d/alerte.conf
```

À vérifier : unattended-upgrades ne fait pas toujours échouer l'unité quand un paquet échoue. Contrôle de temps en temps `grep -i error /var/log/unattended-upgrades/unattended-upgrades.log`.

**Connexion SSH réussie** :

```bash
sudo tee /usr/local/sbin/alerte-ssh >/dev/null <<'EOF'
#!/bin/sh
[ "$PAM_TYPE" = open_session ] && /usr/local/sbin/alerte "Connexion SSH" "$PAM_USER depuis $PAM_RHOST"
exit 0
EOF
sudo chmod 700 /usr/local/sbin/alerte-ssh
echo 'session optional pam_exec.so /usr/local/sbin/alerte-ssh' | sudo tee -a /etc/pam.d/sshd
```

`optional` : si ntfy est injoignable, la connexion passe quand même (après 10 s au plus).

**Nouveau port en écoute** :

```bash
sudo mkdir -p /etc/alerte
printf '%s\n' 22 4444 51820 25565 25566 25585 25586 9603 9604 | sudo tee /etc/alerte/ports-autorises
sudo tee /etc/systemd/system/alerte-ports.service >/dev/null <<'EOF'
[Unit]
Description=Ports en écoute inattendus
OnFailure=alerte-echec@%n.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/alerte-ports
EOF
sudo tee /etc/systemd/system/alerte-ports.timer >/dev/null <<'EOF'
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now alerte-ports.timer
```

Ajoute à `ports-autorises` les ports internes de MSH, des serveurs `gp-*` et des services système (DNS local 53, etc.) : le premier passage te les signalera une fois chacun.

**Vérifier** : `systemctl list-timers alerte-ports.timer`, `sudo systemctl start alerte-ports.service`, une connexion SSH.
**Attendu** : une notification par port inconnu (une seule fois), une à la connexion SSH.
**Rollback** : `sudo systemctl disable --now alerte-ports.timer`, retire la ligne `pam_exec` de `/etc/pam.d/sshd`.

## 11. Sauvegardes chiffrées

restic chiffre tout le dépôt. Destination : un disque externe au minimum, idéalement une copie hors de chez toi (un vol ou un incendie emporte le portable et le disque posé à côté).

```bash
sudo apt install restic
sudo sh -c 'umask 077; openssl rand -base64 32 > /root/.restic-pass'
sudo restic -r /mnt/sauvegarde/restic --password-file /root/.restic-pass init
```

Copie le mot de passe dans ton gestionnaire de mots de passe : sans lui, la sauvegarde est illisible.

```bash
sudo tee /etc/systemd/system/sauvegarde.service >/dev/null <<'EOF'
[Unit]
Description=Sauvegarde restic
OnFailure=alerte-echec@%n.service

[Service]
Type=oneshot
Environment=RESTIC_REPOSITORY=/mnt/sauvegarde/restic RESTIC_PASSWORD_FILE=/root/.restic-pass
ExecStart=/usr/bin/restic backup /opt/minecraft /opt/assetto /srv/games /opt/minecraft-panel /etc --exclude=**/.wine* --exclude=/opt/minecraft-panel/node_modules
ExecStartPost=/usr/bin/restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
EOF
sudo tee /etc/systemd/system/sauvegarde.timer >/dev/null <<'EOF'
[Timer]
OnCalendar=*-*-* 04:30
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now sauvegarde.timer
```

Test de restauration, une fois par mois :

```bash
export RESTIC_REPOSITORY=/mnt/sauvegarde/restic RESTIC_PASSWORD_FILE=/root/.restic-pass
sudo -E restic restore latest --target /root/test-restauration --include /opt/minecraft/fabric/world
sudo diff -rq /opt/minecraft/fabric/world /root/test-restauration/opt/minecraft/fabric/world | head
sudo -E restic check --read-data-subset=10%
sudo rm -rf /root/test-restauration
```

**Attendu** : peu ou pas de différences (seulement ce qui a changé depuis 04:30), `no errors were found`.
**Rollback** : `sudo systemctl disable --now sauvegarde.timer`.

## 12. Intégrité et audit

```bash
sudo apt install aide
printf '!/opt/minecraft\n!/opt/assetto\n!/srv/games\n!/var/lib/alerte\n' | sudo tee /etc/aide/aide.conf.d/99_garage
sudo aideinit
```

À vérifier selon la version : `aideinit` peut laisser la base dans `/var/lib/aide/aide.db.new`, à copier en `aide.db`. Le contrôle quotidien est un timer Debian (`systemctl list-timers | grep -i aide`) : ajoute-lui le même drop-in `OnFailure=alerte-echec@%n.service` qu'à l'étape 10. Après chaque mise à jour, AIDE signale les fichiers de `/usr` modifiés : c'est attendu, mets la base à jour (`sudo aide --update`, puis copie `aide.db.new` en `aide.db`).

En fin de parcours :

```bash
sudo lynis audit system --quick
sudo grep hardening_index /var/log/lynis-report.dat
```

**Attendu** : un score nettement au-dessus de celui de l'étape 0. Traite les avertissements (`warning[]`) avant les suggestions.

## 13. Box et DDNS

* UPnP désactivé : sinon un programme du LAN peut ouvrir un port tout seul, panel compris.
* Redirections limitées au tableau de l'étape 1 : jeux et 51820/udp. Ni 22, ni 4444, ni RCON.
* Mot de passe d'administration de la box changé, WPS désactivé, firmware à jour.
* OVH : si le script DDNS utilise une clé d'API, restreins ses droits à la seule zone DNS (à vérifier dans la console OVH), ou passe par un identifiant DynHost, limité à un sous-domaine. Le fichier qui contient ces identifiants doit être en 600.

## 14. Spécifique au portable

```bash
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/capot.conf >/dev/null <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Applique au prochain redémarrage (redémarrer `systemd-logind` coupe les sessions graphiques).

* **Chiffrement du disque** : LUKS se met en place à l'installation (« partitionnement assisté, LVM chiffré »). Convertir un système en place est risqué : prévois-le pour la prochaine réinstallation, après une sauvegarde testée. Avec LUKS, le redémarrage automatique de l'étape 9 attend la phrase de passe : désactive-le, ou installe `dropbear-initramfs` pour déverrouiller en SSH depuis le LAN.
* **BIOS/UEFI** : mot de passe administrateur, démarrage limité au disque interne.
* **Batterie** : elle sert d'onduleur, mais une batterie chargée en permanence à 100 % s'use et peut gonfler. Vérifie son état avec `upower -i $(upower -e | grep BAT)` et, si le BIOS Toshiba le propose, limite la charge (à vérifier).

## Checklist finale

```bash
sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin|allowusers) '
sudo ufw status verbose
sudo ss -Hltnp | grep -E ':(4444|22|2558[56]) '
sudo fail2ban-client status
systemctl show -p User minecraft-panel msh-fabric msh-paper assetto
systemd-analyze security msh-fabric assetto
sudo -l -U panel
systemctl list-timers alerte-ports.timer sauvegarde.timer
sudo grep hardening_index /var/log/lynis-report.dat
nc -vz -w 5 <ton-domaine-ddns> 4444   # depuis la 4G : doit échouer ; même test sur 25565 : doit réussir
```

## Risques résiduels

| Gravité | Risque | Pourquoi il reste | Ce qui limite les dégâts |
|---|---|---|---|
| Haute | Paper 1.17.1 exposé publiquement | Version sans support, plus de correctifs de sécurité | Utilise le dernier build 1.17.1 (correctif Log4Shell), migre dès que possible |
| Haute | Faille dans un mod, un plugin ou Wine | Les jeux sont publics par nature | Comptes dédiés, sandbox systemd, pas de sudo |
| Haute | Panel compromis | Il garde un accès root limité via `gp-service` et connaît les mots de passe RCON | LAN et WireGuard seulement, compte `panel` sans shell, sudo en liste fermée, Fail2ban |
| Moyenne | Vol du portable | Pas de LUKS tant que tu n'as pas réinstallé | Mot de passe BIOS, sauvegarde hors site |
| Moyenne | Logiciels hors dépôts Debian non mis à jour | unattended-upgrades ne couvre que Debian | Mise à jour manuelle de WineHQ, Node.js, jars et mods |
| Moyenne | Sauvegarde d'un monde en cours d'écriture | Pas de `save-off` avant restic | Sauvegarde à 04:30 (MSH a souvent arrêté le serveur), test mensuel |
| Faible | Serveurs `gp-*` qui partagent `gpgames` | Un seul compte pour tous les serveurs créés | Isolés du reste du système, pas entre eux |
| Faible | Alertes AIDE ignorées à force de bruit | Chaque mise à jour modifie `/usr` | Base mise à jour après chaque `apt upgrade` |
| Faible | Accès au compte OVH | Hors du serveur | Clé d'API restreinte, double authentification sur le compte |

## Sources

Les pages man sont la référence : elles correspondent à la version installée (`man 5 sshd_config`).

* SSH : `sshd_config(5)`, `sshd(8)`
* UFW : `ufw(8)`, `/etc/default/ufw`
* Fail2ban : `jail.conf(5)`, `fail2ban-client(1)`, `fail2ban-regex(1)`
* systemd : `systemd.exec(5)` (sandboxing, `UMask`), `systemd.unit(5)` (`OnFailure`), `systemd.timer(5)`, `systemd-analyze(1)`, `logind.conf(5)`
* Noyau : `sysctl.d(5)`, documentation du noyau `Documentation/networking/ip-sysctl.rst`
* PAM : `pam_exec(8)`
* WireGuard : `wg(8)`, `wg-quick(8)`
* restic : `restic(1)`, AIDE : `aide(1)`, `aide.conf(5)`

Liens officiels (non vérifiés en ligne au moment de la rédaction) :

* https://wiki.debian.org/UnattendedUpgrades
* https://www.debian.org/doc/manuals/securing-debian-manual/
* https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html
* https://www.wireguard.com/quickstart/
* https://docs.ntfy.sh/publish/
* https://restic.readthedocs.io/
* https://cisofy.com/documentation/lynis/
* https://www.cisecurity.org/benchmark/debian_linux
