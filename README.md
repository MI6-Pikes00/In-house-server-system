# 🎮 In-House Server System

Infrastructure home server multi-jeux tournant sur Debian, gérant deux serveurs Minecraft et un serveur Assetto Corsa, avec un panel web d'administration complet.

## 🖥️ Architecture

- **Minecraft Fabric 1.20+** — Serveur survival avec mods de performance (Lithium, Fabric API)
- **Minecraft Paper 1.17.1** — Serveur PvP avec ViaVersion (compatible jusqu'en 1.21+)
- **Assetto Corsa** — Serveur de simulation automobile via Wine
- **Panel web** — Interface Node.js/Express avec WebSockets pour la gestion en temps réel
- **MSH** — Démarrage à la demande, extinction automatique après inactivité
- **Bascule exclusive** — Scripts de basculement entre Minecraft et Assetto Corsa

## 📋 Fonctionnalités du panel

- Vue d'ensemble temps réel : bande mémoire par serveur, graphes CPU et température, disque, consommation, uptime
- Gestion des serveurs Minecraft (console RCON, joueurs et expulsion, config, whitelist, ops), état MSH « en veille »
- Assetto Corsa : console de logs, piste et configuration, voitures autorisées, upload de voitures et circuits (.zip)
- Bascule exclusive Minecraft ↔ Assetto Corsa
- Création de serveurs depuis le panel : Minecraft (Paper ou Fabric téléchargé automatiquement), Assetto Corsa, Le Mans Ultimate et Farming Simulator 17 (SteamCMD avec le compte qui possède le jeu), suivi de l'installation en direct
- Suppression des serveurs créés (service et dossier)
- Gestionnaire de fichiers par serveur : navigation, envoi (glisser-déposer, 2 Go max), téléchargement, création de dossiers, suppression
- Images des voitures et circuits Assetto Corsa dans les réglages
- Historique 30 minutes du CPU et de la température
- Journal des actions du panel, notifications toast
- Thème Auto / Nuit / Jour
- HTTPS avec certificat auto-signé

## ⚙️ Prérequis

- Debian 12 (Trixie) ou supérieur
- Node.js 20+
- Java 21 (OpenJDK)
- Wine 11+ (WineHQ stable)
- Git

## 🚀 Installation

### 1. Cloner le dépôt

```bash
git clone git@github.com:MI6-Pikes00/in-house-server-system.git
cd in-house-server-system
```

### 2. Configurer les fichiers sensibles

```bash
cp panel/config.json.example panel/config.json
cp panel/.env.example panel/.env
cp assetto/cfg/server_cfg.ini.example /opt/assetto/cfg/server_cfg.ini
```

Édite chaque fichier pour y mettre tes vraies valeurs.

### 3. Installer les dépendances Node.js

```bash
cd panel
npm install
```

### 4. Générer les certificats SSL

```bash
mkdir -p panel/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout panel/ssl/key.pem \
  -out panel/ssl/cert.pem \
  -subj "/C=FR/ST=France/L=Paris/O=LiteCorps/CN=192.168.0.55"
```

### 5. Installer les services systemd

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable msh-fabric msh-paper minecraft-panel assetto
sudo systemctl start msh-fabric msh-paper minecraft-panel
```

### 6. Rendre les scripts exécutables

```bash
sudo cp scripts/switch-to-assetto.sh /usr/local/bin/
sudo cp scripts/switch-to-minecraft.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/switch-to-assetto.sh
sudo chmod +x /usr/local/bin/switch-to-minecraft.sh
```

### 7. Création de serveurs depuis le panel

Les serveurs créés vivent dans `/srv/games/<id>` et tournent via des unités `gp-<id>` sous l'utilisateur du panel. Le script `gp-service` est le seul appel root.

```bash
sudo install -m 755 scripts/gp-service.sh /usr/local/bin/gp-service
echo 'user ALL=(root) NOPASSWD: /usr/local/bin/gp-service' | sudo tee /etc/sudoers.d/gp-service
sudo visudo -c
```

Pour Assetto Corsa, Le Mans Ultimate et Farming Simulator 17, installe SteamCMD (`sudo apt install steamcmd`, dépôt non-free, i386 activé) et Wine. Le compte Steam, son mot de passe et le code Steam Guard sont demandés à l'installation et ne sont pas enregistrés.

Les app IDs Steam et les exécutables sont réglables dans `config.json` :

```json
"steamcmd": "/usr/games/steamcmd",
"games": {
  "ac":  { "steamAppId": 302550, "platform": "linux",   "exe": "acServer", "contentDir": "/opt/assetto/content" },
  "lmu": { "steamAppId": null,   "platform": "windows", "exe": "LMU Dedicated.exe" },
  "fs":  { "steamAppId": 447020, "platform": "windows", "exe": "dedicatedServer.exe" }
}
```

L'app ID du serveur dédié Le Mans Ultimate n'est pas renseigné : sans lui, le serveur est créé vide et tu déposes ses fichiers dans l'onglet Fichiers.

## 📄 Licence

Projet personnel — usage libre pour inspiration.
