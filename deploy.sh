#!/bin/bash
# Baut das Image lokal, lädt es per SSH auf den Docker-Host (z. B. Unraid) und startet den Container neu.
# Daten bleiben erhalten. Einstellungen stehen in deploy.env (Vorlage: deploy.env.example).
set -euo pipefail
cd "$(dirname "$0")"
[ -f deploy.env ] || { echo "deploy.env fehlt. Kopiere deploy.env.example und trage deinen Server ein."; exit 1; }
source deploy.env
: "${DEPLOY_SSH:?in deploy.env setzen}" "${DEPLOY_URL:?in deploy.env setzen}"
PORT="${DEPLOY_PORT:-8095}"; DATA="${DEPLOY_DATA:-/mnt/user/appdata/vorrat}"; ZONE="${DEPLOY_TZ:-Europe/Berlin}"
docker build -q -t vorrat:latest .
docker save vorrat:latest | gzip -1 | $DEPLOY_SSH 'gunzip | docker load'
$DEPLOY_SSH "docker rm -f Vorrat 2>/dev/null; mkdir -p $DATA && chown 99:100 $DATA && chmod 700 $DATA &&
docker run -d --name Vorrat --user=99:100 --restart=unless-stopped --cap-drop=ALL --security-opt=no-new-privileges \
  -p $PORT:8080 -v $DATA:/data -e TZ=$ZONE \
  -l net.unraid.docker.managed=dockerman -l net.unraid.docker.icon=$DEPLOY_URL/icon-192.png -l 'net.unraid.docker.webui=http://[IP]:[PORT:8080]/' \
  vorrat:latest && docker image prune -f >/dev/null"
echo "Fertig: $DEPLOY_URL/"
