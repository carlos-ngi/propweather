'use strict';

(() => {
  const REFRESH_MS = 5 * 60 * 1000;
  const HOUR = 3600 * 1000;
  const IMAGE_STALE_MS = 6 * HOUR;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const LANGS = ['de', 'en'];
  const DICT = window.I18N;

  const $ = (sel) => document.querySelector(sel);

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ------------------------------------------------------------------ Sprache

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* z. B. privates Fenster – Sprache gilt dann nur für diesen Besuch */
    }
  }

  function initialLang() {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (LANGS.includes(fromUrl)) return fromUrl;
    const saved = storageGet('lang');
    if (LANGS.includes(saved)) return saved;
    for (const l of navigator.languages || [navigator.language || '']) {
      const base = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(base)) return base;
    }
    return 'de';
  }

  let lang = initialLang();

  function t(key, params) {
    let s = DICT[lang][key] ?? DICT.de[key] ?? key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
    return s;
  }

  // ------------------------------------------------------------------ Formate

  let fmt = null;

  function makeFormats() {
    const locale = DICT[lang].locale;
    const utc = { timeZone: 'UTC' };
    const h23 = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    const dayOpts = lang === 'de' ? { weekday: 'short', day: '2-digit', month: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short' };
    const dmOpts = lang === 'de' ? { day: '2-digit', month: '2-digit' } : { day: 'numeric', month: 'short' };
    const stampOpts = lang === 'de'
      ? { day: '2-digit', month: '2-digit', year: 'numeric', ...h23 }
      : { day: 'numeric', month: 'short', year: 'numeric', ...h23 };
    return {
      locale,
      numbers: new Map(),
      stamp: new Intl.DateTimeFormat(locale, stampOpts),
      utcTime: new Intl.DateTimeFormat(locale, { ...h23, ...utc }),
      utcDay: new Intl.DateTimeFormat(locale, { ...dayOpts, ...utc }),
      utcDayMonth: new Intl.DateTimeFormat(locale, { ...dmOpts, ...utc }),
      utcFull: new Intl.DateTimeFormat(locale, { ...dayOpts, ...h23, ...utc }),
    };
  }

  function fmtNum(n, digits = 0) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    if (!fmt.numbers.has(digits)) {
      fmt.numbers.set(digits, new Intl.NumberFormat(fmt.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    }
    let v = Number(n.toFixed(digits));
    if (Object.is(v, -0)) v = 0;
    let s = fmt.numbers.get(digits).format(v);
    // Schweizer Schreibweise: Tausender mit ’, Dezimalkomma
    if (lang === 'de') s = s.replace('.', ',');
    return s.replace(/^-/, '−');
  }

  // Kp kommt in Dritteln (z. B. 4,67) – ganze Werte ohne Nachkommastellen
  const fmtKp = (v) => fmtNum(v, Number.isInteger(v) ? 0 : 2);

  function fmtStamp(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '–';
    return `${fmt.stamp.format(d)} (${fmt.utcTime.format(d)} UTC)`;
  }

  function fmtAgo(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const min = Math.round(ms / 60000);
    if (min < 1) return t('ago.now');
    if (min < 60) return t('ago.min', { n: min });
    const h = Math.floor(min / 60);
    if (h < 48) return t('ago.h', { n: h });
    return t('ago.d', { n: Math.floor(h / 24) });
  }

  const utcTime = (iso) => (iso ? `${fmt.utcTime.format(new Date(iso))} UTC` : '–');
  const utcFull = (iso) => (iso ? `${fmt.utcFull.format(new Date(iso))} UTC` : '–');

  function errText(code) {
    if (!code) return t('err.invalid');
    const http = /^http_(\d{3})$/.exec(code);
    if (http) return t('err.http', { code: http[1] });
    return DICT[lang][`err.${code}`] ? t(`err.${code}`) : t('err.invalid');
  }

  // ------------------------------------------------------------------ Bewertungen
  // Eine Bewertung ist { level, key, params } oder { level, text } (Rohtext aus dem Feed)

  const rate = (level, key, params) => ({ level, key, params });

  function rateSfi(v) {
    if (v === null) return null;
    if (v >= 150) return rate('good', 'rate.sfi.vgood');
    if (v >= 100) return rate('good', 'rate.sfi.good');
    if (v >= 70) return rate('ok', 'rate.sfi.fair');
    return rate('warn', 'rate.sfi.low');
  }

  function rateA(v) {
    if (v === null) return null;
    if (v < 8) return rate('good', 'rate.quiet');
    if (v < 16) return rate('ok', 'rate.unsettled');
    if (v < 30) return rate('warn', 'rate.active');
    if (v < 50) return rate('bad', 'rate.minor');
    if (v < 100) return rate('bad', 'rate.major');
    return rate('bad', 'rate.severe');
  }

  // K 0–2 ruhig, 3 unruhig, 4 aktiv, ab 5 Sturm G1–G5 (NOAA)
  function rateK(v) {
    if (v === null) return null;
    const k = Math.round(v);
    if (k <= 2) return rate('good', 'rate.quiet');
    if (k === 3) return rate('ok', 'rate.unsettled');
    if (k === 4) return rate('warn', 'rate.active');
    return rate('bad', 'rate.storm', { g: `G${Math.min(5, k - 4)}` });
  }

  // Farbe der Kp-Balken; NOAA zählt Kp 5- (4,67) bereits als G1
  function kpLevel(kp) {
    if (kp < 3.67) return 'good';
    if (kp < 4.67) return 'ok';
    if (kp < 6.67) return 'warn';
    return 'bad';
  }

  function parseXrayClass(s) {
    const m = /^([ABCMX])\s*(\d+(?:\.\d+)?)/i.exec(String(s || '').trim());
    return m ? { cls: m[1].toUpperCase(), mag: parseFloat(m[2]) } : null;
  }

  // NOAA R-Skala: M1 = R1, M5 = R2, X1 = R3, X10 = R4, X20 = R5
  function rateXray(s) {
    const x = parseXrayClass(s);
    if (!x) return null;
    if (x.cls === 'A' || x.cls === 'B') return rate('good', 'rate.xray.quiet');
    if (x.cls === 'C') return rate('ok', 'rate.xray.c');
    if (x.cls === 'M') return x.mag < 5 ? rate('warn', 'rate.r1') : rate('warn', 'rate.r2');
    if (x.mag < 10) return rate('bad', 'rate.r3');
    if (x.mag < 20) return rate('bad', 'rate.r4');
    return rate('bad', 'rate.r5');
  }

  function rateBz(v) {
    if (v === null) return null;
    if (v > 1) return rate('good', 'rate.bz.north');
    if (v >= -1) return rate('good', 'rate.bz.neutral');
    if (v > -5) return rate('ok', 'rate.bz.lsouth');
    if (v > -10) return rate('warn', 'rate.bz.south');
    return rate('bad', 'rate.bz.ssouth');
  }

  function rateWind(v) {
    if (v === null) return null;
    if (v < 500) return rate('good', 'rate.wind.normal');
    if (v < 700) return rate('warn', 'rate.wind.elevated');
    return rate('bad', 'rate.wind.high');
  }

  const GEOMAG = {
    INACTIVE: ['good', 'rate.inactive'],
    'VR QUIET': ['good', 'rate.vquiet'],
    QUIET: ['good', 'rate.quiet'],
    UNSETTLD: ['ok', 'rate.unsettled'],
    UNSETTLED: ['ok', 'rate.unsettled'],
    ACTIVE: ['warn', 'rate.active'],
    'MIN STORM': ['bad', 'rate.minor'],
    'MAJ STORM': ['bad', 'rate.major'],
    'SEV STORM': ['bad', 'rate.severe'],
    'EXT STORM': ['bad', 'rate.extreme'],
  };
  function rateGeomag(s) {
    if (!s) return null;
    const hit = GEOMAG[s.trim().toUpperCase().replace(/\s+/g, ' ')];
    return hit ? rate(hit[0], hit[1]) : { level: 'neutral', text: s.trim() };
  }

  function rateBand(s) {
    switch ((s || '').trim().toLowerCase()) {
      case 'good': return rate('good', 'band.good');
      case 'fair': return rate('ok', 'band.fair');
      case 'poor': return rate('bad', 'band.poor');
      default: return { level: 'neutral', text: s || '–' };
    }
  }

  function rateVhf(s) {
    const v = (s || '').trim();
    if (!v) return { level: 'neutral', text: '–' };
    if (/^band closed$/i.test(v)) return rate('neutral', 'vhf.closed');
    if (/^high muf$/i.test(v)) return rate('good', 'vhf.highMuf');
    if (/^\d+\s*MHz\s*ES$/i.test(v)) return rate('good', 'vhf.open');
    const aur = /^(high|mid|low)\s*lat\s*aur/i.exec(v);
    if (aur) return rate('good', `vhf.aur.${aur[1].toLowerCase()}`);
    return { level: 'good', text: v };
  }

  const VHF_LABELS = {
    'vhf-aurora|northern_hemi': ['vhf.aurora', 'vhf.aurora.sub'],
    'e-skip|europe_6m': ['vhf.esEu', 'vhf.band6'],
    'e-skip|europe_4m': ['vhf.esEu', 'vhf.band4'],
    'e-skip|europe': ['vhf.esEu', 'vhf.band2'],
    'e-skip|north_america': ['vhf.esNa', 'vhf.band2'],
  };

  const ratingText = (r) => (r.text !== undefined ? r.text : t(r.key, r.params));
  const pill = (r) => (r ? `<span class="pill pill--${r.level}">${esc(ratingText(r))}</span>` : '');
  const scaleWord = (w) => (w ? t(`scale.${w}`) : '–');
  const bandLabel = (n) => n.replace(/m/g, ' m').replace(/\s*-\s*/, ' – ').trim();

  // ------------------------------------------------------------------ Rendering: Werte

  function latestKp(kp) {
    if (!Array.isArray(kp)) return null;
    const now = Date.now();
    let best = null;
    for (const r of kp) {
      if (r.kind === 'predicted') continue;
      const ts = Date.parse(r.t);
      if (ts <= now && (!best || ts > Date.parse(best.t))) best = r;
    }
    return best;
  }

  function renderIndices(d) {
    const h = d.hamqsl;
    const box = $('#indices');
    if (!h) {
      box.innerHTML = `<div class="placeholder">${esc(t('values.unavailable'))}</div>`;
      $('#werte-intro').textContent = t('values.intro');
      return;
    }

    const kpNow = latestKp(d.kp);
    const flare = d.flares;
    const windNow = d.wind?.latest?.speed;
    const bzNow = d.mag?.latest?.bz;
    const btNow = d.mag?.latest?.bt;

    const items = [
      { title: 'idx.sfi', abbr: 'SFI', value: fmtNum(h.solarFlux), unit: 'sfu', rate: rateSfi(h.solarFlux), text: 'idx.sfi.text' },
      { title: 'idx.sn', abbr: 'SN', value: fmtNum(h.sunspots), text: 'idx.sn.text' },
      { title: 'idx.a', abbr: 'A', value: fmtNum(h.aIndex), rate: rateA(h.aIndex), text: 'idx.a.text' },
      {
        title: 'idx.k', abbr: 'K', value: fmtNum(h.kIndex), rate: rateK(h.kIndex), text: 'idx.k.text',
        extra: [kpNow ? t('idx.k.noaa', { kp: fmtKp(kpNow.kp), kind: t(`kind.${kpNow.kind}`), time: utcTime(kpNow.t) }) : null],
      },
      {
        title: 'idx.xray', abbr: 'X-Ray', value: h.xray ?? '–', rate: rateXray(h.xray), text: 'idx.xray.text',
        extra: [flare?.currentClass ? t('idx.xray.goes', { cls: flare.currentClass }) : null],
      },
      {
        title: 'idx.flare', abbr: 'Flare', value: flare?.maxClass ?? '–', rate: flare ? rateXray(flare.maxClass) : null, text: 'idx.flare.text',
        extra: flare
          ? [t('idx.flare.max', { time: utcFull(flare.maxTime) }), flare.endTime ? t('idx.flare.end', { time: utcTime(flare.endTime) }) : t('idx.flare.ongoing')]
          : [],
      },
      {
        title: 'idx.wind', abbr: 'SW', value: fmtNum(h.solarWind), unit: 'km/s', rate: rateWind(h.solarWind), text: 'idx.wind.text',
        extra: [windNow ? t('idx.live', { value: `${fmtNum(windNow.value)} km/s`, time: utcTime(windNow.t) }) : null],
      },
      {
        title: 'idx.bz', abbr: 'Bz', value: fmtNum(h.bz, 1), unit: 'nT', rate: rateBz(h.bz), text: 'idx.bz.text',
        extra: [
          bzNow
            ? t('idx.live', { value: `Bz ${fmtNum(bzNow.value, 1)} nT${btNow ? `, Bt ${fmtNum(btNow.value, 1)} nT` : ''}`, time: utcTime(bzNow.t) })
            : null,
        ],
      },
      { title: 'idx.304', abbr: '304A', value: fmtNum(h.heliumLine, 1), text: 'idx.304.text' },
      { title: 'idx.proton', abbr: 'Ptn Flx', value: fmtNum(h.protonFlux), text: 'idx.proton.text' },
      { title: 'idx.electron', abbr: 'Elc Flx', value: fmtNum(h.electronFlux), text: 'idx.electron.text' },
      {
        title: 'idx.aurora', abbr: 'Aur', value: fmtNum(h.aurora), text: 'idx.aurora.text',
        extra: [h.latDegree !== null ? t('idx.aurora.lat', { lat: fmtNum(h.latDegree, 1) }) : null],
      },
    ];

    box.innerHTML = items
      .map((it) => {
        const extra = (it.extra || []).filter(Boolean);
        return `
          <article class="box">
            <div class="box__head"><h3 class="box__title">${esc(t(it.title))}</h3><span class="box__abbr">${esc(it.abbr)}</span></div>
            <p class="box__value">${esc(it.value)}${it.unit ? `<span class="box__unit">${esc(it.unit)}</span>` : ''}</p>
            ${it.rate || extra.length ? `<div class="box__status">${pill(it.rate)}${extra.map((e) => `<span class="box__extra">${esc(e)}</span>`).join('')}</div>` : ''}
            <p class="box__text">${esc(t(it.text))}</p>
          </article>`;
      })
      .join('');

    $('#werte-intro').textContent = t('values.introFull', { time: fmtStamp(h.updated) });
  }

  // ------------------------------------------------------------------ Rendering: Bänder, VHF

  function renderBands(d) {
    const h = d.hamqsl;
    const tbody = $('#band-table tbody');
    if (!h || !h.bands.length) {
      tbody.innerHTML = `<tr><td colspan="3">${esc(t('nodata'))}</td></tr>`;
    } else {
      const names = [...new Set(h.bands.map((b) => b.name))];
      const cond = (name, time) => h.bands.find((b) => b.name === name && b.time === time)?.condition;
      tbody.innerHTML = names
        .map((n) => `<tr><th scope="row">${esc(bandLabel(n))}</th><td>${pill(rateBand(cond(n, 'day')))}</td><td>${pill(rateBand(cond(n, 'night')))}</td></tr>`)
        .join('');
    }

    const facts = $('#hf-facts');
    if (!h) {
      facts.innerHTML = '';
      return;
    }
    const geo = rateGeomag(h.geomagField);
    const mhz = (v) => {
      if (!v || /^no\s*rpt$/i.test(v) || /no report/i.test(v)) return { value: t('fact.noreport'), note: t('fact.noreport.note') };
      const n = parseFloat(v);
      return Number.isFinite(n) ? { value: `${fmtNum(n, 1)} MHz`, note: '' } : { value: v, note: '' };
    };
    const muf = mhz(h.muf);
    const fof2 = mhz(h.fof2);
    const entries = [
      { label: t('fact.geomag'), rate: geo, value: '–', note: h.geomagField ? t('fact.original', { v: h.geomagField }) : '', wide: true },
      { label: t('fact.noise'), value: h.signalNoise || '–', note: t('fact.noise.note') },
      { label: t('fact.muf'), value: muf.value, note: muf.note ? `${muf.note} · ${t('fact.muf.note')}` : t('fact.muf.note') },
      { label: t('fact.fof2'), value: fof2.value, note: fof2.note, raw: true },
      h.mufFactor ? { label: t('fact.mfactor'), value: h.mufFactor, note: '' } : null,
      { label: t('fact.calc'), value: h.updated ? utcTime(h.updated) : '–', note: h.updated ? fmtAgo(h.updated) : '', wide: !h.mufFactor },
    ].filter(Boolean);
    facts.innerHTML = entries
      .map(
        (e) =>
          `<div class="fact${e.wide ? ' fact--wide' : ''}"><dt${e.raw ? ' class="is-raw"' : ''}>${esc(e.label)}</dt><dd>${e.rate ? pill(e.rate) : esc(e.value)}${e.note ? `<small>${esc(e.note)}</small>` : ''}</dd></div>`,
      )
      .join('');
  }

  function renderVhf(d) {
    const list = $('#vhf-list');
    const vhf = d.hamqsl?.vhf;
    if (!vhf || !vhf.length) {
      list.innerHTML = `<li>${esc(t('nodata'))}</li>`;
      return;
    }
    list.innerHTML = vhf
      .map((p) => {
        const keys = VHF_LABELS[`${p.name.toLowerCase()}|${p.location.toLowerCase()}`];
        const label = keys ? t(keys[0]) : `${p.name} (${p.location})`;
        const sub = keys ? t(keys[1]) : '';
        return `<li><span class="vhf-list__label">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${pill(rateVhf(p.condition))}</li>`;
      })
      .join('');
  }

  // ------------------------------------------------------------------ Rendering: NOAA-Skalen

  function renderScales(d) {
    const s = d.scales;
    const now = $('#scales-now');
    const tbody = $('#scales-forecast tbody');
    if (!s || !s.current) {
      now.innerHTML = `<div class="placeholder">${esc(t('scales.unavailable'))}</div>`;
      tbody.innerHTML = '';
      return;
    }
    now.innerHTML = ['R', 'S', 'G']
      .map((k) => {
        const lvl = Number.isFinite(s.current[k]?.scale) ? Math.min(5, Math.max(0, s.current[k].scale)) : null;
        return `<div class="scale">
            <span class="scale__level ${lvl !== null ? `lvl-${lvl}` : ''}">${k}${lvl !== null ? lvl : '?'}</span>
            <span class="scale__name">${esc(t(`scales.${k}`))}</span>
            <span class="scale__text">${esc(t('scales.now', { v: scaleWord(s.current[k]?.text) }))}</span>
          </div>`;
      })
      .join('');

    const pct = (v) => (Number.isFinite(v) ? t('pct', { v }) : '–');
    tbody.innerHTML = s.forecast
      .map((f) => {
        const date = fmt.utcDay.format(new Date(`${f.date}T00:00:00Z`));
        const day = f.date === s.current.date ? t('scales.today', { d: date }) : date;
        const g = Number.isFinite(f.G?.scale) ? `G${f.G.scale} · ${scaleWord(f.G.text)}` : '–';
        return `<tr><th scope="row">${esc(day)}</th><td>${esc(pct(f.R?.minorProb))}</td><td>${esc(pct(f.R?.majorProb))}</td><td>${esc(pct(f.S?.prob))}</td><td>${esc(g)}</td></tr>`;
      })
      .join('');
  }

  // ------------------------------------------------------------------ Ticker, Kopf, Hinweise

  function renderTicker(d) {
    const h = d.hamqsl;
    const up = (key) => t(key).toLocaleUpperCase(fmt.locale);
    const parts = [];
    if (h) {
      parts.push(`SFI ${fmtNum(h.solarFlux)}`, `SN ${fmtNum(h.sunspots)}`, `A ${fmtNum(h.aIndex)}`, `K ${fmtNum(h.kIndex)}`);
      if (h.xray) parts.push(`X-RAY ${h.xray}`);
      parts.push(`${up('ticker.wind')} ${fmtNum(h.solarWind)} km/s`, `Bz ${fmtNum(h.bz, 1)} nT`);
      const geo = rateGeomag(h.geomagField);
      if (geo) parts.push(`${up('ticker.geomag')} ${ratingText(geo).toLocaleUpperCase(fmt.locale)}`);
      if (h.signalNoise) parts.push(`${up('ticker.noise')} ${h.signalNoise}`);
      const good = h.bands.filter((b) => b.time === 'day' && /^good$/i.test(b.condition)).map((b) => bandLabel(b.name).replace(' – ', '–'));
      if (good.length) parts.push(`${up('ticker.goodDay')}: ${good.join(', ')}`);
      if (h.updated) parts.push(`${up('ticker.time')} ${utcTime(h.updated)}`);
    } else {
      parts.push(up('notice.hamqslDown'));
    }
    const html = parts.map((p) => `<span>${esc(p)}</span>`).join('');
    $('#ticker').innerHTML = `<span class="ticker__item">${html}</span><span class="ticker__item">${html}</span>`;
  }

  function renderStatus(d) {
    const h = d.hamqsl;
    $('#hero-meta').textContent = h?.updated ? t('hero.meta', { time: fmtStamp(h.updated), ago: fmtAgo(h.updated) }) : t('notice.hamqslDown');

    const failed = Object.entries(d.sources || {}).filter(([, s]) => !s.ok);
    const notice = $('#notice');
    if (failed.length) {
      notice.innerHTML = `<div><strong>${esc(t('notice.partial'))}</strong>${failed
        .map(([k, s]) => `${esc(DICT[lang][`src.${k}`] ? t(`src.${k}`) : k)}: ${esc(errText(s.error))}${s.stale ? esc(t('notice.stale')) : ''}`)
        .join('<br>')}</div>`;
      notice.hidden = false;
    } else {
      notice.hidden = true;
      notice.innerHTML = '';
    }

    const total = Object.keys(d.sources || {}).length;
    const ok = Object.values(d.sources || {}).filter((s) => s.ok).length;
    $('#footer-status').textContent = t('footer.loaded', { time: fmtStamp(d.generatedAt), ok, total });
  }

  let lastFetchError = null;

  function showFetchError(err) {
    lastFetchError = err;
    const msg = err instanceof TypeError ? t('err.network') : err.message;
    const notice = $('#notice');
    notice.innerHTML = `<div><strong>${esc(t('notice.offline'))}</strong>${esc(t('notice.offlineText', { err: msg }))}</div>`;
    notice.hidden = false;
    if (!state) $('#hero-meta').textContent = t('notice.failed');
  }

  // ------------------------------------------------------------------ Diagramme

  function svgEl(tag, attrs = {}, parent) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
    return ticks;
  }

  const superscript = (e) => String(e).replace('-', '⁻').replace(/\d/g, (c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]);

  function chartFrame(container, { height, left = 46, right = 14, top = 14, bottom = 30 }) {
    container.innerHTML = '';
    const width = Math.max(260, Math.floor(container.clientWidth));
    const h = width < 520 ? Math.round(height * 0.85) : height;
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${h}`, width, height: h }, container);
    return { svg, width, height: h, left, right, top, bottom, iw: width - left - right, ih: h - top - bottom };
  }

  function timeAxis(f, t0, t1, x) {
    const g = svgEl('g', {}, f.svg);
    const span = t1 - t0;
    if (span > 4 * 24 * HOUR) {
      // Tagesraster
      const days = Math.ceil(span / (24 * HOUR));
      const maxLabels = Math.max(1, Math.floor(f.iw / 70));
      const every = Math.ceil(days / maxLabels);
      let i = 0;
      for (let ts = Math.ceil(t0 / (24 * HOUR)) * 24 * HOUR; ts <= t1; ts += 24 * HOUR, i++) {
        const px = x(ts);
        svgEl('line', { x1: px, x2: px, y1: f.top, y2: f.top + f.ih, class: 'c-grid' }, g);
        const mid = ts + 12 * HOUR;
        if (i % every === 0 && mid < t1) {
          const lbl = svgEl('text', { x: x(mid), y: f.top + f.ih + 20, 'text-anchor': 'middle', class: 'c-label' }, g);
          lbl.textContent = fmt.utcDay.format(new Date(ts));
        }
      }
    } else {
      const step = (f.iw < 420 ? 6 : 3) * HOUR;
      for (let ts = Math.ceil(t0 / step) * step; ts <= t1; ts += step) {
        const px = x(ts);
        svgEl('line', { x1: px, x2: px, y1: f.top, y2: f.top + f.ih, class: 'c-grid' }, g);
        const d = new Date(ts);
        const lbl = svgEl('text', { x: px, y: f.top + f.ih + 20, 'text-anchor': 'middle', class: 'c-label' }, g);
        lbl.textContent = d.getUTCHours() === 0 ? fmt.utcDayMonth.format(d) : fmt.utcTime.format(d);
      }
    }
    svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: f.top + f.ih, y2: f.top + f.ih, class: 'c-axis' }, g);
  }

  function linePath(points, x, y, key, maxGap) {
    let d = '';
    let prevT = null;
    for (const p of points) {
      const v = p[key];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        prevT = null;
        continue;
      }
      const cmd = prevT === null || p.t - prevT > maxGap ? 'M' : 'L';
      d += `${cmd}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      prevT = p.t;
    }
    return d;
  }

  function areaPaths(points, x, y, key, baseValue, maxGap, clamp = (v) => v) {
    // Fläche zwischen Kurve und Basislinie, an Datenlücken unterbrochen
    const segments = [];
    let seg = [];
    let prevT = null;
    for (const p of points) {
      const v = p[key];
      const valid = v !== null && v !== undefined && Number.isFinite(v);
      if (!valid || (prevT !== null && p.t - prevT > maxGap)) {
        if (seg.length) segments.push(seg);
        seg = [];
      }
      if (valid) {
        seg.push([x(p.t), y(clamp(v))]);
        prevT = p.t;
      } else {
        prevT = null;
      }
    }
    if (seg.length) segments.push(seg);
    const yb = y(baseValue).toFixed(1);
    return segments
      .filter((s) => s.length > 1)
      .map((s) => `M${s[0][0].toFixed(1)},${yb}` + s.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('') + `L${s[s.length - 1][0].toFixed(1)},${yb}Z`)
      .join('');
  }

  function attachHover(container, f, points, x, { describe, focusY, bars }) {
    const svg = f.svg;
    const tooltip = $('#tooltip');
    const cursor = svgEl('line', { y1: f.top, y2: f.top + f.ih, class: 'c-cursor', visibility: 'hidden' }, svg);
    const dot = svgEl('circle', { r: 5, class: 'c-dot', visibility: 'hidden' }, svg);
    let activeBar = null;

    const hide = () => {
      cursor.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tooltip.hidden = true;
      if (activeBar) activeBar.classList.remove('is-active');
      activeBar = null;
    };

    const nearest = (px) => {
      // Daten sind zeitlich sortiert
      let lo = 0;
      let hi = points.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x(points[mid].t) < px) lo = mid;
        else hi = mid;
      }
      return Math.abs(x(points[lo].t) - px) <= Math.abs(x(points[hi].t) - px) ? lo : hi;
    };

    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * f.width;
      if (px < f.left || px > f.left + f.iw) return hide();
      const p = bars ? points[bars.indexAt(px)] : points[nearest(px)];
      if (!p) return hide();

      if (bars) {
        if (activeBar) activeBar.classList.remove('is-active');
        activeBar = bars.nodes.get(p) || null;
        if (activeBar) activeBar.classList.add('is-active');
      } else {
        const cx = x(p.t);
        cursor.setAttribute('x1', cx);
        cursor.setAttribute('x2', cx);
        cursor.setAttribute('visibility', 'visible');
        const fy = focusY(p);
        if (fy !== null) {
          dot.setAttribute('cx', cx);
          dot.setAttribute('cy', fy);
          dot.setAttribute('visibility', 'visible');
        } else {
          dot.setAttribute('visibility', 'hidden');
        }
      }

      tooltip.innerHTML = describe(p);
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      let left = ev.clientX + 14;
      if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
      let top = ev.clientY - th - 12;
      if (top < 8) top = ev.clientY + 16;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${top}px`;
    };

    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', hide);
    container.addEventListener('pointercancel', hide);
  }

  function emptyChart(container, text) {
    container.innerHTML = `<div class="chart__empty">${esc(text)}</div>`;
  }

  function drawKp(kp) {
    const container = $('#chart-kp');
    if (!Array.isArray(kp) || !kp.length) return emptyChart(container, t('chart.kp.unavailable'));
    const points = kp.map((r) => ({ ...r, t: Date.parse(r.t) })).sort((a, b) => a.t - b.t);
    const slot = 3 * HOUR;
    const f = chartFrame(container, { height: 280, left: 34 });
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t + slot;
    const x = (ts) => f.left + ((ts - t0) / (t1 - t0)) * f.iw;
    const y = (v) => f.top + f.ih - (v / 9) * f.ih;

    const grid = svgEl('g', {}, f.svg);
    for (let v = 0; v <= 9; v++) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(v), y2: y(v), class: 'c-grid' }, grid);
      const lbl = svgEl('text', { x: f.left - 10, y: y(v) + 4, 'text-anchor': 'end', class: 'c-label' }, grid);
      lbl.textContent = v;
    }
    timeAxis(f, t0, t1, x);

    // G1-Schwelle: NOAA zählt Kp 5- (4,67) als G1
    svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(4.67), y2: y(4.67), class: 'c-threshold' }, f.svg);
    const g1 = svgEl('text', { x: f.left + f.iw - 4, y: y(4.67) - 6, 'text-anchor': 'end', class: 'c-label c-label--display' }, f.svg);
    g1.textContent = t('chart.kp.storm');

    const bw = (slot / (t1 - t0)) * f.iw;
    const gap = bw > 6 ? 1.5 : 0.5;
    const nodes = new Map();
    const barsG = svgEl('g', {}, f.svg);
    for (const p of points) {
      const h = Math.max(1.5, f.top + f.ih - y(p.kp));
      const rect = svgEl(
        'rect',
        {
          x: (x(p.t) + gap / 2).toFixed(1),
          y: (f.top + f.ih - h).toFixed(1),
          width: Math.max(0.5, bw - gap).toFixed(1),
          height: h.toFixed(1),
          class: `c-bar c-bar--${kpLevel(p.kp)}${p.kind === 'predicted' ? ' c-bar--pred' : ''}${bw < 6 ? ' c-bar--thin' : ''}`,
        },
        barsG,
      );
      nodes.set(p, rect);
    }

    const now = Date.now();
    if (now > t0 && now < t1) {
      svgEl('line', { x1: x(now), x2: x(now), y1: f.top, y2: f.top + f.ih, class: 'c-now' }, f.svg);
      const lbl = svgEl('text', { x: x(now) + 5, y: f.top + 12, class: 'c-label c-label--display' }, f.svg);
      lbl.textContent = t('chart.kp.now');
    }

    const bySlot = new Map(points.map((p, i) => [p.t, i]));
    attachHover(container, f, points, x, {
      bars: {
        nodes,
        indexAt: (px) => {
          const i = Math.floor(((px - f.left) / f.iw) * ((t1 - t0) / slot));
          const idx = bySlot.get(t0 + i * slot);
          return idx === undefined ? -1 : idx;
        },
      },
      describe: (p) =>
        `<strong>Kp ${fmtKp(p.kp)}${p.scale ? ` · ${esc(p.scale)}` : ''}</strong>${esc(fmt.utcFull.format(new Date(p.t)))}–${esc(fmt.utcTime.format(new Date(p.t + slot)))} UTC<br>${esc(t(`kind.${p.kind}`))}`,
    });
  }

  function fluxToClass(flux) {
    const classes = ['A', 'B', 'C', 'M', 'X'];
    const e = Math.floor(Math.log10(flux));
    const idx = Math.min(4, Math.max(0, e + 8));
    const base = 10 ** (idx - 8);
    return `${classes[idx]}${(flux / base).toFixed(1)}`;
  }

  function fluxSci(v) {
    const e = Math.floor(Math.log10(v));
    return `${fmtNum(v / 10 ** e, 2)} × 10${superscript(e)}`;
  }

  function drawXray(xray) {
    const container = $('#chart-xray');
    const points = Array.isArray(xray) ? xray.map((r) => ({ t: Date.parse(r.t), flux: r.flux })).filter((p) => p.flux > 0) : [];
    if (!points.length) {
      $('#xray-caption').textContent = t('chart.xray.caption');
      return emptyChart(container, t('chart.xray.unavailable'));
    }
    const f = chartFrame(container, { height: 280, left: 52 });
    const t1 = points[points.length - 1].t;
    const t0 = Math.min(points[0].t, t1 - 24 * HOUR);
    const x = (ts) => f.left + ((ts - t0) / (t1 - t0)) * f.iw;
    const peak = Math.max(...points.map((p) => p.flux));
    const maxLog = Math.max(-3, Math.ceil(Math.log10(peak)));
    const minLog = -9;
    const y = (v) => f.top + f.ih - ((Math.log10(v) - minLog) / (maxLog - minLog)) * f.ih;

    // Klassenbänder A–X
    const classes = ['A', 'B', 'C', 'M', 'X'];
    const g = svgEl('g', {}, f.svg);
    for (let e = minLog; e < maxLog; e++) {
      const idx = e + 8; // 1e-8 -> A
      if (idx >= 0 && idx < classes.length && idx % 2 === 0) {
        svgEl('rect', { x: f.left, width: f.iw, y: y(10 ** (e + 1)), height: y(10 ** e) - y(10 ** (e + 1)), class: 'c-band' }, g);
      }
    }
    for (let e = minLog; e <= maxLog; e++) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(10 ** e), y2: y(10 ** e), class: 'c-grid' }, g);
      const lbl = svgEl('text', { x: f.left - 8, y: y(10 ** e) + 4, 'text-anchor': 'end', class: 'c-label' }, g);
      lbl.textContent = `10${superscript(e)}`;
      const idx = e + 8;
      if (e < maxLog && idx >= 0 && idx < classes.length) {
        const c = svgEl('text', { x: f.left + 8, y: (y(10 ** e) + y(10 ** (e + 1))) / 2 + 6, class: 'c-label c-label--display' }, g);
        c.textContent = classes[idx];
      }
    }
    timeAxis(f, t0, t1, x);

    svgEl('path', { d: linePath(points, x, y, 'flux', 20 * 60 * 1000), class: 'c-line' }, f.svg);

    attachHover(container, f, points, x, {
      focusY: (p) => y(p.flux),
      describe: (p) => `<strong>${esc(fluxToClass(p.flux))}</strong>${esc(fluxSci(p.flux))} W/m²<br>${esc(utcFull(new Date(p.t).toISOString()))}`,
    });

    $('#xray-caption').textContent = t('chart.xray.captionMax', { cls: fluxToClass(peak) });
  }

  function drawWind(wind) {
    const container = $('#chart-wind');
    const series = wind?.series;
    if (!Array.isArray(series) || !series.some((p) => p.speed !== null)) {
      $('#wind-caption').textContent = t('chart.wind.caption');
      return emptyChart(container, t('chart.wind.unavailable'));
    }
    const points = series.map((p) => ({ ...p, t: Date.parse(p.t) }));
    const vals = points.map((p) => p.speed).filter((v) => v !== null);
    const f = chartFrame(container, { height: 240, left: 46 });
    const t1 = points[points.length - 1].t;
    const t0 = Math.min(points[0].t, t1 - 24 * HOUR);
    const x = (ts) => f.left + ((ts - t0) / (t1 - t0)) * f.iw;
    const yMin = Math.min(250, Math.floor(Math.min(...vals) / 50) * 50);
    const yMax = Math.max(600, Math.ceil(Math.max(...vals) / 50) * 50);
    const y = (v) => f.top + f.ih - ((v - yMin) / (yMax - yMin)) * f.ih;

    const g = svgEl('g', {}, f.svg);
    for (const v of niceTicks(yMin, yMax, 5)) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(v), y2: y(v), class: 'c-grid' }, g);
      const lbl = svgEl('text', { x: f.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'c-label' }, g);
      lbl.textContent = fmtNum(v);
    }
    timeAxis(f, t0, t1, x);
    const gapMs = 30 * 60 * 1000;
    svgEl('path', { d: areaPaths(points, x, y, 'speed', yMin, gapMs), class: 'c-area' }, f.svg);
    svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(500), y2: y(500), class: 'c-threshold' }, f.svg);
    const thr = svgEl('text', { x: f.left + f.iw - 4, y: y(500) - 6, 'text-anchor': 'end', class: 'c-label c-label--display' }, f.svg);
    thr.textContent = t('chart.wind.elevated');
    svgEl('path', { d: linePath(points, x, y, 'speed', gapMs), class: 'c-line' }, f.svg);

    attachHover(container, f, points, x, {
      focusY: (p) => (p.speed !== null ? y(p.speed) : null),
      describe: (p) =>
        `<strong>${esc(p.speed !== null ? `${fmtNum(p.speed)} km/s` : t('chart.nodata'))}</strong>${p.density !== null ? `${esc(t('chart.wind.density', { v: fmtNum(p.density, 1) }))}<br>` : ''}${esc(utcFull(new Date(p.t).toISOString()))} (${esc(t('chart.avg10'))})`,
    });

    const last = wind.latest?.speed;
    $('#wind-caption').textContent = last ? t('chart.wind.captionNow', { v: fmtNum(last.value) }) : t('chart.wind.caption');
  }

  function drawMag(mag) {
    const container = $('#chart-mag');
    const series = mag?.series;
    if (!Array.isArray(series) || !series.some((p) => p.bz !== null)) {
      $('#mag-caption').textContent = t('chart.mag.caption');
      return emptyChart(container, t('chart.mag.unavailable'));
    }
    const points = series.map((p) => ({ ...p, t: Date.parse(p.t) }));
    const absMax = Math.max(...points.flatMap((p) => [Math.abs(p.bz ?? 0), Math.abs(p.bt ?? 0)]));
    const m = Math.max(10, Math.ceil(absMax / 5) * 5);
    const f = chartFrame(container, { height: 240, left: 40 });
    const t1 = points[points.length - 1].t;
    const t0 = Math.min(points[0].t, t1 - 24 * HOUR);
    const x = (ts) => f.left + ((ts - t0) / (t1 - t0)) * f.iw;
    const y = (v) => f.top + f.ih - ((v + m) / (2 * m)) * f.ih;

    const g = svgEl('g', {}, f.svg);
    for (const v of niceTicks(-m, m, 4)) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(v), y2: y(v), class: v === 0 ? 'c-axis' : 'c-grid' }, g);
      const lbl = svgEl('text', { x: f.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'c-label' }, g);
      lbl.textContent = fmtNum(v);
    }
    timeAxis(f, t0, t1, x);
    const gapMs = 30 * 60 * 1000;
    svgEl('path', { d: areaPaths(points, x, y, 'bz', 0, gapMs, (v) => Math.min(0, v)), class: 'c-area c-area--south' }, f.svg);
    svgEl('path', { d: linePath(points, x, y, 'bt', gapMs), class: 'c-line c-line--muted' }, f.svg);
    svgEl('path', { d: linePath(points, x, y, 'bz', gapMs), class: 'c-line' }, f.svg);

    attachHover(container, f, points, x, {
      focusY: (p) => (p.bz !== null ? y(p.bz) : null),
      describe: (p) =>
        `<strong>Bz ${esc(fmtNum(p.bz, 1))} nT</strong>Bt ${esc(fmtNum(p.bt, 1))} nT<br>${esc(utcFull(new Date(p.t).toISOString()))} (${esc(t('chart.avg10'))})`,
    });

    const last = mag.latest?.bz;
    $('#mag-caption').textContent = last ? t('chart.mag.captionNow', { v: fmtNum(last.value, 1) }) : t('chart.mag.caption');
  }

  function drawCharts() {
    if (!state) return;
    for (const draw of [() => drawKp(state.kp), () => drawXray(state.xray), () => drawWind(state.wind), () => drawMag(state.mag)]) {
      try {
        draw();
      } catch (err) {
        console.error(err);
      }
    }
  }

  // ------------------------------------------------------------------ Bilder

  let galleryKey = '';

  function imageMeta(img) {
    if (!img.available) return `<span class="pill pill--bad">${esc(t('images.imgUnavailable'))}</span>`;
    if (!img.lastModified) return `<span>${esc(t('images.unknown'))}</span>`;
    const when = t('images.when', { time: fmt.utcFull.format(new Date(img.lastModified)), ago: fmtAgo(img.lastModified) });
    const stale = Date.now() - Date.parse(img.lastModified) > IMAGE_STALE_MS;
    return `${stale ? `<span class="pill pill--warn">${esc(t('images.stale'))}</span>` : ''}<span>${esc(when)}</span>`;
  }

  function renderGallery(d) {
    const images = d.images;
    const gallery = $('#gallery');
    if (!Array.isArray(images) || !images.length) {
      gallery.innerHTML = `<div class="placeholder">${esc(t('images.unavailable'))}</div>`;
      galleryKey = '';
      return;
    }
    const key = `${lang}|${images.map((i) => `${i.id}:${i.version}`).join('|')}`;
    if (key === galleryKey) {
      // Nur die Zeitangaben auffrischen
      for (const img of images) {
        const meta = gallery.querySelector(`.tile[data-id="${CSS.escape(img.id)}"] .tile__meta`);
        if (meta) meta.innerHTML = imageMeta(img);
      }
      return;
    }
    galleryKey = key;
    gallery.innerHTML = images
      .map((img) => {
        const id = esc(img.id);
        const media = img.available
          ? `<img src="img/${id}?v=${esc(img.version || '')}" alt="${esc(t(`img.${img.id}.alt`))}" loading="lazy" decoding="async">`
          : `<div class="tile__error">${esc(t('images.imgUnavailable'))}</div>`;
        return `<figure class="tile" data-id="${id}">
            ${media}
            <figcaption><strong>${esc(t(`img.${img.id}.title`))}</strong>${esc(t(`img.${img.id}.caption`))}<div class="tile__meta">${imageMeta(img)}</div></figcaption>
          </figure>`;
      })
      .join('');
    gallery.querySelectorAll('img').forEach((el) => {
      el.addEventListener(
        'error',
        () => {
          const div = document.createElement('div');
          div.className = 'tile__error';
          div.textContent = t('images.imgUnavailable');
          el.replaceWith(div);
        },
        { once: true },
      );
    });
  }

  // ------------------------------------------------------------------ Sprache anwenden

  function applyStatic() {
    document.documentElement.lang = DICT[lang].htmlLang;
    document.title = t('meta.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    // Nur Texte aus dem eigenen Wörterbuch – nie Daten aus dem Feed
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });
    document.querySelectorAll('[data-set-lang]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.setLang === lang));
    });
  }

  function renderAll() {
    if (!state) {
      if (lastFetchError) showFetchError(lastFetchError);
      return;
    }
    for (const step of [renderStatus, renderIndices, renderTicker, renderBands, renderVhf, renderScales, renderGallery]) {
      try {
        step(state);
      } catch (err) {
        console.error(step.name, err);
      }
    }
    drawCharts();
    if (lastFetchError) showFetchError(lastFetchError);
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    lang = next;
    storageSet('lang', lang);
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', lang);
      history.replaceState(null, '', url);
    }
    fmt = makeFormats();
    applyStatic();
    renderAll();
  }

  // ------------------------------------------------------------------ Laden

  let state = null;
  let loading = false;
  let lastLoad = 0;

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch('api/data', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = await res.json();
      lastLoad = Date.now();
      lastFetchError = null;
      renderAll();
    } catch (err) {
      console.error(err);
      showFetchError(err);
    } finally {
      loading = false;
    }
  }

  // ------------------------------------------------------------------ Navigation

  function setupNav() {
    const toggle = $('.nav-toggle');
    const nav = $('#site-nav');
    const close = () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', () => {
      const open = !nav.classList.contains('is-open');
      nav.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    document.querySelectorAll('[data-set-lang]').forEach((btn) => {
      btn.addEventListener('click', () => setLang(btn.dataset.setLang));
    });
  }

  // ------------------------------------------------------------------ Start

  fmt = makeFormats();
  applyStatic();
  $('#year').textContent = String(new Date().getFullYear());
  setupNav();
  load();
  setInterval(load, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoad > REFRESH_MS) load();
  });

  let lastWidth = window.innerWidth;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        drawCharts();
      }
    }, 150);
  });
  window.addEventListener(
    'scroll',
    () => {
      const tip = $('#tooltip');
      if (!tip.hidden) tip.hidden = true;
    },
    { passive: true },
  );
})();
