// Lightweight i18n with cross-site language sync (References/language-sync.md).
//
// - English ships in the bundle and is the fallback for every key.
// - Other locales live in js/i18n/locales/<code>.js, loaded on demand.
// - Static DOM binds via data-i18n / data-i18n-title / data-i18n-placeholder;
//   dynamic strings use t(key, params).
// - The shared "miliastra-lang" localStorage key is the single source of truth
//   for every Miliastra Toolkit site on this origin.
import en from './locales/en.js';

export const LANGS = [
  { code: 'en', name: 'English', bcp47: 'en' },
  { code: 'zhs', name: '简体中文', bcp47: 'zh-Hans' },
  { code: 'zht', name: '繁體中文', bcp47: 'zh-Hant' },
  { code: 'ja', name: '日本語', bcp47: 'ja' },
  { code: 'ko', name: '한국어', bcp47: 'ko' },
  { code: 'es', name: 'Español', bcp47: 'es' },
  { code: 'fr', name: 'Français', bcp47: 'fr' },
  { code: 'ru', name: 'Русский', bcp47: 'ru' },
  { code: 'th', name: 'ไทย', bcp47: 'th' },
  { code: 'vi', name: 'Tiếng Việt', bcp47: 'vi' },
  { code: 'de', name: 'Deutsch', bcp47: 'de' },
  { code: 'id', name: 'Bahasa Indonesia', bcp47: 'id' },
  { code: 'pt', name: 'Português', bcp47: 'pt' },
  { code: 'tr', name: 'Türkçe', bcp47: 'tr' },
  { code: 'it', name: 'Italiano', bcp47: 'it' },
];
const SHARED_KEY = 'miliastra-lang';
const LEGACY_KEY = 'miliastra-animator-lang';
const dicts = { en };
let current = 'en';
let dict = en;
const listeners = new Set();

export const isValidLang = (code) => LANGS.some((l) => l.code === code);
export const currentLang = () => current;
const bcp47Of = (code) => LANGS.find((l) => l.code === code)?.bcp47 ?? 'en';

export function t(key, params) {
  let s = dict[key] ?? en[key];
  if (s == null) s = key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

let nf = new Intl.NumberFormat('en');
export function num(v, opts) {
  if (v == null || v === '') return '';
  if (typeof v !== 'number') return String(v);
  return opts ? new Intl.NumberFormat(bcp47Of(current), opts).format(v) : nf.format(v);
}

export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const s = t(el.dataset.i18nTitle);
    el.title = s;
    if (!el.textContent.trim() || el.dataset.i18nAria != null) el.setAttribute('aria-label', s);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function setLanguage(code, persist = true) {
  if (!isValidLang(code)) code = 'en';
  if (!dicts[code]) {
    try { dicts[code] = (await import(`./locales/${code}.js`)).default; }
    catch (e) { console.warn('i18n: failed to load locale', code, e); dicts[code] = {}; }
  }
  current = code;
  dict = dicts[code];
  nf = new Intl.NumberFormat(bcp47Of(code));
  if (persist) { try { localStorage.setItem(SHARED_KEY, code); } catch {} }
  document.documentElement.lang = bcp47Of(code);
  applyI18n(document);
  for (const fn of listeners) fn(code);
}

export function detectLanguage() {
  try {
    const saved = localStorage.getItem(SHARED_KEY);
    if (saved && isValidLang(saved)) return saved;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && isValidLang(legacy)) {
      localStorage.setItem(SHARED_KEY, legacy);
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch {}
  const cands = navigator.languages || [navigator.language || 'en'];
  for (const cand of cands) {
    const nav = String(cand).toLowerCase();
    if (nav.startsWith('zh')) return /tw|hk|mo|hant/.test(nav) ? 'zht' : 'zhs';
    const two = nav.slice(0, 2);
    if (isValidLang(two)) return two;
  }
  return 'en';
}

export function initI18n() {
  window.addEventListener('storage', (e) => {
    if (e.key !== SHARED_KEY || !e.newValue) return;
    if (isValidLang(e.newValue) && e.newValue !== current) setLanguage(e.newValue, false);
  });
  const lang = detectLanguage();
  if (lang === 'en') {
    document.documentElement.lang = 'en';
    applyI18n(document);
    return Promise.resolve();
  }
  return setLanguage(lang, false);
}
