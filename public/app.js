'use strict';

(() => {
  const REFRESH_MS = 5 * 60 * 1000;
  const HOUR = 3600 * 1000;
  const IMAGE_STALE_MS = 6 * HOUR;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DICT = window.I18N;

  const $ = (sel) => document.querySelector(sel);

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ------------------------------------------------------------------ Sprache

  const L = window.SiteLang;
  let lang = L.initial();
  const t = L.translator(DICT, () => lang);

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
      utcMonth: new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', ...utc }),
      localTime: new Intl.DateTimeFormat(locale, h23),
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
  // Geschützte Leerzeichen: «30 m – 20 m» wird nie mitten im Band umbrochen
  const bandLabel = (n) => n.trim().replace(/m/g, ' m').replace(/\s*-\s*/, ' – ');

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
      const period = qthPeriod();
      const cell = (n, time) => `<td${period === time ? ' class="is-now"' : ''}>${pill(rateBand(cond(n, time)))}</td>`;
      tbody.innerHTML = names
        .map((n) => `<tr><th scope="row">${esc(bandLabel(n))}</th>${cell(n, 'day')}${cell(n, 'night')}</tr>`)
        .join('');
      const heads = document.querySelectorAll('#band-table thead th');
      [['day', 1], ['night', 2]].forEach(([time, i]) => {
        heads[i]?.classList.toggle('is-now', period === time);
        heads[i]?.setAttribute('data-now', t('bands.now'));
      });
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

  function renderStatus(d) {
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
    if (!state) $('#werte-intro').textContent = t('notice.failed');
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
      placeTooltip(tooltip, ev);
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
    for (const draw of [
      () => drawKp(state.kp),
      () => drawXray(state.xray),
      () => drawWind(state.wind),
      () => drawMag(state.mag),
      () => drawOutlook(state.outlook),
      () => drawCycle(state.cycle, state.cycleForecast),
    ]) {
      try {
        draw();
      } catch (err) {
        console.error(err);
      }
    }
  }

  // ------------------------------------------------------------------ Standort (Locator)

  const Geo = window.Geo;
  const QTH_KEY = 'qth';
  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;

  // Der Locator wird nur im Browser gespeichert (localStorage) und nie übertragen.
  function storeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function storeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* z. B. privates Fenster – gilt dann nur für diesen Besuch */
    }
  }
  function storeDel(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nichts zu tun */
    }
  }

  let qth = Geo.locatorToLatLon(storeGet(QTH_KEY));

  // Tag ab Sonnenaufgang (−0,833°), Dämmerung bis −6° (bürgerlich), darunter Nacht
  function sunState(el) {
    if (el >= -0.833) return 'day';
    if (el >= -6) return 'grey';
    return 'night';
  }

  const qthPeriod = () => (qth ? sunState(Geo.sunElevation(qth.lat, qth.lon, Date.now())) : null);

  function fmtCoord(lat, lon, digits = 2) {
    return `${fmtNum(Math.abs(lat), digits)}° ${t(lat >= 0 ? 'qth.n' : 'qth.s')}, ${fmtNum(Math.abs(lon), digits)}° ${t(lon >= 0 ? 'qth.e' : 'qth.w')}`;
  }

  function fmtEvent(ms) {
    if (ms === null) return '–';
    const d = new Date(ms);
    return `${fmt.utcTime.format(d)} UTC (${fmt.localTime.format(d)})`;
  }

  function fmtRange(a, b) {
    if (a === null || b === null) return fmtEvent(a ?? b);
    const da = new Date(a);
    const db = new Date(b);
    return `${fmt.utcTime.format(da)}–${fmt.utcTime.format(db)} UTC (${fmt.localTime.format(da)}–${fmt.localTime.format(db)})`;
  }

  function renderQth() {
    const info = $('#qth-info');
    const input = $('#qth-input');
    const error = $('#qth-error');
    if (!error.hidden) error.textContent = t('qth.error');
    if (document.activeElement !== input && !input.getAttribute('aria-invalid')) input.value = qth ? qth.locator : '';
    if (!qth) {
      info.innerHTML = `<p class="qth__empty">${esc(t('qth.empty'))}</p>`;
      return;
    }
    const now = Date.now();
    const el = Geo.sunElevation(qth.lat, qth.lon, now);
    const st = sunState(el);
    const times = Geo.sunTimes(qth.lat, qth.lon, now);
    const level = { day: 'good', grey: 'ok', night: 'neutral' }[st];
    const rows = times.polar
      ? `<p>${esc(t(times.polar === 'day' ? 'qth.polarDay' : 'qth.polarNight'))}</p>`
      : `<table class="qth__times"><tbody>
          <tr><th scope="row">${esc(t('qth.greyMorning'))}</th><td>${esc(fmtRange(times.dawn, times.sunrise))}</td></tr>
          <tr><th scope="row">${esc(t('qth.sunrise'))}</th><td>${esc(fmtEvent(times.sunrise))}</td></tr>
          <tr><th scope="row">${esc(t('qth.sunset'))}</th><td>${esc(fmtEvent(times.sunset))}</td></tr>
          <tr><th scope="row">${esc(t('qth.greyEvening'))}</th><td>${esc(fmtRange(times.sunset, times.dusk))}</td></tr>
        </tbody></table>
        <p class="qth__note">${esc(t('qth.timesNote'))}</p>`;
    info.innerHTML = `
      <p class="qth__loc"><strong>${esc(qth.locator)}</strong> · ${esc(fmtCoord(qth.lat, qth.lon))}</p>
      <p class="qth__sun">${pill({ level, key: `sun.${st}` })} <span>${esc(t('qth.sunNow', { el: fmtNum(el, 0) }))}</span></p>
      ${rows}
      <button type="button" class="btn btn--ghost" id="qth-remove">${esc(t('qth.remove'))}</button>`;
  }

  function onQthChange() {
    renderQth();
    if (state) {
      for (const step of [renderSummary, renderBands]) {
        try {
          step(state);
        } catch (err) {
          console.error(err);
        }
      }
    }
    drawMap();
  }

  function setupQth() {
    const form = $('#qth-form');
    const input = $('#qth-input');
    const error = $('#qth-error');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) {
        qth = null;
        storeDel(QTH_KEY);
      } else {
        const p = Geo.locatorToLatLon(value);
        if (!p) {
          error.textContent = t('qth.error');
          error.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          return;
        }
        qth = p;
        storeSet(QTH_KEY, p.locator);
      }
      error.hidden = true;
      input.removeAttribute('aria-invalid');
      input.value = qth ? qth.locator : '';
      onQthChange();
    });
    $('#qth-info').addEventListener('click', (e) => {
      if (!e.target.closest('#qth-remove')) return;
      qth = null;
      storeDel(QTH_KEY);
      onQthChange();
      input.focus();
    });
  }

  // ------------------------------------------------------------------ Lage jetzt (Zusammenfassung)

  const LEVEL_RANK = { neutral: 0, good: 1, ok: 2, warn: 3, bad: 4 };
  const worse = (a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

  function listFmt(items) {
    try {
      return new Intl.ListFormat(fmt.locale, { style: 'long', type: 'conjunction' }).format(items);
    } catch {
      return items.join(', ');
    }
  }

  const bandsWith = (h, time, cond) =>
    h.bands.filter((b) => b.time === time && b.condition.trim().toLowerCase() === cond).map((b) => bandLabel(b.name));

  function hfRow(h, time) {
    const good = bandsWith(h, time, 'good');
    const fair = bandsWith(h, time, 'fair');
    const poor = bandsWith(h, time, 'poor');
    const parts = [];
    if (good.length) parts.push(t('sum.good', { list: listFmt(good) }));
    if (fair.length) parts.push(t('sum.fair', { list: listFmt(fair) }));
    if (poor.length) parts.push(t('sum.poor', { list: listFmt(poor) }));
    return {
      label: t(time === 'day' ? 'sum.hfDay' : 'sum.hfNight'),
      level: good.length ? 'good' : fair.length ? 'ok' : 'bad',
      text: parts.join(' · ') || '–',
    };
  }

  function bestBands(h, time) {
    const good = bandsWith(h, time, 'good');
    if (good.length) return { level: 'good', list: listFmt(good) };
    const fair = bandsWith(h, time, 'fair');
    if (fair.length) return { level: 'ok', list: listFmt(fair) };
    return { level: 'bad', list: t('sum.none') };
  }

  function alertsLast24(d) {
    if (!Array.isArray(d.alerts)) return null;
    const since = Date.now() - 24 * HOUR;
    return d.alerts.filter((a) => Date.parse(a.issued) >= since);
  }

  // Meldungen, die für Funkamateure besonders relevant sind
  const SERIOUS_ALERT = /K-index of [5-9]|Geomagnetic Storm|X-ray Event exceeded X|Proton Event|Proton Flux/i;

  function vhfOpenLabel(p) {
    const keys = VHF_LABELS[`${p.name.toLowerCase()}|${p.location.toLowerCase()}`];
    return keys ? `${t(keys[0])} (${t(keys[1])})` : `${p.name} (${p.location})`;
  }

  function renderSummary(d) {
    const list = $('#summary');
    const h = d.hamqsl;
    const rows = [];

    if (h && h.bands.length) {
      const period = qthPeriod();
      if (!qth) {
        rows.push({ label: t('sum.now'), level: 'neutral', html: `<a href="#qth-input">${esc(t('sum.nowHint'))}</a>` });
      } else if (period === 'grey') {
        rows.push({ label: t('sum.now'), level: 'ok', text: t('sum.nowGrey', { loc: qth.locator }) });
      } else {
        const best = bestBands(h, period);
        rows.push({ label: t('sum.now'), level: best.level, text: t(period === 'day' ? 'sum.nowDay' : 'sum.nowNight', { loc: qth.locator, list: best.list }) });
      }
      rows.push(hfRow(h, 'day'), hfRow(h, 'night'));
    }

    if (h) {
      const g = rateGeomag(h.geomagField) || rateK(h.kIndex);
      if (g) {
        let level = g.level;
        const parts = [t('sum.geomagText', { state: ratingText(g), k: fmtNum(h.kIndex), a: fmtNum(h.aIndex) })];
        const today = d.scales?.current?.date || '';
        const fc = (d.scales?.forecast || []).find((f) => f.date >= today && Number.isFinite(f.G?.scale) && f.G.scale >= 1);
        if (fc) {
          parts.push(t('sum.geomagForecast', { g: `G${fc.G.scale} (${scaleWord(fc.G.text)})`, day: fmt.utcDay.format(new Date(`${fc.date}T00:00:00Z`)) }));
          level = worse(level, fc.G.scale >= 3 ? 'bad' : 'warn');
        }
        rows.push({ label: t('sum.geomag'), level, text: parts.join(' · ') });
      }
    }

    const R = d.scales?.current?.R;
    if (R && Number.isFinite(R.scale)) {
      const cls = d.flares?.currentClass || h?.xray || '–';
      const parts = [];
      let level;
      if (R.scale >= 1) {
        level = R.scale >= 3 ? 'bad' : 'warn';
        parts.push(t('sum.flaresActive', { r: `R${R.scale} (${scaleWord(R.text)})`, cls }));
      } else {
        level = 'good';
        parts.push(t('sum.flaresNone', { cls }));
      }
      // Stärkster Flare der letzten 24 Stunden aus der GOES-Messreihe (ab M1 = R1)
      const since = Date.now() - 24 * HOUR;
      const peak = (Array.isArray(d.xray) ? d.xray : [])
        .filter((p) => Date.parse(p.t) >= since && p.flux > 0)
        .reduce((a, b) => (!a || b.flux > a.flux ? b : a), null);
      if (peak && peak.flux >= 1e-5) {
        parts.push(t('sum.recentFlare', { cls: fluxToClass(peak.flux), time: utcTime(peak.t) }));
        level = worse(level, 'ok');
      }
      const prob = d.scales.forecast?.[0]?.R?.minorProb;
      if (Number.isFinite(prob)) parts.push(t('sum.flaresProb', { p: t('pct', { v: prob }) }));
      rows.push({ label: t('sum.flares'), level, text: parts.join(' · ') });
    }

    const S = d.scales?.current?.S;
    if (S && Number.isFinite(S.scale) && S.scale >= 1) {
      rows.push({ label: t('sum.radiation'), level: S.scale >= 3 ? 'bad' : 'warn', text: t('sum.radiationText', { s: `S${S.scale} (${scaleWord(S.text)})` }) });
    }

    const speed = d.wind?.latest?.speed?.value ?? h?.solarWind ?? null;
    const bz = d.mag?.latest?.bz?.value ?? null;
    const windParts = [];
    if (Number.isFinite(speed) && speed >= 500) windParts.push(t('sum.windFast', { v: fmtNum(speed) }));
    if (Number.isFinite(bz) && bz <= -10) windParts.push(t('sum.bzSouth', { v: fmtNum(bz, 1) }));
    if (windParts.length) rows.push({ label: t('sum.wind'), level: 'warn', text: windParts.join(' · ') });

    if (h?.vhf?.length) {
      const open = h.vhf.filter((p) => p.condition && !/^band closed$/i.test(p.condition.trim()));
      rows.push(
        open.length
          ? { label: t('sum.vhf'), level: 'good', text: t('sum.vhfOpen', { list: listFmt(open.map(vhfOpenLabel)) }) }
          : { label: t('sum.vhf'), level: 'neutral', text: t('sum.vhfClosed') },
      );
    }

    const recent = alertsLast24(d);
    if (recent) {
      const n = recent.length;
      const serious = recent.some((a) => SERIOUS_ALERT.test(a.headline));
      const text = n === 0 ? t('sum.alertsNone') : n === 1 ? t('sum.alertsOne') : t('sum.alertsMany', { n });
      rows.push({
        label: t('sum.alerts'),
        level: serious ? 'warn' : 'neutral',
        html: n ? `${esc(text)} – <a href="#skalen">${esc(t('forecast.title'))}</a>` : esc(text),
      });
    }

    if (!rows.length) {
      list.innerHTML = `<li class="placeholder">${esc(t('sum.unavailable'))}</li>`;
      return;
    }
    list.innerHTML = rows
      .map(
        (r) =>
          `<li class="summary__item summary__item--${r.level}"><span class="summary__label">${esc(r.label)}</span><span class="summary__text">${r.html ?? esc(r.text)}</span></li>`,
      )
      .join('');
  }

  // ------------------------------------------------------------------ NOAA-Meldungen

  const ALERT_LEVEL = { ALERT: 'warn', WARNING: 'warn', 'EXTENDED WARNING': 'warn', 'CONTINUED ALERT': 'warn', WATCH: 'ok', SUMMARY: 'neutral' };

  function renderAlerts(d) {
    const list = $('#alerts');
    const items = alertsLast24(d);
    if (items === null) {
      list.innerHTML = `<li class="placeholder">${esc(t('alerts.unavailable'))}</li>`;
      return;
    }
    if (!items.length) {
      list.innerHTML = `<li class="placeholder">${esc(t('alerts.none'))}</li>`;
      return;
    }
    // Geöffnete Volltexte beim Aktualisieren offen lassen
    const open = new Set([...list.querySelectorAll('details[open]')].map((el) => el.dataset.key));
    list.innerHTML = items
      .map((a) => {
        const key = `${a.code}#${a.serial}`;
        const head = a.headline || a.code;
        const colon = head.indexOf(':');
        const type = colon > 0 ? head.slice(0, colon).trim() : 'INFO';
        const title = colon > 0 ? head.slice(colon + 1).trim() : head;
        return `<li class="alert">
            <div class="alert__meta"><span class="pill pill--${ALERT_LEVEL[type] || 'neutral'}">${esc(type)}</span><span>${esc(utcFull(a.issued))}</span><span class="alert__code">${esc(a.code)}</span></div>
            <p class="alert__title">${esc(title)}</p>
            <details data-key="${esc(key)}"${open.has(key) ? ' open' : ''}><summary>${esc(t('alerts.full'))}</summary><pre>${esc(a.message)}</pre></details>
          </li>`;
      })
      .join('');
  }

  // ------------------------------------------------------------------ 27-Tage-Prognose

  function drawOutlook(o) {
    const container = $('#chart-outlook');
    const caption = $('#outlook-caption');
    if (!o || !Array.isArray(o.days) || !o.days.length) {
      caption.textContent = t('outlook.caption');
      return emptyChart(container, t('outlook.unavailable'));
    }
    caption.textContent = o.issued ? t('outlook.captionIssued', { date: fmt.utcDay.format(new Date(o.issued)) }) : t('outlook.caption');

    const days = o.days.map((d, i) => ({ ...d, t: i, ms: Date.parse(`${d.date}T00:00:00Z`) }));
    const f = chartFrame(container, { height: 300, left: 46, top: 24 });
    const n = days.length;
    const bw = f.iw / n;
    const x = (i) => f.left + (i + 0.5) * bw;
    const gap = 30;
    const topH = Math.round((f.ih - gap) * 0.58);
    const botH = f.ih - gap - topH;
    const topY1 = f.top + topH;
    const botY0 = topY1 + gap;
    const botY1 = f.top + f.ih;

    const fluxes = days.map((d) => d.flux);
    const fMin = Math.floor((Math.min(...fluxes) - 5) / 10) * 10;
    const fMax = Math.ceil((Math.max(...fluxes) + 5) / 10) * 10;
    const yF = (v) => topY1 - ((v - fMin) / (fMax - fMin)) * topH;
    const yK = (v) => botY1 - (v / 9) * botH;

    const g = svgEl('g', {}, f.svg);
    for (const v of niceTicks(fMin, fMax, 3)) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: yF(v), y2: yF(v), class: 'c-grid' }, g);
      svgEl('text', { x: f.left - 8, y: yF(v) + 4, 'text-anchor': 'end', class: 'c-label' }, g).textContent = fmtNum(v);
    }
    svgEl('text', { x: f.left, y: f.top - 8, class: 'c-label c-label--display' }, g).textContent = 'SFI';
    for (const v of [0, 3, 6, 9]) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: yK(v), y2: yK(v), class: v === 0 ? 'c-axis' : 'c-grid' }, g);
      svgEl('text', { x: f.left - 8, y: yK(v) + 4, 'text-anchor': 'end', class: 'c-label' }, g).textContent = v;
    }
    svgEl('text', { x: f.left, y: botY0 - 8, class: 'c-label c-label--display' }, g).textContent = 'Kp';

    const barW = Math.max(1, bw - (bw > 8 ? 3 : 1));
    for (const d of days) {
      if (d.kp === null) continue;
      const top = yK(Math.max(d.kp, 0.15));
      svgEl('rect', { x: (x(d.t) - barW / 2).toFixed(1), y: top.toFixed(1), width: barW.toFixed(1), height: (botY1 - top).toFixed(1), class: `c-bar c-bar--${kpLevel(d.kp)}${bw < 6 ? ' c-bar--thin' : ''}` }, f.svg);
    }

    svgEl('path', { d: days.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${yF(d.flux).toFixed(1)}`).join(''), class: 'c-line' }, f.svg);
    if (bw >= 10) for (const d of days) svgEl('circle', { cx: x(d.t), cy: yF(d.flux), r: 2.5, class: 'c-point' }, f.svg);

    const every = Math.max(1, Math.ceil(64 / bw));
    for (const d of days) {
      if (d.t % every !== 0) continue;
      svgEl('text', { x: x(d.t), y: botY1 + 20, 'text-anchor': 'middle', class: 'c-label' }, f.svg).textContent = fmt.utcDayMonth.format(new Date(d.ms));
    }

    const todayIdx = days.findIndex((d) => d.date === new Date().toISOString().slice(0, 10));
    if (todayIdx >= 0) {
      svgEl('line', { x1: x(todayIdx), x2: x(todayIdx), y1: f.top, y2: botY1, class: 'c-now' }, f.svg);
      svgEl('text', { x: x(todayIdx) + 5, y: f.top + 12, class: 'c-label c-label--display' }, f.svg).textContent = t('cycle.now');
    }

    attachHover(container, f, days, x, {
      focusY: (p) => yF(p.flux),
      describe: (p) =>
        `<strong>${esc(fmt.utcDay.format(new Date(p.ms)))}</strong>${esc(t('outlook.tip', { f: fmtNum(p.flux), a: fmtNum(p.ap), k: p.kp === null ? '–' : fmtNum(p.kp) }))}`,
    });
  }

  // ------------------------------------------------------------------ Sonnenzyklus

  const monthMs = (ym) => {
    const [yy, mm] = ym.split('-').map(Number);
    return Date.UTC(yy, mm - 1, 15);
  };

  function drawCycle(obs, pred) {
    const container = $('#chart-cycle');
    if (!Array.isArray(obs) || !obs.length) return emptyChart(container, t('cycle.unavailable'));
    const byMonth = new Map();
    for (const o of obs) byMonth.set(o.t, { t: monthMs(o.t), ssn: o.ssn, smoothed: o.smoothed });
    for (const p of Array.isArray(pred) ? pred : []) {
      const e = byMonth.get(p.t) || { t: monthMs(p.t) };
      Object.assign(e, { pred: p.ssn, low: p.low, high: p.high });
      byMonth.set(p.t, e);
    }
    const points = [...byMonth.values()].sort((a, b) => a.t - b.t);
    const f = chartFrame(container, { height: 280, left: 40 });
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const x = (ms) => f.left + ((ms - t0) / (t1 - t0)) * f.iw;
    const maxV = Math.max(...points.flatMap((p) => [p.ssn, p.smoothed, p.high].filter(Number.isFinite)));
    const yMax = Math.ceil((maxV * 1.08) / 50) * 50;
    const y = (v) => f.top + f.ih - (v / yMax) * f.ih;

    const g = svgEl('g', {}, f.svg);
    for (const v of niceTicks(0, yMax, 5)) {
      svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: y(v), y2: y(v), class: 'c-grid' }, g);
      svgEl('text', { x: f.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'c-label' }, g).textContent = fmtNum(v);
    }
    const step = f.iw < 520 ? 4 : 2;
    const y0 = new Date(t0).getUTCFullYear();
    const y1 = new Date(t1).getUTCFullYear();
    for (let yr = Math.ceil(y0 / step) * step; yr <= y1; yr += step) {
      const ms = Date.UTC(yr, 0, 1);
      if (ms < t0) continue;
      svgEl('line', { x1: x(ms), x2: x(ms), y1: f.top, y2: f.top + f.ih, class: 'c-grid' }, g);
      svgEl('text', { x: x(ms), y: f.top + f.ih + 20, 'text-anchor': 'middle', class: 'c-label' }, g).textContent = yr;
    }
    svgEl('line', { x1: f.left, x2: f.left + f.iw, y1: f.top + f.ih, y2: f.top + f.ih, class: 'c-axis' }, g);

    const band = points.filter((p) => Number.isFinite(p.low) && Number.isFinite(p.high));
    if (band.length > 1) {
      const upper = band.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.high).toFixed(1)}`).join('');
      const lower = [...band].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.low).toFixed(1)}`).join('');
      svgEl('path', { d: `${upper}${lower}Z`, class: 'c-area c-area--pred' }, f.svg);
    }
    const gapMs = 45 * 24 * HOUR;
    svgEl('path', { d: linePath(points, x, y, 'ssn', gapMs), class: 'c-line c-line--muted' }, f.svg);
    svgEl('path', { d: linePath(points, x, y, 'pred', gapMs), class: 'c-line c-line--pred' }, f.svg);
    svgEl('path', { d: linePath(points, x, y, 'smoothed', gapMs), class: 'c-line' }, f.svg);

    const now = Date.now();
    if (now > t0 && now < t1) {
      svgEl('line', { x1: x(now), x2: x(now), y1: f.top, y2: f.top + f.ih, class: 'c-now' }, f.svg);
      svgEl('text', { x: x(now) + 5, y: f.top + 12, class: 'c-label c-label--display' }, f.svg).textContent = t('cycle.now');
    }

    attachHover(container, f, points, x, {
      focusY: (p) => {
        const v = p.smoothed ?? p.ssn ?? p.pred;
        return Number.isFinite(v) ? y(v) : null;
      },
      describe: (p) => {
        const lines = [];
        if (Number.isFinite(p.ssn)) lines.push(t('cycle.tipObs', { v: fmtNum(p.ssn, 1) }));
        if (Number.isFinite(p.smoothed)) lines.push(t('cycle.tipSmooth', { v: fmtNum(p.smoothed, 1) }));
        if (Number.isFinite(p.pred)) lines.push(t('cycle.tipPred', { v: fmtNum(p.pred, 1), lo: fmtNum(p.low, 1), hi: fmtNum(p.high, 1) }));
        return `<strong>${esc(fmt.utcMonth.format(new Date(p.t)))}</strong>${lines.map(esc).join('<br>')}`;
      },
    });
  }

  // ------------------------------------------------------------------ Greyline-Karte

  let worldPath = null;
  const shade = document.createElement('canvas');
  shade.width = 360;
  shade.height = 180;

  async function loadWorld() {
    try {
      const res = await fetch('world-110m.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      worldPath = new Path2D((await res.json()).d);
    } catch (err) {
      console.error('Weltkarte', err);
    }
    drawMap();
  }

  // Ein Pixel pro Grad: Tag durchsichtig, Dämmerung gelb, Nacht dunkel (tiefer = dunkler)
  function paintShade(pos) {
    const ctx = shade.getContext('2d');
    const img = ctx.createImageData(360, 180);
    const px = img.data;
    const sd = Math.sin(pos.dec * RAD);
    const cd = Math.cos(pos.dec * RAD);
    const cosH = new Float64Array(360);
    for (let i = 0; i < 360; i++) cosH[i] = Math.cos((-179.5 + i - pos.subLon) * RAD);
    for (let j = 0; j < 180; j++) {
      const lat = (89.5 - j) * RAD;
      const a = Math.sin(lat) * sd;
      const b = Math.cos(lat) * cd;
      for (let i = 0; i < 360; i++) {
        const el = Math.asin(Math.max(-1, Math.min(1, a + b * cosH[i]))) * DEG;
        const k = (j * 360 + i) * 4;
        if (el >= -0.833) continue;
        if (el >= -6) {
          px[k] = 255;
          px[k + 1] = 210;
          px[k + 2] = 0;
          px[k + 3] = 165;
        } else {
          px[k] = 20;
          px[k + 1] = 20;
          px[k + 2] = 20;
          px[k + 3] = Math.round(95 + Math.min(1, (-6 - el) / 12) * 75);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawMap() {
    const canvas = $('#map-canvas');
    const box = $('#map');
    if (!canvas || !box) return;
    const now = Date.now();
    $('#map-intro').textContent = t('map.intro', { time: fmt.utcTime.format(new Date(now)) });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(280, Math.floor(box.clientWidth));
    const cw = Math.round(w * dpr);
    const ch = Math.round(cw / 2);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d');
    const sx = cw / 360;
    const sy = ch / 180;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#82dce1';
    ctx.fillRect(0, 0, cw, ch);

    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    if (worldPath) {
      ctx.fillStyle = '#ffffff';
      ctx.fill(worldPath);
      ctx.lineWidth = (0.8 * dpr) / sx;
      ctx.strokeStyle = 'rgba(36, 36, 36, 0.6)';
      ctx.stroke(worldPath);
    }
    ctx.lineWidth = dpr / sx;
    ctx.strokeStyle = 'rgba(36, 36, 36, 0.18)';
    ctx.beginPath();
    for (let lon = -150; lon <= 150; lon += 30) {
      ctx.moveTo(lon + 180, 0);
      ctx.lineTo(lon + 180, 180);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      ctx.moveTo(0, 90 - lat);
      ctx.lineTo(360, 90 - lat);
    }
    ctx.stroke();

    const pos = Geo.sunPosition(now);
    paintShade(pos);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shade, 0, 0, 360, 180);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const px = (lon) => (lon + 180) * sx;
    const py = (lat) => (90 - lat) * sy;
    ctx.beginPath();
    ctx.arc(px(pos.subLon), py(pos.dec), 8 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffd200';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#242424';
    ctx.stroke();

    if (qth) {
      const qx = px(qth.lon);
      const qy = py(qth.lat);
      ctx.beginPath();
      ctx.arc(qx, qy, 6 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = '#fe0000';
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.font = `${13 * dpr}px Figtree, Arial, sans-serif`;
      const label = qth.locator;
      const tw = ctx.measureText(label).width;
      const pad = 4 * dpr;
      let lx = qx + 10 * dpr;
      if (lx + tw + 2 * pad > cw) lx = qx - 10 * dpr - tw - 2 * pad;
      const ly = Math.max(pad, Math.min(ch - 18 * dpr - pad, qy - 9 * dpr));
      ctx.fillStyle = '#242424';
      ctx.fillRect(lx, ly, tw + 2 * pad, 18 * dpr);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + pad, ly + 9 * dpr);
    }
  }

  function placeTooltip(tip, ev) {
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = ev.clientX + 14;
    if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
    let top = ev.clientY - th - 12;
    if (top < 8) top = ev.clientY + 16;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }

  function setupMap() {
    const canvas = $('#map-canvas');
    const tip = $('#tooltip');
    const move = (ev) => {
      const r = canvas.getBoundingClientRect();
      const lon = ((ev.clientX - r.left) / r.width) * 360 - 180;
      const lat = 90 - ((ev.clientY - r.top) / r.height) * 180;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        tip.hidden = true;
        return;
      }
      const el = Geo.sunElevation(lat, lon, Date.now());
      tip.innerHTML = `<strong>${esc(Geo.latLonToLocator(lat, lon))}</strong>${esc(fmtCoord(lat, lon, 1))}<br>${esc(t('map.tipSun', { el: fmtNum(el, 0), state: t(`sun.${sunState(el)}`) }))}`;
      tip.hidden = false;
      placeTooltip(tip, ev);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', move);
    canvas.addEventListener('pointerleave', () => {
      tip.hidden = true;
    });
  }

  // Jede Minute: Karte, Sonnenstand am Standort und «Jetzt»-Zeile nachführen
  function minuteTick() {
    drawMap();
    renderQth();
    if (state) {
      for (const step of [renderSummary, renderBands]) {
        try {
          step(state);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  // ------------------------------------------------------------------ Bilder

  // Herkunft der Bilder: Produktseite beim Datenlieferanten und Originaldatei
  const IMAGE_SOURCES = {
    suvi304: {
      page: 'https://www.swpc.noaa.gov/products/goes-solar-ultraviolet-imager-suvi',
      file: 'https://services.swpc.noaa.gov/images/animations/suvi/primary/304/latest.png',
      credit: 'NOAA SWPC',
    },
    suvi195: {
      page: 'https://www.swpc.noaa.gov/products/goes-solar-ultraviolet-imager-suvi',
      file: 'https://services.swpc.noaa.gov/images/animations/suvi/primary/195/latest.png',
      credit: 'NOAA SWPC',
    },
    hmi: {
      page: 'https://sdo.gsfc.nasa.gov/data/',
      file: 'https://soho.nascom.nasa.gov/data/realtime/hmi_igr/1024/latest.jpg',
      credit: 'Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.',
    },
    lasco: {
      page: 'https://soho.nascom.nasa.gov/data/realtime-images.html',
      file: 'https://soho.nascom.nasa.gov/data/realtime/c3/1024/latest.jpg',
      credit: 'Courtesy of SOHO/LASCO consortium. SOHO is a project of international cooperation between ESA and NASA.',
    },
    aurora: {
      page: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
      file: 'https://services.swpc.noaa.gov/images/animations/ovation/north/latest.jpg',
      credit: 'NOAA SWPC',
    },
    drap: {
      page: 'https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap',
      file: 'https://services.swpc.noaa.gov/images/animations/d-rap/global/latest.png',
      credit: 'NOAA SWPC',
    },
  };

  let galleryKey = '';
  let galleryImages = [];
  let lightboxIndex = -1;

  function imageMeta(img) {
    if (!img.available) return `<span class="pill pill--bad">${esc(t('images.imgUnavailable'))}</span>`;
    if (!img.lastModified) return `<span>${esc(t('images.unknown'))}</span>`;
    const when = t('images.when', { time: fmt.utcFull.format(new Date(img.lastModified)), ago: fmtAgo(img.lastModified) });
    const stale = Date.now() - Date.parse(img.lastModified) > IMAGE_STALE_MS;
    return `${stale ? `<span class="pill pill--warn">${esc(t('images.stale'))}</span>` : ''}<span>${esc(when)}</span>`;
  }

  function sourceLinks(id) {
    const src = IMAGE_SOURCES[id];
    if (!src) return '';
    return `<a href="${esc(src.page)}" target="_blank" rel="noopener noreferrer">${esc(t('lightbox.source'))} ↗</a>
      <a href="${esc(src.file)}" target="_blank" rel="noopener noreferrer">${esc(t('lightbox.original'))} ↗</a>`;
  }

  function renderGallery(d) {
    const images = d.images;
    const gallery = $('#gallery');
    if (!Array.isArray(images) || !images.length) {
      gallery.innerHTML = `<div class="placeholder">${esc(t('images.unavailable'))}</div>`;
      galleryKey = '';
      galleryImages = [];
      return;
    }
    galleryImages = images;
    const key = `${lang}|${images.map((i) => `${i.id}:${i.version}`).join('|')}`;
    if (key === galleryKey) {
      // Nur die Zeitangaben auffrischen
      for (const img of images) {
        const meta = gallery.querySelector(`.tile[data-id="${CSS.escape(img.id)}"] .tile__meta`);
        if (meta) meta.innerHTML = imageMeta(img);
      }
      if (lightboxIndex >= 0) fillLightbox();
      return;
    }
    galleryKey = key;
    gallery.innerHTML = images
      .map((img, i) => {
        const id = esc(img.id);
        const media = img.available
          ? `<button class="tile__zoom" type="button" data-index="${i}" aria-label="${esc(t('lightbox.open', { title: t(`img.${img.id}.title`) }))}">
              <img src="img/${id}?v=${esc(img.version || '')}" alt="${esc(t(`img.${img.id}.alt`))}" loading="lazy" decoding="async">
            </button>`
          : `<div class="tile__error">${esc(t('images.imgUnavailable'))}</div>`;
        return `<figure class="tile" data-id="${id}">
            ${media}
            <figcaption><strong>${esc(t(`img.${img.id}.title`))}</strong>${esc(t(`img.${img.id}.caption`))}<div class="tile__meta">${imageMeta(img)}</div>
            <div class="tile__links">${sourceLinks(img.id)}</div></figcaption>
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
          (el.closest('.tile__zoom') || el).replaceWith(div);
        },
        { once: true },
      );
    });
    if (lightboxIndex >= 0) fillLightbox();
  }

  // ------------------------------------------------------------------ Detailansicht

  function fillLightbox() {
    const img = galleryImages[lightboxIndex];
    if (!img) return;
    const src = IMAGE_SOURCES[img.id];
    $('#lightbox-title').textContent = t(`img.${img.id}.title`);
    $('#lightbox-caption').textContent = t(`img.${img.id}.caption`);
    $('#lightbox-text').textContent = t(`img.${img.id}.detail`);
    $('#lightbox-meta').innerHTML = imageMeta(img);
    $('#lightbox-credit').textContent = src ? `${t('images.credit')} ${src.credit}` : '';
    $('#lightbox-links').innerHTML = sourceLinks(img.id);
    const media = $('#lightbox-media');
    const url = `img/${img.id}?v=${img.version || ''}`;
    const current = media.querySelector('img');
    if (!img.available) {
      media.innerHTML = `<div class="tile__error">${esc(t('images.imgUnavailable'))}</div>`;
    } else if (!current || current.getAttribute('src') !== url) {
      media.innerHTML = `<img src="${esc(url)}" alt="${esc(t(`img.${img.id}.alt`))}">`;
    } else {
      current.alt = t(`img.${img.id}.alt`);
    }
    const many = galleryImages.length > 1;
    $('#lightbox-prev').hidden = !many;
    $('#lightbox-next').hidden = !many;
  }

  function openLightbox(index) {
    const dialog = $('#lightbox');
    lightboxIndex = index;
    fillLightbox();
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('has-dialog');
  }

  function stepLightbox(delta) {
    if (lightboxIndex < 0 || !galleryImages.length) return;
    lightboxIndex = (lightboxIndex + delta + galleryImages.length) % galleryImages.length;
    fillLightbox();
  }

  function setupLightbox() {
    const dialog = $('#lightbox');
    $('#gallery').addEventListener('click', (e) => {
      const btn = e.target.closest('.tile__zoom');
      if (btn) openLightbox(Number(btn.dataset.index));
    });
    $('#lightbox-close').addEventListener('click', () => dialog.close());
    $('#lightbox-prev').addEventListener('click', () => stepLightbox(-1));
    $('#lightbox-next').addEventListener('click', () => stepLightbox(1));
    // Klick auf den abgedunkelten Hintergrund schliesst
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    });
    dialog.addEventListener('close', () => {
      const tile = galleryImages[lightboxIndex] && $(`#gallery .tile[data-id="${CSS.escape(galleryImages[lightboxIndex].id)}"] .tile__zoom`);
      lightboxIndex = -1;
      document.documentElement.classList.remove('has-dialog');
      tile?.focus();
    });
  }

  // ------------------------------------------------------------------ Sprache anwenden

  function applyStatic() {
    L.applyStatic(DICT, lang, t, 'meta.title');
  }

  function renderAll() {
    if (!state) {
      if (lastFetchError) showFetchError(lastFetchError);
      return;
    }
    for (const step of [renderStatus, renderSummary, renderIndices, renderBands, renderVhf, renderScales, renderAlerts, renderGallery]) {
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
    if (!L.LANGS.includes(next) || next === lang) return;
    lang = next;
    L.save(lang);
    L.syncUrl(lang);
    fmt = makeFormats();
    applyStatic();
    renderAll();
    renderQth();
    drawMap();
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
  setupLightbox();
  setupQth();
  setupMap();
  renderQth();
  loadWorld();
  load();
  setInterval(load, REFRESH_MS);
  setInterval(minuteTick, 60 * 1000);
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
        drawMap();
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
