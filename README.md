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

- Dashboard temps réel (RAM, CPU, température, disque, uptime)
- Graphiques sparkline RAM/CPU avec historique 30 minutes
- Gestion des serveurs Minecraft (console, config, whitelist, ops)
- Navigateur Assetto Corsa avec images des voitures et circuits
- Upload de mods AC par drag and drop
- Bascule exclusive Minecraft ↔ Assetto Corsa avec popup de chargement
- Notifications toast et journal d'activité récente
- Dark/Light mode
- Dashboard personnalisable (widgets activables/désactivables)
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

## 📄 Licence

Projet personnel — usage libre pour inspiration.
