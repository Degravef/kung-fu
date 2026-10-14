import en from './en.js';
import fr from './fr.js';
import nl from './nl.js';

/**
 * Tiny i18n layer (no dependencies, no DOM — so it can be tested in Node).
 *
 * - English is the source: UI strings are ids in en.js; joint names / channel texts
 *   / pose labels stay in the data files and are translated by lookup or composition.
 * - Anything missing in a language falls back to English, so a gap never shows a blank.
 */

export const LANGS = [
  { code: 'en', name: 'English' },
  { code: 'fr-BE', name: 'Français (Belgique)' },
  { code: 'nl-BE', name: 'Nederlands (België)' },
];

const DICTS = { en, 'fr-BE': fr, 'nl-BE': nl };
const listeners = new Set();
let lang = 'en';

export const getLang = () => lang;

export function setLang(code) {
  if (!DICTS[code] || code === lang) return;
  lang = code;
  for (const fn of listeners) fn(code);
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pick a supported language from a saved choice, then the browser's preferences, else English. */
export function detectLang(saved, preferred = []) {
  if (DICTS[saved]) return saved;
  for (const p of preferred) {
    const base = String(p).toLowerCase().split('-')[0];
    if (base === 'fr') return 'fr-BE';
    if (base === 'nl') return 'nl-BE';
    if (base === 'en') return 'en';
  }
  return 'en';
}

const dict = () => DICTS[lang];
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s);

/** Interface string by id, with {placeholders}. */
export function t(id, vars) {
  return fill(dict().ui?.[id] ?? en.ui[id] ?? id, vars);
}

/** Locale-aware number (fr-BE / nl-BE use a decimal comma). */
export function formatNumber(n, digits = 1) {
  return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

/** Compact side marker for links: L/R in English and Dutch, G/D in French. */
export const sideLetter = (side) => dict().sideLetter?.[side] ?? side;

export const channelLabel = (englishLabel) => dict().channels?.[englishLabel] ?? englishLabel;
export const regionName = (region) => dict().regions?.[region] ?? region;
export const partName = (part) => dict().parts?.[part] ?? part;
export const moveLabel = (key, fallback) => dict().moves?.[key] ?? fallback;
export const poseLabel = (key, fallback) => dict().poses?.[key] ?? fallback;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Translated { label, short, detail } for a joint definition.
 *  label  = full name incl. side            ("Épaule gauche", "Linkerschouder")
 *  short  = name without the side           ("Épaule", "Schouder")
 *  detail = for finger joints, just the joint part ("articulation de base (MCP)") — used inside a finger group
 */
export function jointText(def) {
  const d = dict();
  if (d === en) return { label: def.label, short: def.short, detail: def.short.split(' · ')[1] ?? def.short };

  const base = def.name.replace(/_[LR]$/, '');
  const prefix = d.sidePlacement === 'prefix';
  const sideWord = (gender) => (def.side === 'C' ? '' : d.side[def.side][gender ?? 'm']);

  // Fingers: "<finger> <side> · <joint part>"
  if (def.part) {
    const id = base.split('_')[0];
    const jointKey = id === 'thumb' ? base : `finger_${base.split('_')[1]}`;
    const finger = (d.parts[def.part] ?? def.part).toLowerCase();
    const part = d.fingerJoints[jointKey] ?? def.short;
    const side = sideWord(d.fingerGender);
    const who = prefix ? `${side}${finger}` : [finger, side].filter(Boolean).join(' ');
    return { label: `${cap(who)} · ${part}`, short: `${cap(finger)} · ${part}`, detail: part };
  }

  const b = d.bases?.[base];
  if (!b) return { label: def.label, short: def.short, detail: def.short };
  const side = sideWord(b.g);
  const name = prefix ? `${side}${b.n}` : [b.n, side].filter(Boolean).join(' ');
  const label = cap([name, b.d].filter(Boolean).join(' '));
  const short = cap([b.n, b.d].filter(Boolean).join(' '));
  return { label, short, detail: short };
}
