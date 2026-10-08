'use strict';

// Gemeinsame Sprachlogik für alle Seiten.
// Reihenfolge: ?lang=… in der URL, gespeicherte Wahl, Browsersprache, Deutsch.

window.SiteLang = (() => {
  const LANGS = ['de', 'en'];
  const KEY = 'lang';

  function read() {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  // Die Sprachwahl wird nur im Browser gespeichert (localStorage) und nie übertragen.
  function save(lang) {
    try {
      window.localStorage.setItem(KEY, lang);
    } catch {
      /* z. B. privates Fenster – Sprache gilt dann nur für diesen Besuch */
    }
  }

  function initial() {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (LANGS.includes(fromUrl)) return fromUrl;
    const saved = read();
    if (LANGS.includes(saved)) return saved;
    for (const l of navigator.languages || [navigator.language || '']) {
      const base = String(l).slice(0, 2).toLowerCase();
      if (LANGS.includes(base)) return base;
    }
    return 'de';
  }

  // ?lang= in der Adresse nachführen, falls vorhanden
  function syncUrl(lang) {
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', lang);
      history.replaceState(null, '', url);
    }
  }

  function translator(dict, getLang) {
    return (key, params) => {
      let s = dict[getLang()][key] ?? dict.de[key] ?? key;
      if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
      return s;
    };
  }

  // Texte mit data-i18n / data-i18n-html / data-i18n-aria setzen.
  // data-i18n-html nur für Texte aus dem eigenen Wörterbuch, nie für Feed-Daten.
  function applyStatic(dict, lang, t, titleKey) {
    document.documentElement.lang = dict[lang].htmlLang;
    document.title = t(titleKey);
    document.querySelector('meta[name="description"]')?.setAttribute('content', t(titleKey.replace(/title$/, 'description')));
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
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

  return { LANGS, initial, save, syncUrl, translator, applyStatic };
})();
