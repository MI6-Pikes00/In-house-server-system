#!/bin/bash
echo "Arrêt des serveurs Minecraft..."

if systemctl is-active --quiet msh-fabric; then
  sudo systemctl stop msh-fabric
  echo "msh-fabric arrêté."
fi

if systemctl is-active --quiet msh-paper; then
  sudo systemctl stop msh-paper
  echo "msh-paper arrêté."
fi

echo "Attente arrêt complet..."
sleep 5

echo "Démarrage d'Assetto Corsa..."
sudo systemctl start assetto
echo "Assetto Corsa démarré. Serveur disponible sur le port 9603."
