#!/bin/bash
echo "Arrêt d'Assetto Corsa..."

if systemctl is-active --quiet assetto; then
  sudo systemctl stop assetto
  echo "Assetto arrêté."
fi

echo "Attente arrêt complet..."
sleep 5

echo "Démarrage des serveurs Minecraft..."
sudo systemctl start msh-fabric
sudo systemctl start msh-paper
echo "Serveurs Minecraft démarrés sur les ports 25565 et 25566."
