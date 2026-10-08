'use strict';

// PropWeather – kleiner Server ohne Abhängigkeiten.
//
// - liefert die statische Seite aus /public (feste Dateiliste, beim Start geladen)
// - bündelt die Datenquellen unter /api/data (N0NBH/hamqsl.com XML + NOAA SWPC JSON)
// - liefert die Bilder über /img/<id> aus, damit Besucher keine Drittserver kontaktieren
//
// Der Proxy ist nötig, weil hamqsl.com keine CORS-Header sendet und die
// NOAA-Sonnenwinddateien mehrere MB gross sind.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
// Nur setzen, wenn ein Reverse-Proxy (Caddy, nginx) davor steht und X-Forwarded-For setzt.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 300; // Anfragen pro Minute und IP

const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'PropWeather/1.2 (solar-terrestrial dashboard for radio amateurs)';
const FETCH_TIMEOUT_MS = 20_000;
const MIN = 60_000;
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

class SourceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseUtc(s) {
  if (typeof s !== 'string') return NaN;
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`);
}

function toNumber(s) {
  if (s === null || s === undefined) return null;
  const n = parseFloat(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function round(n, digits) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]).trim() : null;
}

// Zeichenketten aus dem Feed kürzen – schützt vor unerwartet grossen Inhalten
const clip = (s, max = 40) => (typeof s === 'string' ? s.slice(0, max) : s);

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// " 08 Oct 2026 0653 GMT" -> ISO-String
function parseHamqslDate(s) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2})(\d{2})\s*GMT/.exec(s || '');
  if (!m || !(m[2] in MONTHS)) return null;
  return new Date(Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5])).toISOString();
}

// Mittelwert (oder Maximum) pro Zeitfenster
function binSeries(points, binMs, fields, mode = 'mean') {
  const bins = new Map();
  for (const p of points) {
    const key = Math.floor(p.t / binMs) * binMs;
    let b = bins.get(key);
    if (!b) {
      b = { t: key };
      for (const f of fields) b[f] = { sum: 0, n: 0, max: -Infinity };
      bins.set(key, b);
    }
    for (const f of fields) {
      const v = p[f];
      if (!Number.isFinite(v)) continue;
      b[f].sum += v;
      b[f].n += 1;
      if (v > b[f].max) b[f].max = v;
    }
  }
  return [...bins.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => {
      const out = { t: new Date(b.t).toISOString() };
      for (const f of fields) {
        const { sum, n, max } = b[f];
        out[f] = n === 0 ? null : mode === 'max' ? max : sum / n;
      }
      return out;
    });
}

// Antwort lesen, aber höchstens maxBytes – schützt vor zu grossen Antworten
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SourceError('too_large');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SourceError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
}

async function upstream(url, { method = 'GET', accept = '*/*' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SourceError(err.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new SourceError(`http_${res.status}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Parser für die einzelnen Quellen
// ---------------------------------------------------------------------------

function parseHamqsl(xml) {
  if (!xml.includes('<solardata>')) throw new SourceError('invalid');

  const bands = [...xml.matchAll(/<band\s+name="([^"]+)"\s+time="([^"]+)"\s*>([^<]*)<\/band>/g)]
    .slice(0, 20)
    .map((m) => ({ name: clip(decodeXml(m[1])), time: clip(decodeXml(m[2])), condition: clip(decodeXml(m[3]).trim()) }));

  const vhf = [...xml.matchAll(/<phenomenon\s+name="([^"]+)"\s+location="([^"]+)"\s*>([^<]*)<\/phenomenon>/g)]
    .slice(0, 20)
    .map((m) => ({ name: clip(decodeXml(m[1])), location: clip(decodeXml(m[2])), condition: clip(decodeXml(m[3]).trim()) }));

  const updatedRaw = xmlTag(xml, 'updated');
  const str = (name) => {
    const v = xmlTag(xml, name);
    return v === null || v === '' ? null : clip(v);
  };

  return {
    updatedRaw: clip(updatedRaw),
    updated: parseHamqslDate(updatedRaw),
    solarFlux: toNumber(xmlTag(xml, 'solarflux')),
    aIndex: toNumber(xmlTag(xml, 'aindex')),
    kIndex: toNumber(xmlTag(xml, 'kindex')),
    xray: str('xray'),
    sunspots: toNumber(xmlTag(xml, 'sunspots')),
    heliumLine: toNumber(xmlTag(xml, 'heliumline')),
    protonFlux: toNumber(xmlTag(xml, 'protonflux')),
    // Der Feed schreibt das Tag tatsächlich "electonflux"
    electronFlux: toNumber(xmlTag(xml, 'electonflux') ?? xmlTag(xml, 'electronflux')),
    aurora: toNumber(xmlTag(xml, 'aurora')),
    latDegree: toNumber(xmlTag(xml, 'latdegree')),
    solarWind: toNumber(xmlTag(xml, 'solarwind')),
    bz: toNumber(xmlTag(xml, 'magneticfield')),
    geomagField: str('geomagfield'),
    signalNoise: str('signalnoise'),
    fof2: str('fof2'),
    mufFactor: str('muffactor'),
    muf: str('muf'),
    bands,
    vhf,
  };
}

function parseKp(rows) {
  if (!Array.isArray(rows)) throw new SourceError('invalid');
  return rows
    .map((r) => ({
      t: new Date(parseUtc(r.time_tag)).toISOString(),
      kp: toNumber(r.kp),
      kind: ['observed', 'estimated', 'predicted'].includes(r.observed) ? r.observed : 'observed',
      scale: typeof r.noaa_scale === 'string' && /^G[1-5]$/.test(r.noaa_scale) ? r.noaa_scale : null,
    }))
    .filter((r) => r.kp !== null && r.kp >= 0 && r.kp <= 9);
}

function parseXray(rows) {
  if (!Array.isArray(rows)) throw new SourceError('invalid');
  const points = rows
    .filter((r) => r.energy === '0.1-0.8nm' && Number.isFinite(r.flux) && r.flux > 0)
    .map((r) => ({ t: parseUtc(r.time_tag), flux: r.flux }))
    .filter((p) => Number.isFinite(p.t));
  // 5-Minuten-Maximum, damit kurze Flares sichtbar bleiben
  return binSeries(points, 5 * MIN, ['flux'], 'max');
}

function latestActive(rows, field) {
  let best = null;
  for (const r of rows) {
    if (!r.active || !Number.isFinite(r[field])) continue;
    const t = parseUtc(r.time_tag);
    if (!Number.isFinite(t)) continue;
    if (!best || t > best.t) best = { t, value: r[field] };
  }
  return best ? { t: new Date(best.t).toISOString(), value: best.value } : null;
}

function parseWind(rows) {
  if (!Array.isArray(rows)) throw new SourceError('invalid');
  const points = rows
    .filter((r) => r.active)
    .map((r) => ({ t: parseUtc(r.time_tag), speed: r.proton_speed, density: r.proton_density }))
    .filter((p) => Number.isFinite(p.t));
  return {
    series: binSeries(points, 10 * MIN, ['speed', 'density']).map((p) => ({
      t: p.t,
      speed: round(p.speed, 0),
      density: round(p.density, 2),
    })),
    latest: {
      speed: latestActive(rows, 'proton_speed'),
      density: latestActive(rows, 'proton_density'),
    },
  };
}

function parseMag(rows) {
  if (!Array.isArray(rows)) throw new SourceError('invalid');
  const points = rows
    .filter((r) => r.active)
    .map((r) => ({ t: parseUtc(r.time_tag), bz: r.bz_gsm, bt: r.bt }))
    .filter((p) => Number.isFinite(p.t));
  return {
    series: binSeries(points, 10 * MIN, ['bz', 'bt']).map((p) => ({
      t: p.t,
      bz: round(p.bz, 2),
      bt: round(p.bt, 2),
    })),
    latest: {
      bz: latestActive(rows, 'bz_gsm'),
      bt: latestActive(rows, 'bt'),
    },
  };
}

const SCALE_WORDS = ['none', 'minor', 'moderate', 'strong', 'severe', 'extreme'];

function parseScales(obj) {
  if (!obj || typeof obj !== 'object' || !obj['0']) throw new SourceError('invalid');
  const word = (s) => (typeof s === 'string' && SCALE_WORDS.includes(s.toLowerCase()) ? s.toLowerCase() : null);
  const day = (d) =>
    d && {
      date: typeof d.DateStamp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.DateStamp) ? d.DateStamp : null,
      R: { scale: toNumber(d.R?.Scale), text: word(d.R?.Text), minorProb: toNumber(d.R?.MinorProb), majorProb: toNumber(d.R?.MajorProb) },
      S: { scale: toNumber(d.S?.Scale), text: word(d.S?.Text), prob: toNumber(d.S?.Prob) },
      G: { scale: toNumber(d.G?.Scale), text: word(d.G?.Text) },
    };
  return {
    current: day(obj['0']),
    // "1" = Prognose für heute, "2" und "3" = die folgenden Tage
    forecast: ['1', '2', '3'].map((k) => day(obj[k])).filter((d) => d && d.date),
  };
}

const FLARE_CLASS = /^[ABCMX]\d+(\.\d+)?$/;

function parseFlares(rows) {
  if (!Array.isArray(rows)) throw new SourceError('invalid');
  const f = rows[0];
  if (!f) return null;
  const cls = (s) => (typeof s === 'string' && FLARE_CLASS.test(s) ? s : null);
  const time = (s) => (Number.isFinite(parseUtc(s)) ? new Date(parseUtc(s)).toISOString() : null);
  return {
    currentClass: cls(f.current_class),
    beginTime: time(f.begin_time),
    maxTime: time(f.max_time),
    maxClass: cls(f.max_class),
    endTime: time(f.end_time),
  };
}

// ---------------------------------------------------------------------------
// Bilder – werden vom Server geholt und unter /img/<id> ausgeliefert.
// Texte (Titel, Beschreibung) stehen mehrsprachig im Frontend.
// ---------------------------------------------------------------------------

const SWPC = 'https://services.swpc.noaa.gov';

const IMAGES = [
  { id: 'suvi304', url: `${SWPC}/images/animations/suvi/primary/304/latest.png` },
  { id: 'suvi195', url: `${SWPC}/images/animations/suvi/primary/195/latest.png` },
  { id: 'hmi', url: 'https://soho.nascom.nasa.gov/data/realtime/hmi_igr/512/latest.jpg' },
  { id: 'lasco', url: 'https://soho.nascom.nasa.gov/data/realtime/c3/512/latest.jpg' },
  { id: 'aurora', url: `${SWPC}/images/animations/ovation/north/latest.jpg` },
  { id: 'drap', url: `${SWPC}/images/animations/d-rap/global/latest.png` },
];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const imageStore = new Map(); // id -> { body, type, etag, lastModified }

async function loadImages() {
  return Promise.all(
    IMAGES.map(async ({ id, url }) => {
      try {
        const res = await upstream(url, { accept: 'image/*' });
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_TYPES.has(type)) throw new SourceError('invalid');
        const body = await readLimited(res, 10 * MB);
        const lm = Date.parse(res.headers.get('last-modified') || '');
        const lastModified = Number.isFinite(lm) ? new Date(lm).toISOString() : null;
        const etag = `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
        imageStore.set(id, { body, type, etag, lastModified });
        return { id, available: true, lastModified, version: etag.slice(1, 9) };
      } catch (err) {
        const old = imageStore.get(id);
        // Altes Bild behalten, falls vorhanden
        return old
          ? { id, available: true, lastModified: old.lastModified, version: old.etag.slice(1, 9), stale: true }
          : { id, available: false, lastModified: null, version: null, error: err.code || 'network' };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Quellen mit Cache
// ---------------------------------------------------------------------------

const SOURCES = {
  // N0NBH bittet darum, den Feed höchstens stündlich abzufragen.
  hamqsl: { url: 'https://www.hamqsl.com/solarxml.php', ttl: 60 * MIN, format: 'text', max: 1 * MB, parse: parseHamqsl },
  kp: { url: `${SWPC}/products/noaa-planetary-k-index-forecast.json`, ttl: 10 * MIN, format: 'json', max: 2 * MB, parse: parseKp },
  xray: { url: `${SWPC}/json/goes/primary/xrays-1-day.json`, ttl: 5 * MIN, format: 'json', max: 10 * MB, parse: parseXray },
  flares: { url: `${SWPC}/json/goes/primary/xray-flares-latest.json`, ttl: 5 * MIN, format: 'json', max: 1 * MB, parse: parseFlares },
  wind: { url: `${SWPC}/json/rtsw/rtsw_wind_1m.json`, ttl: 5 * MIN, format: 'json', max: 20 * MB, parse: parseWind },
  mag: { url: `${SWPC}/json/rtsw/rtsw_mag_1m.json`, ttl: 5 * MIN, format: 'json', max: 20 * MB, parse: parseMag },
  scales: { url: `${SWPC}/products/noaa-scales.json`, ttl: 10 * MIN, format: 'json', max: 1 * MB, parse: parseScales },
  images: { ttl: 10 * MIN, load: loadImages },
};

const cache = new Map(); // name -> { data, fetchedAt, error, errorAt, pending }

async function fetchSource(name) {
  const src = SOURCES[name];
  if (src.load) return src.load();
  const res = await upstream(src.url, { accept: src.format === 'json' ? 'application/json' : 'text/xml' });
  const text = (await readLimited(res, src.max)).toString('utf8');
  let body = text;
  if (src.format === 'json') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new SourceError('invalid');
    }
  }
  return src.parse(body);
}

function getSource(name) {
  const src = SOURCES[name];
  let entry = cache.get(name);
  if (!entry) {
    entry = {};
    cache.set(name, entry);
  }
  const now = Date.now();
  const fresh = entry.fetchedAt && now - entry.fetchedAt < src.ttl;
  // Nach einem Fehler höchstens alle 2 Minuten neu versuchen
  const backoff = entry.errorAt && now - entry.errorAt < 2 * MIN;
  if (fresh || backoff) return Promise.resolve(entry);
  if (entry.pending) return entry.pending;

  entry.pending = fetchSource(name)
    .then((data) => {
      entry.data = data;
      entry.fetchedAt = Date.now();
      entry.error = null;
      entry.errorAt = null;
    })
    .catch((err) => {
      entry.error = err instanceof SourceError ? err.code : 'invalid';
      entry.errorAt = Date.now();
      console.warn(`[${new Date().toISOString()}] ${name}: ${entry.error}${err instanceof SourceError ? '' : ` (${err.message})`}`);
    })
    .then(() => {
      entry.pending = null;
      return entry;
    });
  return entry.pending;
}

async function buildPayload() {
  const names = Object.keys(SOURCES);
  const entries = await Promise.all(names.map(getSource));
  const payload = { generatedAt: new Date().toISOString(), sources: {} };
  names.forEach((name, i) => {
    const e = entries[i];
    payload[name] = e.data ?? null;
    payload.sources[name] = {
      ok: !e.error,
      error: e.error || null,
      fetchedAt: e.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
      stale: Boolean(e.error && e.data),
    };
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Statische Dateien – feste Liste, beim Start in den Speicher geladen.
// Anfragen greifen nie direkt aufs Dateisystem zu (kein Path Traversal möglich).
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Angaben zum Betreiber für Impressum und Datenschutz – liegen in operator.json.
// Fehlt die Datei, werden Beispieldaten mit Warnhinweis verwendet.
const OPERATOR_FILE = process.env.OPERATOR_FILE || path.join(__dirname, 'operator.json');
const HOSTING_TYPES = ['cloudflare', 'caddy'];

function loadOperator() {
  let file = OPERATOR_FILE;
  let example = false;
  if (!fs.existsSync(file)) {
    file = path.join(__dirname, 'operator.example.json');
    example = true;
    console.warn('WARNUNG: operator.json fehlt – Impressum und Datenschutz zeigen Beispieldaten (siehe DEPLOY.md).');
  }
  const op = JSON.parse(fs.readFileSync(file, 'utf8'));
  const text = (v, key) => {
    if (typeof v !== 'string' || v.length > 200) throw new Error(`operator.json: "${key}" fehlt oder ist zu lang`);
    return v.trim();
  };
  const both = (v, key) => ({ de: text(v?.de, `${key}.de`), en: text(v?.en, `${key}.en`) });
  if (!HOSTING_TYPES.includes(op.hosting)) throw new Error(`operator.json: "hosting" muss ${HOSTING_TYPES.join(' oder ')} sein`);
  const email = text(op.email, 'email');
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new Error('operator.json: "email" ist ungültig');
  return {
    example,
    name: text(op.name, 'name'),
    street: text(op.street, 'street'),
    postcode: text(op.postcode, 'postcode'),
    city: text(op.city, 'city'),
    country: both(op.country, 'country'),
    serverCountry: both(op.serverCountry, 'serverCountry'),
    email,
    // true, wenn E-Mails an die Adresse über Cloudflare Email Routing weitergeleitet werden
    emailViaCloudflare: op.emailViaCloudflare === true,
    callsign: op.callsign ? text(op.callsign, 'callsign') : '',
    hosting: op.hosting,
  };
}

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Einfache Vorlagen: {{feld}} / {{feld.de}} sowie Blöcke
// <!--if:feld-->…<!--endif--> (Feld gesetzt) und <!--if:feld=wert-->…<!--endif-->
function renderTemplate(html, data, fileName) {
  const get = (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
  const out = html
    .replace(/<!--if:(\w+)(?:=(\w+))?-->([\s\S]*?)<!--endif-->/g, (m, key, value, body) => {
      const v = get(key);
      return (value === undefined ? Boolean(v) : v === value) ? body : '';
    })
    .replace(/\{\{([\w.]+)\}\}/g, (m, p) => {
      const v = get(p);
      if (typeof v !== 'string') throw new Error(`${fileName}: unbekannter Platzhalter {{${p}}}`);
      return escHtml(v);
    });
  return Buffer.from(out, 'utf8');
}

const OPERATOR = loadOperator();

function loadStatic() {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && MIME[path.extname(entry.name).toLowerCase()]) {
        const raw = fs.readFileSync(full);
        const body = entry.name.endsWith('.html') ? renderTemplate(raw.toString('utf8'), OPERATOR, entry.name) : raw;
        const url = '/' + path.relative(PUBLIC_DIR, full).split(path.sep).join('/');
        files.set(url, {
          body,
          type: MIME[path.extname(entry.name).toLowerCase()],
          etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
          cache: url.startsWith('/fonts/') ? 'public, max-age=2592000' : 'no-cache',
        });
      }
    }
  };
  walk(PUBLIC_DIR);
  files.set('/', files.get('/index.html'));
  return files;
}

const STATIC = loadStatic();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const sendText = (res, status, text, extra = {}) =>
  send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });

function sendCached(req, res, { body, type, etag, cache }) {
  if (req.headers['if-none-match'] === etag) {
    return send(res, 304, null, { ETag: etag, 'Cache-Control': cache });
  }
  send(res, 200, req.method === 'HEAD' ? null : body, {
    'Content-Type': type,
    'Content-Length': body.length,
    ETag: etag,
    'Cache-Control': cache,
  });
}

// Einfache Begrenzung pro IP (festes 1-Minuten-Fenster)
const hits = new Map();
setInterval(() => hits.clear(), MIN).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    // Letzter Eintrag = vom eigenen Reverse-Proxy angehängt (nicht vom Client fälschbar)
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > RATE_LIMIT;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    if (req.url.length > 2048) return sendText(res, 414, 'URI Too Long');
    if (rateLimited(req)) return sendText(res, 429, 'Too Many Requests', { 'Retry-After': '60' });

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendText(res, 400, 'Bad Request');
    }

    if (pathname === '/api/data') {
      const body = JSON.stringify(await buildPayload());
      return send(res, 200, req.method === 'HEAD' ? null : body, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }

    const img = /^\/img\/([a-z0-9]{1,20})$/.exec(pathname);
    if (img) {
      if (!IMAGES.some((i) => i.id === img[1])) return sendText(res, 404, 'Not Found');
      await getSource('images');
      const stored = imageStore.get(img[1]);
      if (!stored) return sendText(res, 503, 'Image unavailable', { 'Retry-After': '120' });
      return sendCached(req, res, { ...stored, cache: 'public, max-age=300' });
    }

    if (pathname === '/healthz') return sendText(res, 200, 'ok');

    const file = STATIC.get(pathname);
    if (file) return sendCached(req, res, file);
    return sendText(res, 404, 'Not Found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    else res.destroy();
  }
});

// Zeitlimits gegen langsame oder hängende Verbindungen
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => {
  console.log(`PropWeather läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  // Cache vorwärmen
  buildPayload().catch(() => {});
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
