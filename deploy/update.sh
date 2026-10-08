#!/usr/bin/env bash
# Holt die neueste Version von GitHub und startet PropWeather neu. Als root ausführen:
#
#   bash /opt/propweather/deploy/update.sh

set -euo pipefail

APP_DIR=/opt/propweather
APP_USER=propweather
KEY=/root/.ssh/propweather_deploy

if [[ $EUID -ne 0 ]]; then
  echo "Bitte als root ausführen." >&2
  exit 1
fi

cd "$APP_DIR"
echo "==> Neueste Version holen"
GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes" git pull --ff-only

echo "==> Rechte setzen"
chown -R root:"$APP_USER" "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"

echo "==> Dienst neu starten"
install -m 644 "$APP_DIR/deploy/propweather.service" /etc/systemd/system/propweather.service
systemctl daemon-reload
systemctl restart propweather

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "OK – PropWeather läuft ($(git log -1 --format='%h %s'))"
    exit 0
  fi
  sleep 1
done
echo "FEHLER: Der Dienst antwortet nicht. Details: journalctl -u propweather -n 50" >&2
exit 1
