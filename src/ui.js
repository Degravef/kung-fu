import { JOINT_DEFS, REGIONS, childrenOf } from './skeleton/jointDefs.js';
import { POSES, POSE_ORDER } from './poses.js';
import { LANGS, getLang, setLang, onLangChange, t, formatNumber, channelLabel, sideLetter, regionName, partName, poseLabel, jointText } from './i18n/index.js';

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.flat().filter((k) => k != null));
  return node;
}

const VIEWS = ['body', 'head', 'handL', 'handR', 'feet'];

/**
 * DOM side of the demo: joint tree, inspector (sliders), toolbar, pose bar.
 * It talks to the rest of the app only through `actions` (see main.js).
 */
export function createUI(stickboy, actions) {
  const rows = new Map(); // joint name -> row button
  const groups = []; // { details, rows[] } for search filtering
  let sliders = []; // live sliders of the selected joint
  let readout = null;
  let selected = null;
  let hovered = null;
  const unlocked = new Set(); // 'joint.channel' keys whose slider runs the full -180..180

  /* ------------------------------------------------------------ tree */

  function makeRow(def, inHandGroup) {
    const j = jointText(def);
    const text = inHandGroup ? j.detail : j.short;
    const row = h(
      'button',
      { className: 'row', type: 'button', title: j.label },
      h('i', { className: `dot side-${def.side} ${def.kind}` }),
      h('span', { className: 'row-label', textContent: text, title: j.label }),
      h('code', { textContent: def.name }),
    );
    row.addEventListener('click', () => actions.select(def.name));
    row.addEventListener('pointerenter', () => actions.hover(def.name));
    row.addEventListener('pointerleave', () => actions.hover(null));
    rows.set(def.name, row);
    return row;
  }

  const noMatch = h('p', { className: 'muted no-match', hidden: true });

  /** (Re)build the joint list, keeping which groups were open and the current search. */
  function buildTree() {
    const body = $('#tree-body');
    const open = new Set([...body.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    const firstBuild = !body.firstChild;
    body.replaceChildren(noMatch);
    noMatch.textContent = t('no_match');
    rows.clear();
    groups.length = 0;
    for (const region of REGIONS) {
      const defs = JOINT_DEFS.filter((d) => d.region === region);
      const isHand = region.endsWith('hand');
      const details = h('details', { open: firstBuild ? region === 'Body' : open.has(region) });
      details.dataset.key = region;
      details.append(h('summary', {}, regionName(region), h('small', { textContent: `${defs.length}` })));
      const entry = { details, rows: [] };

      if (isHand) {
        for (const part of [...new Set(defs.map((d) => d.part))]) {
          const sub = h('details', { open: open.has(`${region}/${part}`) });
          sub.dataset.key = `${region}/${part}`;
          const partDefs = defs.filter((d) => d.part === part);
          sub.append(h('summary', {}, partName(part)));
          const subEntry = { details: sub, rows: [] };
          for (const d of partDefs) {
            const r = makeRow(d, true);
            sub.append(r);
            subEntry.rows.push({ def: d, row: r });
          }
          details.append(sub);
          groups.push(subEntry);
          entry.rows.push(...subEntry.rows);
        }
      } else {
        for (const d of defs) {
          const r = makeRow(d, false);
          details.append(r);
          entry.rows.push({ def: d, row: r });
        }
      }
      body.append(details);
      groups.push(entry);
    }

    const q = $('#search').value.trim().toLowerCase();
    if (q) filter(q);
    if (selected) rows.get(selected)?.setAttribute('aria-current', 'true');
  }

  function filter(q) {
    for (const g of groups) {
      let visible = 0;
      for (const { def, row } of g.rows) {
        const hit = !q || `${jointText(def).label} ${def.name} ${regionName(def.region)} ${def.part ? partName(def.part) : ''}`.toLowerCase().includes(q);
        row.hidden = !hit;
        visible += hit;
      }
      g.details.hidden = visible === 0;
      if (q && visible) g.details.open = true;
    }
    noMatch.hidden = !q || groups.some((g) => !g.details.hidden);
  }

  /* ------------------------------------------------------- inspector */

  function jointLink(name, current = false) {
    const def = stickboy.nodes.get(name).def;
    const j = jointText(def);
    const text = def.side === 'C' ? j.short : `${j.short} (${sideLetter(def.side)})`;
    const b = h('button', { type: 'button', className: `link${current ? ' current' : ''}`, textContent: text, title: j.label });
    if (!current) b.addEventListener('click', () => actions.select(name));
    return b;
  }

  function renderInspector() {
    const box = $('#inspector');
    box.replaceChildren();
    sliders = [];
    readout = null;

    if (!selected) {
      box.append(
        h('div', { className: 'empty' },
          h('h2', { textContent: t('empty_title') }),
          h('p', { textContent: t('empty_body') }),
          h('ul', {}, h('li', { textContent: t('empty_tip_colors') }), h('li', { textContent: t('empty_tip_fingers') })),
        ),
      );
      return;
    }

    const { def } = stickboy.nodes.get(selected);
    box.append(
      h('h2', { textContent: jointText(def).label }),
      h('div', {}, h('code', { className: 'code', textContent: def.name }), h('span', { className: 'badge', textContent: def.kind === 'joint' ? t(def.dof.length > 1 ? 'badge_channels_other' : 'badge_channels_one', { n: def.dof.length }) : t('badge_end') })),
    );

    const chain = stickboy.chain(selected);
    const crumbs = h('div', { className: 'crumbs' });
    chain.forEach((n, i) => {
      if (i) crumbs.append(h('span', { className: 'sep', textContent: '›' }));
      crumbs.append(jointLink(n, n === selected));
    });
    box.append(h('section', {}, h('h3', { textContent: t('sec_position') }), crumbs));

    const kids = childrenOf(selected);
    if (kids.length) {
      const chips = h('div', { className: 'chips' });
      kids.forEach((k) => chips.append(jointLink(k)));
      box.append(h('section', {}, h('h3', { textContent: t('sec_children') }), chips));
    }

    if (def.dof.length) {
      const sec = h('section', {}, h('h3', { textContent: t('sec_rotation') }));
      for (const d of def.dof) {
        const value = stickboy.values.get(selected)[d.channel];
        const key = `${selected}.${d.channel}`;
        const input = h('input', { type: 'range', step: 1, value, id: `ch-${d.channel}` });
        const out = h('output', { textContent: fmt(value) });
        const lock = h('button', { type: 'button', className: 'lock' });
        const range = h('span', { className: 'range' });
        const row = h('div', { className: 'channel', title: t('channel_title') },
          h('label', { htmlFor: input.id }, h('b', { textContent: d.channel }), channelLabel(d.label)),
          h('div', { className: 'ctl' }, input, out, lock),
          range,
        );
        // Locked = the joint's anatomical range; unlocked = the full -180..180.
        const applyLock = () => {
          const free = unlocked.has(key);
          input.min = free ? -180 : d.min;
          input.max = free ? 180 : d.max;
          input.value = stickboy.values.get(selected)[d.channel];
          lock.textContent = free ? '🔓' : '🔒';
          lock.setAttribute('aria-pressed', String(free));
          lock.title = lock.ariaLabel = t(free ? 'lock_free_title' : 'lock_locked_title', { min: d.min, max: d.max });
          range.textContent = free ? t('range_free') : t('range_locked', { min: d.min, max: d.max });
          row.classList.toggle('free', free);
        };
        lock.addEventListener('click', () => {
          if (unlocked.has(key)) {
            unlocked.delete(key);
            stickboy.setChannel(selected, d.channel, stickboy.values.get(selected)[d.channel]); // pull back inside the limits
            actions.edited();
          } else unlocked.add(key);
          applyLock();
          out.textContent = fmt(stickboy.values.get(selected)[d.channel]);
        });
        applyLock();
        input.addEventListener('input', () => {
          stickboy.setChannel(selected, d.channel, +input.value, unlocked.has(key));
          out.textContent = fmt(+input.value);
          actions.edited();
        });
        row.addEventListener('dblclick', (e) => {
          if (e.target === lock) return;
          stickboy.setChannel(selected, d.channel, 0, true);
          sync();
          actions.edited();
        });
        sliders.push({ input, out, channel: d.channel });
        sec.append(row);
      }
      sec.append(h('button', { className: 'btn', type: 'button', textContent: t('reset_joint'), onclick: () => { stickboy.resetJoint(selected); sync(); actions.edited(); } }));
      box.append(sec);
    } else {
      box.append(h('section', {}, h('p', { className: 'muted', textContent: t('end_note') })));
    }

    readout = h('dl', { className: 'readout' });
    box.append(
      h('section', {}, h('h3', { textContent: t('sec_world') }), readout),
      h('section', {}, h('button', { className: 'btn', type: 'button', textContent: t('focus_here'), onclick: () => actions.focus(selected) })),
    );
    updateReadout(true);
  }

  const fmt = (v) => `${Math.round(v)}°`;
  let lastReadout = '';

  function updateReadout(force = false) {
    if (!readout || !selected) return;
    const p = stickboy.worldPosition(selected);
    const cm = (v) => `${v >= 0 ? '+' : '−'}${formatNumber(Math.abs(v * 100))} cm`;
    const text = `${cm(p.x)}|${formatNumber(p.y * 100)} cm|${cm(p.z)}`;
    if (!force && text === lastReadout) return;
    lastReadout = text;
    const [x, y, z] = text.split('|');
    readout.replaceChildren(
      h('dt', { textContent: t('pos_lr') }), h('dd', { textContent: x }),
      h('dt', { textContent: t('pos_height') }), h('dd', { textContent: y }),
      h('dt', { textContent: t('pos_fb') }), h('dd', { textContent: z }),
    );
  }

  /** Push current channel values into the sliders (after a pose change). */
  function sync() {
    if (!selected) return;
    const ch = stickboy.values.get(selected);
    for (const s of sliders) {
      s.input.value = ch[s.channel];
      s.out.textContent = fmt(ch[s.channel]);
    }
  }

  /* --------------------------------------------------------- toolbar */

  function buildViews() {
    $('#views').replaceChildren(...VIEWS.map((key) => h('button', { className: 'btn', type: 'button', textContent: t(`view_${key}`), onclick: () => actions.view(key) })));
  }

  function buildToolbar() {
    buildViews();
    const select = $('#lang-select');
    select.replaceChildren(...LANGS.map((l) => h('option', { value: l.code, textContent: l.name })));
    select.addEventListener('change', () => setLang(select.value));
    $('#t-labels').addEventListener('change', (e) => actions.toggleLabels(e.target.checked));
    $('#t-bones').addEventListener('change', (e) => actions.toggleBones(e.target.checked));
    $('#t-ground').addEventListener('change', (e) => actions.toggleGround(e.target.checked));
  }

  const poseButtons = new Map();
  let activePose = null;
  function buildPoseBar() {
    const bar = $('#posebar');
    bar.replaceChildren();
    poseButtons.clear();
    for (const key of POSE_ORDER) {
      const b = h('button', { className: 'btn', type: 'button', textContent: poseLabel(key, POSES[key].label), onclick: () => actions.pose(key) });
      b.setAttribute('aria-pressed', String(key === activePose));
      poseButtons.set(key, b);
      bar.append(b);
    }
  }

  /** Static text in index.html: data-i18n="id" sets the text, data-i18n-attr="attr:id,…" sets attributes. */
  function applyStaticText() {
    document.documentElement.lang = getLang();
    document.title = t('app_title');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, id] = pair.split(':');
        el.setAttribute(attr, t(id));
      }
    }
    $('#lang-select').value = getLang();
  }

  function relocalize() {
    applyStaticText();
    buildTree();
    buildViews();
    buildPoseBar();
    renderInspector();
  }

  /** Scroll the joint list (not the page) just enough to show `row`, clear of the sticky header. */
  function scrollRowIntoView(row) {
    const panel = $('#tree');
    const head = $('.panel-head');
    const stuck = getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0;
    const r = row.getBoundingClientRect();
    const c = panel.getBoundingClientRect();
    if (r.top < c.top + stuck) panel.scrollTop -= c.top + stuck - r.top + 8;
    else if (r.bottom > c.bottom) panel.scrollTop += r.bottom - c.bottom + 8;
  }

  /* ----------------------------------------------------------- public */

  buildToolbar();
  $('#search').addEventListener('input', (e) => filter(e.target.value.trim().toLowerCase()));
  relocalize();
  onLangChange(relocalize);

  return {
    select(name) {
      if (selected) rows.get(selected)?.removeAttribute('aria-current');
      selected = name;
      if (name) {
        const row = rows.get(name);
        row.setAttribute('aria-current', 'true');
        for (let d = row.parentElement; d && d.id !== 'tree-body'; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
        scrollRowIntoView(row);
      }
      renderInspector();
    },
    hover(name) {
      if (hovered) rows.get(hovered)?.classList.remove('hover');
      hovered = name;
      if (name) rows.get(name)?.classList.add('hover');
    },
    setActivePose(key) {
      activePose = key;
      for (const [k, b] of poseButtons) b.setAttribute('aria-pressed', String(k === key));
    },
    sync,
    tick: () => updateReadout(),
  };
}
