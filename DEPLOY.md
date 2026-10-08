# Hosting auf Proxmox – sicher

Diese Anleitung setzt HamWeather in einem **unprivilegierten LXC-Container** auf Proxmox auf.
Ziel: Selbst wenn jemand die Webseite angreift, kommt er nicht an dein Heimnetz und nicht an den
Proxmox-Host.

## Warum die App selbst wenig Angriffsfläche hat

- **Keine Abhängigkeiten** (kein `npm install`) – keine fremden Pakete, die kompromittiert sein könnten.
- **Keine Datenbank, keine Logins, keine Formulare, keine Uploads** – Besucher können nichts eingeben
  ausser der URL.
- **Nur GET/HEAD**; alle anderen Methoden → 405. URLs über 2048 Zeichen → 414.
- **Feste Dateiliste**: Die Dateien aus `public/` werden beim Start in den Speicher geladen. Anfragen
  greifen nie aufs Dateisystem zu – Path Traversal ist ausgeschlossen (getestet).
- **Strenge Security-Header**: Content-Security-Policy (nur eigene Skripte, Styles, Bilder, Schriften),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP.
- **Daten aus dem Netz werden geprüft**: Grössenlimits pro Quelle, Zeitlimits, Formatprüfung,
  Ausgabe im Browser immer escaped.
- **Rate-Limit** (300 Anfragen pro Minute und IP) und Zeitlimits gegen langsame Verbindungen.
- **Keine Drittanbieter im Browser**: Schriften und Bilder kommen vom eigenen Server – Besucher-IPs
  gehen nicht an Google, NASA oder NOAA (auch datenschutzrechtlich sauber).
- Der Dienst läuft als eigener Benutzer ohne Rechte, mit systemd-Sandbox, darf seinen eigenen Code
  nicht verändern und ist nur auf `127.0.0.1` erreichbar.

Das grössere Risiko ist deshalb nicht die App, sondern **wie der Server ins Internet gehängt wird**.
Das regeln die folgenden Schritte.

---

## Die drei wichtigsten Regeln

1. **Die Proxmox-Weboberfläche (Port 8006) und SSH niemals ins Internet freigeben.**
   Für Fernzugriff ein VPN nutzen (WireGuard, Tailscale).
2. **Nur den Container erreichbar machen, nicht den Host** – und den Container vom restlichen
   Heimnetz trennen.
3. **Automatische Sicherheitsupdates einschalten** (Container *und* Proxmox-Host aktuell halten).

---

## Variante wählen

| | **A: Cloudflare Tunnel** (empfohlen) | **B: Portweiterleitung + Caddy** |
| --- | --- | --- |
| Ports am Router öffnen | keine | 80 und 443 |
| Heim-IP öffentlich sichtbar | nein | ja |
| DDoS-Schutz | ja (Cloudflare) | nein |
| Voraussetzung | Domain bei Cloudflare (Gratis-Plan genügt) | Domain + feste IP oder DynDNS |

Bei **A** gibt es keinen offenen Port in dein Heimnetz – der Container baut selbst eine ausgehende
Verbindung zu Cloudflare auf. Das ist die sicherste Lösung für zu Hause.

---

## 1. Container anlegen (Proxmox-Weboberfläche)

1. Vorlage herunterladen: *local → CT Templates → Templates* → **debian-13-standard**.
2. *Create CT*:
   - **Unprivileged container: ja** (Standard – nicht ändern!)
   - **Nesting: ja** (unter *Features*; nötig für die systemd-Sandbox des Dienstes)
   - Passwort sehr lang oder besser nur SSH-Schlüssel hinterlegen
   - 1 CPU-Kern, 512 MB RAM, 4 GB Disk reichen
   - Netzwerk: wenn möglich ein **eigenes VLAN / eine DMZ**, getrennt vom Heimnetz
3. *Firewall* des Containers aktivieren (*CT → Firewall → Options → Firewall: Yes*):
   - **Input Policy: DROP**
   - Variante A: keine weiteren Regeln nötig
   - Variante B: Regel *IN, ACCEPT, TCP, Port 80* und *IN, ACCEPT, TCP, Port 443*
   - Optional für die Verwaltung: *IN, ACCEPT, TCP 22* **nur aus dem eigenen LAN** (Source = LAN-Netz)

## 2. System vorbereiten (im Container als root)

```bash
apt update && apt full-upgrade -y
apt install -y nodejs git ca-certificates unattended-upgrades
node -v
```

`node -v` muss mindestens **v18** zeigen (Debian 13 liefert v20). Node aus den Debian-Paketen hat
den Vorteil, dass Sicherheitsupdates automatisch über `apt` kommen.

Automatische Sicherheitsupdates einschalten:

```bash
dpkg-reconfigure -plow unattended-upgrades
```

Eigenen Benutzer ohne Login anlegen:

```bash
useradd --system --user-group --home-dir /opt/hamweather --shell /usr/sbin/nologin hamweather
```

## 3. Code holen

Das Repository ist privat. Dafür einen **Deploy Key** (nur lesend) verwenden – kein persönliches
Passwort und kein Token mit Schreibrechten auf den Server legen.

```bash
ssh-keygen -t ed25519 -f /root/.ssh/hamweather_deploy -N "" -C "hamweather-deploy"
cat /root/.ssh/hamweather_deploy.pub
```

Den ausgegebenen Schlüssel auf GitHub eintragen: *Repository → Settings → Deploy keys → Add deploy key*,
**«Allow write access» NICHT ankreuzen**.

```bash
GIT_SSH_COMMAND="ssh -i /root/.ssh/hamweather_deploy" git clone git@github.com:carlos-ngi/hamweather.git /opt/hamweather
```

Beim ersten Verbinden fragt SSH nach dem Fingerabdruck von github.com. Vergleichen mit
<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints>.

Rechte setzen – der Dienst darf seinen Code lesen, aber **nicht verändern**:

```bash
chown -R root:hamweather /opt/hamweather
chmod -R u=rwX,g=rX,o= /opt/hamweather
```

## 4. Dienst einrichten

```bash
cp /opt/hamweather/deploy/hamweather.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hamweather
systemctl status hamweather
curl -s http://127.0.0.1:3000/healthz
```

Die letzte Zeile muss `ok` ausgeben.

> Startet der Dienst nicht und `journalctl -u hamweather` meldet `226/NAMESPACE`, ist beim Container
> *Nesting* nicht aktiviert (Schritt 1). Auf dem Proxmox-Host: `pct set <CT-ID> --features nesting=1`,
> dann Container neu starten.

## 5A. Veröffentlichen mit Cloudflare Tunnel (empfohlen)

1. Domain bei Cloudflare einrichten (Gratis-Plan).
2. Im Cloudflare-Dashboard: *Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared*.
3. Cloudflare zeigt Befehle für **Debian** an – diese im Container ausführen. Sie installieren
   `cloudflared` als Dienst.
4. *Public Hostname* hinzufügen: z. B. `wetter.deinedomain.ch`, Service **HTTP**, URL
   **`127.0.0.1:3000`**.
5. Im Cloudflare-Dashboard unter *SSL/TLS → Edge Certificates*: **Always Use HTTPS** und **HSTS**
   einschalten.

Am Router wird **nichts** freigegeben.

## 5B. Veröffentlichen mit Caddy (Portweiterleitung)

```bash
apt install -y caddy
cp /opt/hamweather/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile        # wetter.example.ch durch die eigene Domain ersetzen
systemctl reload caddy
```

- DNS: A-Eintrag (und ggf. AAAA) der Domain auf die öffentliche IP zeigen lassen.
- Router: **nur** TCP 80 und 443 an die IP des Containers weiterleiten.
- Caddy holt das HTTPS-Zertifikat automatisch und erneuert es selbst.

## 6. Prüfen

Im Container – es darf nur Caddy (Variante B) bzw. nichts (Variante A) öffentlich lauschen,
Node nur auf `127.0.0.1`:

```bash
ss -tlnp
```

Von aussen:

- <https://securityheaders.com> → Ziel: Note **A** oder besser
- <https://www.ssllabs.com/ssltest/> (Variante B) → Ziel: Note **A**

## 7. Aktualisieren

Betriebssystem: läuft automatisch (unattended-upgrades). Neue Version der Webseite:

```bash
cd /opt/hamweather
GIT_SSH_COMMAND="ssh -i /root/.ssh/hamweather_deploy" git pull
chown -R root:hamweather /opt/hamweather && chmod -R u=rwX,g=rX,o= /opt/hamweather
systemctl restart hamweather
```

## 8. Proxmox-Host absichern

- Host regelmässig aktualisieren (*Updates* in der Weboberfläche oder `apt full-upgrade`).
- **Zwei-Faktor-Anmeldung** für die Proxmox-Weboberfläche einrichten (*Datacenter → Permissions → Two Factor*).
- Port 8006 und SSH des Hosts nie am Router freigeben.
- Regelmässige Backups des Containers (*Datacenter → Backup*), am besten auf ein anderes Gerät.

---

## Was bleibt als Restrisiko?

Absolute Sicherheit gibt es nicht. Realistisch bleiben:

- **Sicherheitslücken in Node.js, Caddy oder Linux** – dagegen helfen die automatischen Updates.
- **Überlastung (DoS)** – das Rate-Limit fängt einzelne Störer ab; gegen grosse Angriffe hilft nur
  Cloudflare (Variante A).
- **Ausfall der Datenquellen** – dann zeigt die Seite die letzten Daten und einen Hinweis an.

Mit unprivilegiertem Container, getrenntem Netz, Sandbox und ohne offene Verwaltungsports wäre auch
eine unbekannte Lücke in der App auf diesen einen Container beschränkt.
