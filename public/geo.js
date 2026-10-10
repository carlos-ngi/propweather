'use strict';

// Sonnenstand, Dämmerung und Maidenhead-Locator – reine Rechenfunktionen ohne DOM.
// Sonnenstand nach dem Algorithmus des NOAA Solar Calculators (Genauigkeit ~1 Minute).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;
  const DAY_MS = 86400000;

  const norm180 = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

  // Deklination (°), Zeitgleichung (Minuten) und Subsolarpunkt für einen Zeitpunkt
  function sunPosition(date) {
    const ms = date instanceof Date ? date.getTime() : date;
    const jd = ms / DAY_MS + 2440587.5;
    const t = (jd - 2451545) / 36525;
    const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
    const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const c =
      Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
      Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
      Math.sin(3 * m * RAD) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
    const y = Math.tan((eps / 2) * RAD) ** 2;
    const eqTime =
      4 *
      DEG *
      (y * Math.sin(2 * l0 * RAD) -
        2 * e * Math.sin(m * RAD) +
        4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
        0.5 * y * y * Math.sin(4 * l0 * RAD) -
        1.25 * e * e * Math.sin(2 * m * RAD));
    const utcHours = (((ms % DAY_MS) + DAY_MS) % DAY_MS) / 3600000;
    const subLon = norm180(-15 * (utcHours - 12 + eqTime / 60));
    return { dec, eqTime, subLat: dec, subLon };
  }

  // Sonnenhöhe (°) über dem Horizont an einem Ort, ohne Refraktion
  function sunElevation(lat, lon, date, pos = sunPosition(date)) {
    const h = (lon - pos.subLon) * RAD;
    const s = Math.sin(lat * RAD) * Math.sin(pos.dec * RAD) + Math.cos(lat * RAD) * Math.cos(pos.dec * RAD) * Math.cos(h);
    return Math.asin(Math.max(-1, Math.min(1, s))) * DEG;
  }

  // Auf- und Untergang sowie bürgerliche Dämmerung für den lokalen Sonnentag, der `date` enthält.
  // Rückgabe in Millisekunden (UTC); null, wenn das Ereignis an diesem Tag nicht eintritt.
  function sunTimes(lat, lon, date) {
    const ms = date instanceof Date ? date.getTime() : date;
    // Ortszeit nach Sonnenstand (ohne Zeitzone) -> Beginn des lokalen Tages
    const solarLocal = ms + (lon / 15) * 3600000;
    const dayStartLocal = Math.floor(solarLocal / DAY_MS) * DAY_MS;
    const meanNoon = dayStartLocal + 12 * 3600000 - (lon / 15) * 3600000;
    // Wahren Mittag mit der Zeitgleichung korrigieren (zweimal, damit sie zum Mittag selbst passt)
    let noon = meanNoon - sunPosition(meanNoon).eqTime * 60000;
    noon = meanNoon - sunPosition(noon).eqTime * 60000;
    // Stundenwinkel (in Zeitminuten) für eine Sonnenhöhe; NaN, wenn sie nie erreicht wird
    const hourAngle = (altitude, dec) => {
      const cosH =
        (Math.sin(altitude * RAD) - Math.sin(lat * RAD) * Math.sin(dec * RAD)) / (Math.cos(lat * RAD) * Math.cos(dec * RAD));
      if (cosH > 1) return Infinity; // bleibt unter dieser Höhe
      if (cosH < -1) return -Infinity; // bleibt darüber
      return Math.acos(cosH) * DEG * 4;
    };

    const event = (altitude) => {
      const h0 = hourAngle(altitude, sunPosition(noon).dec);
      if (h0 === Infinity) return { rise: null, set: null, state: 'never' };
      if (h0 === -Infinity) return { rise: null, set: null, state: 'always' };
      // Zweimal verfeinern: Deklination und Zeitgleichung zum Zeitpunkt des Ereignisses
      const refine = (sign) => {
        let tEvent = noon + sign * h0 * 60000;
        for (let i = 0; i < 2; i++) {
          const p = sunPosition(tEvent);
          const h = hourAngle(altitude, p.dec);
          if (!Number.isFinite(h)) break;
          tEvent = meanNoon - p.eqTime * 60000 + sign * h * 60000;
        }
        return tEvent;
      };
      return { rise: refine(-1), set: refine(1), state: 'normal' };
    };

    const sun = event(-0.833); // Oberrand der Sonne mit Refraktion
    const civil = event(-6);
    return {
      noon,
      sunrise: sun.rise,
      sunset: sun.set,
      dawn: civil.rise,
      dusk: civil.set,
      polar: sun.state === 'normal' ? null : sun.state === 'always' ? 'day' : 'night',
    };
  }

  // Maidenhead-Locator (4 oder 6 Zeichen) -> Mittelpunkt des Feldes
  const LOCATOR = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i;

  function locatorToLatLon(loc) {
    const s = String(loc || '').trim().toUpperCase();
    if (!LOCATOR.test(s)) return null;
    let lon = (s.charCodeAt(0) - 65) * 20 - 180 + Number(s[2]) * 2;
    let lat = (s.charCodeAt(1) - 65) * 10 - 90 + Number(s[3]);
    if (s.length === 6) {
      lon += (s.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;
      lat += (s.charCodeAt(5) - 65) * (1 / 24) + 1 / 48;
    } else {
      lon += 1;
      lat += 0.5;
    }
    return { lat, lon, locator: s.length === 6 ? s.slice(0, 4) + s.slice(4).toLowerCase() : s };
  }

  function latLonToLocator(lat, lon) {
    const x = Math.min(359.999999, Math.max(0, lon + 180));
    const y = Math.min(179.999999, Math.max(0, lat + 90));
    const a = String.fromCharCode(65 + Math.floor(x / 20)) + String.fromCharCode(65 + Math.floor(y / 10));
    const b = String(Math.floor((x % 20) / 2)) + String(Math.floor(y % 10));
    const c = String.fromCharCode(97 + Math.floor(((x % 2) / 2) * 24)) + String.fromCharCode(97 + Math.floor((y % 1) * 24));
    return a + b + c;
  }

  return { sunPosition, sunElevation, sunTimes, locatorToLatLon, latLonToLocator, isLocator: (s) => LOCATOR.test(String(s || '').trim()) };
});
