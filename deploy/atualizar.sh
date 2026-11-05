#!/bin/sh
# Atualiza o sistema a partir do GitHub quando há commit novo. Roda a cada minuto pelo cron.
# O banco (data/) não é versionado e nunca é tocado. Sai em silêncio se não houver nada novo.
set -e
cd /opt/motoboys
RAMO=${RAMO:-main}
git fetch -q origin "$RAMO"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$RAMO")" ] && exit 0
git reset -q --hard "origin/$RAMO"
npm ci --omit=dev --silent
if [ "$(id -u)" = 0 ]; then systemctl restart motoboys; else sudo systemctl restart motoboys; fi
echo "$(date '+%F %T') atualizado para $(git rev-parse --short HEAD)"
