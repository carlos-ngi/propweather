#!/usr/bin/env bash
# Richtet PropWeather im Container ein (Debian 12/13). Als root ausführen,
# nachdem das Repository nach /opt/propweather geklont wurde:
#
#   bash /opt/propweather/deploy/install.sh
#
# Das Skript kann gefahrlos mehrmals ausgeführt werden.

set -euo pipefail

APP_DIR=/opt/propweather
APP_USER=propweather

if [[ $EUID -ne 0 ]]; then
  echo "Bitte als root ausführen." >&2
  exit 1
fi
if [[ ! -f $APP_DIR/server.js ]]; then
  echo "$APP_DIR/server.js fehlt – zuerst das Repository nach $APP_DIR klonen (siehe DEPLOY.md)." >&2
  exit 1
fi

echo "==> Pakete installieren"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs ca-certificates curl unattended-upgrades

node_major=$(node -p 'process.versions.node.split(".")[0]')
if (( node_major < 18 )); then
  echo "Node.js $node_major ist zu alt – mindestens Version 18 nötig." >&2
  exit 1
fi
echo "    Node.js $(node -v)"

echo "==> Automatische Sicherheitsupdates einschalten"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "==> Benutzer $APP_USER anlegen"
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --user-group --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Rechte setzen (Dienst darf lesen, aber nichts verändern)"
chown -R root:"$APP_USER" "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"

if [[ ! -f $APP_DIR/operator.json ]]; then
  echo "    WARNUNG: operator.json fehlt – Impressum und Datenschutz zeigen Beispieldaten."
fi

echo "==> Dienst einrichten und starten"
install -m 644 "$APP_DIR/deploy/propweather.service" /etc/systemd/system/propweather.service
systemctl daemon-reload
systemctl enable propweather >/dev/null
systemctl restart propweather

echo "==> Prüfen"
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo
    echo "OK – PropWeather läuft auf http://127.0.0.1:3000"
    echo "Weiter mit Teil 3 in DEPLOY.md (Cloudflare Tunnel)."
    exit 0
  fi
  sleep 1
done

echo >&2
echo "FEHLER: Der Dienst antwortet nicht." >&2
journalctl -u propweather -n 30 --no-pager >&2 || true
echo >&2
echo "Steht oben «31/SYS», blockiert die Sandbox einen Systemaufruf – Fehlermeldung an den Entwickler schicken." >&2
echo "Steht oben «226/NAMESPACE», ist beim Container «Nesting» nicht aktiviert." >&2
echo "Auf dem Proxmox-Host: pct set <CT-ID> --features nesting=1  und Container neu starten." >&2
exit 1
