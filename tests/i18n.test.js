import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import en from '../src/i18n/en.js';
import fr from '../src/i18n/fr.js';
import nl from '../src/i18n/nl.js';
import { LANGS, setLang, t, detectLang, jointText, channelLabel, regionName, partName, poseLabel, formatNumber } from '../src/i18n/index.js';
import { JOINT_DEFS, REGIONS } from '../src/skeleton/jointDefs.js';
import { POSES, POSE_ORDER } from '../src/poses.js';

const OTHERS = { 'fr-BE': fr, 'nl-BE': nl };
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every language offers the same interface ids, with the same {placeholders}', () => {
  for (const [code, d] of Object.entries(OTHERS)) {
    assert.deepEqual(Object.keys(d.ui).sort(), Object.keys(en.ui).sort(), `${code}: ui ids differ from en.js`);
    for (const id of Object.keys(en.ui)) {
      assert.ok(d.ui[id].trim(), `${code}.${id} is empty`);
      assert.equal(placeholders(d.ui[id]), placeholders(en.ui[id]), `${code}.${id}: placeholders differ`);
    }
  }
});

test('every data-i18n id used in index.html, and every t("…") id used in src, exists in en.js', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/data-i18n="(\w+)"/g)].map((m) => m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(',')) ids.push(p.split(':')[1]);
  for (const f of ['ui.js', 'main.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'(\w+)'/g)) ids.push(m[1]);
  }
  const missing = [...new Set(ids)].filter((id) => !(id in en.ui));
  assert.deepEqual(missing, [], `ids used but not defined in en.js: ${missing}`);
});

test('every channel description, region, finger part and pose is translated', () => {
  const labels = new Set(JOINT_DEFS.flatMap((d) => d.dof.map((c) => c.label)));
  for (const [code, d] of Object.entries(OTHERS)) {
    const miss = [...labels].filter((l) => !d.channels[l]);
    assert.deepEqual(miss, [], `${code}: untranslated channel labels`);
    const stale = Object.keys(d.channels).filter((l) => !labels.has(l));
    assert.deepEqual(stale, [], `${code}: translations for labels that no longer exist`);
    for (const r of REGIONS) assert.ok(d.regions[r], `${code}: region ${r}`);
    for (const p of new Set(JOINT_DEFS.map((j) => j.part).filter(Boolean))) assert.ok(d.parts[p], `${code}: part ${p}`);
    for (const k of POSE_ORDER) assert.ok(d.poses[k], `${code}: pose ${k}`);
    // ±(+)/(−) direction hints must survive translation
    for (const [src, tr] of Object.entries(d.channels)) {
      assert.equal(/\(\+\)/.test(tr), /\(\+\)/.test(src), `${code}: (+) hint lost in "${tr}"`);
      assert.equal(/\(−\)/.test(tr), /\(−\)/.test(src), `${code}: (−) hint lost in "${tr}"`);
    }
  }
});

test('all 65 joints get a distinct, non-empty translated name in every language', () => {
  for (const code of ['fr-BE', 'nl-BE']) {
    setLang(code);
    const seen = new Map();
    for (const def of JOINT_DEFS) {
      const { label, short, detail } = jointText(def);
      assert.ok(label && short && detail, `${code}/${def.name}: empty text`);
      assert.ok(!/\b(Left|Right|knuckle|Thumb|fingertip|Shoulder|Elbow)\b/ /* 'Index' is also French */.test(label), `${code}/${def.name}: English leaked: ${label}`);
      assert.ok(!seen.has(label), `${code}: "${label}" used by both ${seen.get(label)} and ${def.name}`);
      seen.set(label, def.name);
    }
    assert.equal(seen.size, JOINT_DEFS.length);
  }
  setLang('en');
});

test('side agreement and word order', () => {
  const byName = (n) => JOINT_DEFS.find((d) => d.name === n);
  setLang('fr-BE');
  assert.equal(jointText(byName('shoulder_L')).label, 'Épaule gauche');
  assert.equal(jointText(byName('shoulder_R')).label, 'Épaule droite'); // féminin
  assert.equal(jointText(byName('elbow_R')).label, 'Coude droit'); // masculin
  assert.equal(jointText(byName('index_pip_R')).label, 'Index droit · articulation médiane (PIP)');
  setLang('nl-BE');
  assert.equal(jointText(byName('elbow_L')).label, 'Linkerelleboog');
  assert.equal(jointText(byName('wrist_R')).label, 'Rechterpols');
  assert.equal(jointText(byName('thumb_tip_L')).label, 'Linkerduim · top');
  setLang('en');
  assert.equal(jointText(byName('elbow_L')).label, 'Left elbow');
});

test('t() fills placeholders, falls back to English / the id, and numbers follow the locale', () => {
  setLang('fr-BE');
  assert.equal(t('badge_channels_other', { n: 3 }), '3 canaux');
  assert.equal(t('definitely_not_an_id'), 'definitely_not_an_id');
  assert.equal(formatNumber(12.34), '12,3');
  setLang('nl-BE');
  assert.equal(formatNumber(12.34), '12,3');
  assert.equal(channelLabel('not a known label'), 'not a known label');
  assert.equal(poseLabel('nope', 'Fallback'), 'Fallback');
  setLang('en');
  assert.equal(formatNumber(12.34), '12.3');
  assert.equal(regionName('Left hand'), 'Left hand');
  assert.equal(partName('Pinky'), 'Pinky');
  assert.equal(poseLabel('guard', POSES.guard.label), 'Ready stance');
});

test('language detection: saved choice wins, fr/nl map to the Belgian variants, otherwise English', () => {
  assert.equal(detectLang('nl-BE', ['fr-FR']), 'nl-BE');
  assert.equal(detectLang(null, ['fr-FR', 'en']), 'fr-BE');
  assert.equal(detectLang(null, ['fr-CH']), 'fr-BE');
  assert.equal(detectLang(null, ['nl']), 'nl-BE');
  assert.equal(detectLang('xx', ['de-DE']), 'en');
  assert.equal(detectLang(undefined, []), 'en');
  assert.deepEqual(LANGS.map((l) => l.code), ['en', 'fr-BE', 'nl-BE']);
});

test('compact side letters: G/D in French, L/R otherwise', async () => {
  const { sideLetter } = await import('../src/i18n/index.js');
  setLang('fr-BE');
  assert.deepEqual([sideLetter('L'), sideLetter('R')], ['G', 'D']);
  setLang('nl-BE');
  assert.deepEqual([sideLetter('L'), sideLetter('R')], ['L', 'R']);
  setLang('en');
  assert.deepEqual([sideLetter('L'), sideLetter('R')], ['L', 'R']);
});
