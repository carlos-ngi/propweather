# PropWeather

Solar-terrestrische Daten und Ausbreitungsbedingungen für Funkamateure – inhaltlich wie
[hamqsl.com](https://www.hamqsl.com/solar.html), gestaltet in der Formensprache von
[sph.ethz.ch](https://sph.ethz.ch/). Zweisprachig: **Deutsch** und **Englisch**.

*Solar-terrestrial data and propagation conditions for radio amateurs, similar to hamqsl.com.
Available in German and English. No dependencies – just Node.js.*

## Starten

Benötigt nur Node.js ≥ 18, keine weiteren Pakete.

```bash
npm start
```

Danach im Browser: <http://localhost:3000>

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Port |
| `HOST` | `127.0.0.1` | Adresse; nur lokal erreichbar, für den Betrieb hinter einem Reverse-Proxy gedacht |
| `TRUST_PROXY` | – | `1`, wenn Caddy/nginx/cloudflared davor steht (echte Besucher-IP für das Rate-Limit) |
| `RATE_LIMIT` | `300` | Anfragen pro Minute und IP |
| `OPERATOR_FILE` | `./operator.json` | Angaben für Impressum und Datenschutz (siehe [DEPLOY.md](DEPLOY.md)) |

**Hosting auf Proxmox:** siehe [DEPLOY.md](DEPLOY.md).

## Sprache

Die Sprache wird automatisch aus den Browsereinstellungen gewählt und lässt sich oben rechts
(DE / EN) umschalten; die Wahl wird im Browser gespeichert. Direkt verlinken mit `?lang=de` bzw.
`?lang=en`. Alle Texte stehen in [`public/i18n.js`](public/i18n.js), die längeren Erklärungen
in [`public/index.html`](public/index.html) (Blöcke mit `data-lang`).

## Inhalt

| Bereich | Daten | Quelle |
| --- | --- | --- |
| Aktuelle Werte | SFI, Sonnenflecken, A, K, Röntgen, 304 Å, Sonnenwind, Bz, Protonen-/Elektronenfluss, Aurora | N0NBH (hamqsl.com XML-Feed) |
| Live-Ergänzungen | aktueller Kp, GOES-Röntgenklasse, letzter Flare, Sonnenwind und Bz in Echtzeit | NOAA SWPC |
| KW-Bänder | Bandbedingungen Tag/Nacht, geomagnetisches Feld, Störpegel, MUF, foF2 | N0NBH |
| VHF | Aurora, E-Skip Europa 6 m / 4 m / 2 m, Nordamerika 2 m | N0NBH |
| NOAA-Skalen | R/S/G aktuell und 3-Tage-Prognose | NOAA SWPC |
| Verlauf | Kp (beobachtet + Prognose), Röntgenfluss 24 h, Sonnenwind 24 h, Bz/Bt 24 h | NOAA SWPC |
| Bilder | GOES/SUVI 304 Å und 195 Å, SDO/HMI, SOHO/LASCO C3, Polarlicht-Oval, D-RAP | NOAA, NASA, ESA |

## Aufbau

```
server.js            Node-Server: statische Dateien, /api/data, /img/<id>, /healthz
public/index.html    Seite (inkl. Erklärungen DE/EN)
public/impressum.html, public/datenschutz.html
                     Impressum und Datenschutzerklärung (DE/EN, Betreiberdaten aus operator.json)
public/i18n.js       Texte Deutsch/Englisch
public/lang.js       Sprachwahl (gemeinsam für alle Seiten)
public/app.js        Darstellung, Diagramme (SVG, ohne Bibliotheken), Auto-Refresh
public/legal.js      Sprachwahl für Impressum und Datenschutz
operator.example.json  Vorlage für operator.json (nicht im Repository)
public/styles.css    Gestaltung
public/fonts/        League Gothic und Figtree (SIL Open Font License)
deploy/              systemd-Dienst und Caddy-Konfiguration
```

Der Server ist nötig, weil der hamqsl.com-Feed keine CORS-Header sendet und die
NOAA-Sonnenwinddateien mehrere MB gross sind. Er fasst die Messreihen zu 5- bzw. 10-Minuten-Werten
zusammen und liefert alles als eine kompakte JSON-Antwort. Bilder und Schriften kommen ebenfalls
vom eigenen Server, damit Besucher keine Drittanbieter kontaktieren.

Abfrageintervalle: hamqsl.com **höchstens stündlich** (so wünscht es N0NBH), NOAA alle 5–10 Minuten,
Bilder alle 10 Minuten. Fällt eine Quelle aus, werden die zuletzt geladenen Daten weiter angezeigt
und die Seite weist darauf hin. Bilder, die älter als 6 Stunden sind, werden als «Veraltet» markiert.

## Rechtliches

- **Impressum** und **Datenschutzerklärung** (DE/EN) sind enthalten; die Betreiberdaten kommen aus
  `operator.json`.
- Die Webseite setzt keine Cookies, verwendet kein Tracking und lädt keine Inhalte von Drittanbietern.
- Die Bildnachweise entsprechen den Vorgaben von NASA/SDO und SOHO (ESA & NASA). Die SOHO-Bilder
  sind für nicht kommerzielle Nutzung freigegeben – bei Werbung oder anderen kommerziellen Zwecken
  neu prüfen.

## Quellen

- Solar-terrestrische Daten und Bandbedingungen: Paul Herrman, N0NBH – <https://www.hamqsl.com/>
- NOAA Space Weather Prediction Center – <https://www.swpc.noaa.gov/>
- NOAA GOES/SUVI, NASA/SDO (HMI), ESA/NASA SOHO (LASCO)
- Schriften: [League Gothic](https://github.com/theleagueof/league-gothic) und
  [Figtree](https://github.com/erikdkennedy/figtree), SIL Open Font License 1.1

Alle Angaben ohne Gewähr.
