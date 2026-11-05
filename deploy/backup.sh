#!/bin/sh
# Backup diário do banco (cópia consistente com o sistema rodando) e das evidências. Guarda 30 dias.
set -e
umask 077  # backups têm dados pessoais e a senha do e-mail: só root lê
DATA=${DATA_DIR:-/opt/motoboys/data}
DEST=${BACKUP_DIR:-/var/backups/motoboys}
DIA=$(date +%F)
mkdir -p "$DEST"
rm -f "$DEST/motoboys-$DIA.db"
node -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\")" \
  "$DATA/motoboys.db" "$DEST/motoboys-$DIA.db"
tar czf "$DEST/evidencias-$DIA.tgz" -C "$DATA" uploads
find "$DEST" -type f -mtime +30 -delete
