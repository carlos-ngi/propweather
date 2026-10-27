# PropWeather auf Proxmox mit Cloudflare Tunnel

So kommt PropWeather sicher von deinem Proxmox-Server unter **https://propweather.org** ins Internet.

```
Besucher ──HTTPS──▶ Cloudflare ◀──Tunnel (ausgehend)── Container «propweather» auf Proxmox
                                                        cloudflared ──▶ Node.js auf 127.0.0.1:3000
```

Der Container baut die Verbindung zu Cloudflare **selbst** auf. Am Router wird **kein Port geöffnet**,
und deine Heim-IP bleibt verborgen.

Zeitaufwand: etwa 30–45 Minuten. Kosten: keine (Cloudflare Free-Plan).

---

## Teil 1 – Container in Proxmox anlegen

Alles in der Proxmox-Weboberfläche.

### 1.1 Vorlage herunterladen

Links deinen Server aufklappen → Speicher **local** → **CT Templates** → **Templates** →
`debian-13-standard` auswählen → **Download**.

### 1.2 Container erstellen

Oben rechts **Create CT**:

| Reiter | Einstellung |
| --- | --- |
| General | Hostname `propweather` · **Unprivileged container: ✓** (nicht abwählen!) · **Nesting: ✓** · langes Passwort |
| Template | `debian-13-standard` |
| Disks | 4 GB |
| CPU | 1 Kern |
| Memory | 512 MiB, Swap 512 MiB |
| Network | Bridge wie deine anderen VMs (oder ein eigenes VLAN/DMZ, falls vorhanden) · IPv4: **DHCP** · **Firewall: ✓** |
| DNS | unverändert lassen |
| Confirm | **Start after created: ✓** |

Danach: Container auswählen → **Options** → **Start at boot: Yes**, damit die Seite nach einem
Neustart des Servers wieder läuft.

### 1.3 Firewall

Mit Cloudflare Tunnel braucht der Container **keine einzige eingehende Verbindung**. Darum alles
Eingehende sperren:

1. **Datacenter → Firewall → Options → Firewall: Yes.**
   Proxmox lässt den Zugriff auf die Weboberfläche (8006) und SSH aus deinem lokalen Netz
   automatisch weiter zu. Diesen Schritt trotzdem **aus dem Heimnetz** machen, nicht über VPN.
   (Falls du dich aussperrst: an der Konsole des Hosts `pve-firewall stop`.)
2. **Container propweather → Firewall → Options:** Firewall **Yes**, Input Policy **DROP**,
   Output Policy **ACCEPT**. Es sind keine Regeln nötig.

Antworten auf ausgehende Verbindungen (Updates, Datenquellen, Cloudflare) erlaubt die Firewall
automatisch.

---

## Teil 2 – PropWeather im Container installieren

Container auswählen → **Console** → als `root` anmelden.

> Im Container bist du bereits root. Befehle **ohne `sudo`** eingeben – `sudo` ist in der
> Debian-Vorlage gar nicht installiert.

### 2.1 System aktualisieren und Git installieren

```bash
apt update && apt full-upgrade -y && apt install -y git
```

### 2.2 Code holen und installieren

```bash
git clone https://github.com/carlos-ngi/propweather.git /opt/propweather
bash /opt/propweather/deploy/install.sh
```

Das Skript installiert Node.js, schaltet automatische Sicherheitsupdates ein, legt den
Benutzer `propweather` ohne Login an, setzt die Rechte, richtet den abgesicherten Dienst ein und
prüft, ob er läuft. Am Ende muss stehen:

```
OK – PropWeather läuft auf http://127.0.0.1:3000
```

---

## Teil 3 – Cloudflare Tunnel einrichten

Alles auf <https://dash.cloudflare.com>. Die Domain `propweather.org` ist bereits bei Cloudflare
registriert und nutzt die Cloudflare-Nameserver – hier ist nichts mehr zu tun.

### 3.1 Tunnel erstellen

1. Links **Zero Trust** öffnen. Beim ersten Mal fragt Cloudflare nach einem Teamnamen (beliebig)
   und einem Plan: **Free** wählen. Möglicherweise muss eine Zahlungsart hinterlegt werden – beim
   Free-Plan wird nichts belastet.
2. **Networks → Tunnels → Create a tunnel** → Typ **Cloudflared** → Name `propweather` → **Save**.
3. Bei *Choose your environment*: **Debian**, **64-bit**. Cloudflare zeigt zwei Befehlsblöcke an.
   Beide in der Container-Konsole ausführen – **jeweils ohne das Wort `sudo`**.
   Der zweite Befehl (`cloudflared service install …`) enthält deinen geheimen Tunnel-Schlüssel:
   nirgends sonst einfügen oder weitergeben.
4. Unten im Dashboard erscheint der Container als **Connected** → **Next**.

### 3.2 Domain mit dem Tunnel verbinden

Unter **Public Hostnames** (in neueren Versionen: *Published application routes*):

| Feld | Wert |
| --- | --- |
| Subdomain | *(leer lassen)* |
| Domain | `propweather.org` |
| Path | *(leer lassen)* |
| Service Type | **HTTP** |
| URL | `127.0.0.1:3000` |

**Save**. Cloudflare legt den DNS-Eintrag selbst an.

> Meldet Cloudflare «record already exists», unter **propweather.org → DNS → Records** den
> vorhandenen Eintrag für `propweather.org` löschen und erneut speichern.

### 3.3 `www.propweather.org` (empfohlen)

1. Einen zweiten Public Hostname anlegen: Subdomain `www`, sonst gleich wie oben.
2. **propweather.org → Rules → Redirect Rules → Create rule → Templates →
   «Redirect from WWW to root»** → **Deploy**. So landen alle auf derselben Adresse.

### 3.4 HTTPS erzwingen

**propweather.org → SSL/TLS → Edge Certificates:**

- **Always Use HTTPS: On**
- **HTTP Strict Transport Security (HSTS): Enable** → Max Age **6 months**, die übrigen Optionen aus
- **Minimum TLS Version: TLS 1.2**

---

## Teil 4 – E-Mail-Adresse info@propweather.org

Damit die Adresse aus dem Impressum funktioniert, leitet Cloudflare Mails kostenlos an dein
persönliches Postfach weiter. Cloudflare speichert die Inhalte dabei nicht.

1. **propweather.org → Email → Email Routing → Get started**.
2. Custom address: `info` · Action: **Send to an email** · Destination: deine persönliche Adresse.
3. Cloudflare schickt eine Bestätigungsmail an diese Adresse – Link anklicken.
4. **Add records and enable** – Cloudflare trägt die nötigen DNS-Einträge (MX, SPF) selbst ein.
5. Testen: von einem anderen Konto eine Mail an `info@propweather.org` senden.

Hinweis: Email Routing leitet nur **eingehende** Mails weiter. Antwortest du, geschieht das von
deiner persönlichen Adresse aus.

---

## Teil 5 – Prüfen

- <https://propweather.org> öffnen – Werte, Diagramme und Bilder erscheinen.
- Impressum und Datenschutz unten auf der Seite: deine Angaben, **kein** roter Hinweis «Beispieldaten».
- Im Container: `ss -tlnp` – Node darf nur auf `127.0.0.1:3000` lauschen, sonst nichts nach aussen.
- <https://securityheaders.com/?q=propweather.org> → Ziel: Note **A** oder besser.

---

## Betrieb

### Neue Version einspielen

Um die neueste Version von GitHub zu übernehmen, in der Container-Konsole:

```bash
bash /opt/propweather/deploy/update.sh
```

### Angaben im Impressum ändern

Die Angaben stehen in [`operator.json`](operator.json):

| Feld | Inhalt |
| --- | --- |
| `name`, `country` | Name und Land |
| `street`, `postcode`, `city` | Postadresse (optional – leer lassen, um sie nicht anzuzeigen) |
| `email` | öffentliche Kontaktadresse |
| `emailViaCloudflare` | `true`, solange die Adresse über Cloudflare Email Routing läuft (steht dann in der Datenschutzerklärung) |
| `callsign` | Rufzeichen (leer = nicht anzeigen) |
| `hosting` | `"cloudflare"` oder `"caddy"` – muss zur tatsächlichen Variante passen, sonst ist die Datenschutzerklärung falsch |
| `serverCountry` | Land, in dem der Server steht |

Datei ändern, pushen, dann `update.sh` ausführen. Ist die Datei fehlerhaft, startet der Dienst
nicht und `journalctl -u propweather` nennt das Feld.

### Nützliche Befehle

```bash
systemctl status propweather        # läuft der Dienst?
journalctl -u propweather -n 50     # letzte Meldungen
systemctl status cloudflared        # läuft der Tunnel?
```

### Proxmox-Host absichern

- Host regelmässig aktualisieren (*Updates* in der Weboberfläche).
- **Zwei-Faktor-Anmeldung** für die Weboberfläche (*Datacenter → Permissions → Two Factor*).
- Port 8006 und SSH des Hosts **nie** am Router freigeben. Für Fernzugriff ein VPN (WireGuard, Tailscale).
- Backups des Containers (*Datacenter → Backup → Add*, z. B. wöchentlich), möglichst auf ein anderes Gerät.

---

## Warum das sicher ist

**Die App:**

- Keine Abhängigkeiten (kein `npm install`), keine Datenbank, keine Logins, keine Formulare, keine Uploads.
- Nur GET/HEAD; feste Dateiliste im Speicher – Anfragen greifen nie aufs Dateisystem zu.
- Strenge Security-Header (Content-Security-Policy, `X-Frame-Options`, `nosniff`, …).
- Daten aus dem Netz werden auf Grösse, Zeit und Format geprüft; Ausgabe immer escaped.
- Rate-Limit (300 Anfragen pro Minute und IP), Zeitlimits gegen langsame Verbindungen.

**Der Betrieb:**

- Unprivilegierter Container: selbst mit Root im Container kein Root auf dem Host.
- Dienst als eigener Benutzer ohne Rechte, in einer systemd-Sandbox, darf seinen Code nicht ändern,
  lauscht nur auf `127.0.0.1`.
- Keine offenen Ports am Router; die Firewall sperrt alles Eingehende; Cloudflare filtert Angriffe.
- Sicherheitsupdates laufen automatisch.

**Restrisiko:** Lücken in Node.js, cloudflared oder Linux – dagegen helfen die automatischen Updates.
Selbst eine unbekannte Lücke in der App bliebe auf diesen einen Container beschränkt.

---

## Anhang – Variante ohne Cloudflare (Caddy + Portweiterleitung)

Nur falls du später auf Cloudflare verzichten willst. Dann in `operator.json`
`"hosting": "caddy"` und `"emailViaCloudflare": false` setzen.

```bash
apt install -y caddy
cp /opt/propweather/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

- DNS: A-Eintrag (und ggf. AAAA) für `propweather.org` und `www` auf die öffentliche IP.
- Router: **nur** TCP 80 und 443 an die IP des Containers weiterleiten; in der Container-Firewall
  *IN ACCEPT TCP 80* und *IN ACCEPT TCP 443* ergänzen.
- Caddy holt das HTTPS-Zertifikat automatisch.
