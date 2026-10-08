'use strict';

// Impressum und Datenschutz: Sprachwahl und Übersetzung der festen Texte.
// Die eigentlichen Rechtstexte stehen pro Sprache in Blöcken mit data-lang.

(() => {
  const DICT = window.I18N;
  const L = window.SiteLang;
  const titleKey = `${document.body.dataset.page}.title`;
  let lang = L.initial();
  const t = L.translator(DICT, () => lang);

  const apply = () => L.applyStatic(DICT, lang, t, titleKey);

  document.querySelectorAll('[data-set-lang]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.setLang;
      if (!L.LANGS.includes(next) || next === lang) return;
      lang = next;
      L.save(lang);
      L.syncUrl(lang);
      apply();
    });
  });

  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
  apply();
})();
