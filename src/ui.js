import { JOINT_DEFS, REGIONS, childrenOf } from './skeleton/jointDefs.js';
import { POSES, POSE_ORDER } from './poses.js';

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.flat().filter((k) => k != null));
  return node;
}

const VIEWS = [
  ['body', 'Full body'],
  ['head', 'Head'],
  ['handL', 'Left hand'],
  ['handR', 'Right hand'],
  ['feet', 'Feet'],
];

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

  /* ------------------------------------------------------------ tree */

  function makeRow(def, inHandGroup) {
    const text = inHandGroup ? (def.short.split(' · ')[1] ?? def.short) : def.short;
    const row = h(
      'button',
      { className: 'row', type: 'button', title: def.label },
      h('i', { className: `dot side-${def.side} ${def.kind}` }),
      h('span', { className: 'row-label', textContent: text }),
      h('code', { textContent: def.name }),
    );
    row.addEventListener('click', () => actions.select(def.name));
    row.addEventListener('pointerenter', () => actions.hover(def.name));
    row.addEventListener('pointerleave', () => actions.hover(null));
    rows.set(def.name, row);
    return row;
  }

  function buildTree() {
    const body = $('#tree-body');
    for (const region of REGIONS) {
      const defs = JOINT_DEFS.filter((d) => d.region === region);
      const isHand = region.endsWith('hand');
      const details = h('details', { open: region === 'Body' });
      details.append(h('summary', {}, region, h('small', { textContent: `${defs.length}` })));
      const entry = { details, rows: [] };

      if (isHand) {
        for (const part of [...new Set(defs.map((d) => d.part))]) {
          const sub = h('details', { open: false });
          const partDefs = defs.filter((d) => d.part === part);
          sub.append(h('summary', {}, part));
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

    $('#search').addEventListener('input', (e) => filter(e.target.value.trim().toLowerCase()));
  }

  function filter(q) {
    for (const g of groups) {
      let visible = 0;
      for (const { def, row } of g.rows) {
        const hit = !q || `${def.label} ${def.name}`.toLowerCase().includes(q);
        row.hidden = !hit;
        visible += hit;
      }
      g.details.hidden = visible === 0;
      if (q && visible) g.details.open = true;
    }
  }

  /* ------------------------------------------------------- inspector */

  function jointLink(name, current = false) {
    const def = stickboy.nodes.get(name).def;
    const b = h('button', { type: 'button', className: `link${current ? ' current' : ''}`, textContent: def.short, title: name });
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
          h('h2', { textContent: 'No joint selected' }),
          h('p', { textContent: 'Click any joint — in the 3D view or in the list — to see its name, where it sits in the skeleton, and to rotate it.' }),
          h('ul', {}, h('li', { textContent: 'Cyan = left side, orange = right side, white = centre line.' }), h('li', { textContent: 'Fingers are tiny: use the Left hand / Right hand views, or double-click a joint to fly to it.' })),
        ),
      );
      return;
    }

    const { def } = stickboy.nodes.get(selected);
    box.append(
      h('h2', { textContent: def.label }),
      h('div', {}, h('code', { className: 'code', textContent: def.name }), h('span', { className: 'badge', textContent: def.kind === 'joint' ? `${def.dof.length} channel${def.dof.length > 1 ? 's' : ''}` : 'end point' })),
    );

    const chain = stickboy.chain(selected);
    const crumbs = h('div', { className: 'crumbs' });
    chain.forEach((n, i) => {
      if (i) crumbs.append(h('span', { className: 'sep', textContent: '›' }));
      crumbs.append(jointLink(n, n === selected));
    });
    box.append(h('section', {}, h('h3', { textContent: 'Position in skeleton' }), crumbs));

    const kids = childrenOf(selected);
    if (kids.length) {
      const chips = h('div', { className: 'chips' });
      kids.forEach((k) => chips.append(jointLink(k)));
      box.append(h('section', {}, h('h3', { textContent: 'Moves with it' }), chips));
    }

    if (def.dof.length) {
      const sec = h('section', {}, h('h3', { textContent: 'Rotation (degrees)' }));
      for (const d of def.dof) {
        const value = stickboy.values.get(selected)[d.channel];
        const input = h('input', { type: 'range', min: d.min, max: d.max, step: 1, value, id: `ch-${d.channel}` });
        const out = h('output', { textContent: fmt(value) });
        const row = h('div', { className: 'channel', title: 'Double-click to reset this channel' },
          h('label', { htmlFor: input.id }, h('b', { textContent: d.channel }), d.label),
          h('div', { className: 'ctl' }, input, out),
        );
        input.addEventListener('input', () => {
          stickboy.setChannel(selected, d.channel, +input.value);
          out.textContent = fmt(+input.value);
          actions.edited();
        });
        row.addEventListener('dblclick', () => {
          stickboy.setChannel(selected, d.channel, 0);
          sync();
          actions.edited();
        });
        sliders.push({ input, out, channel: d.channel });
        sec.append(row);
      }
      sec.append(h('button', { className: 'btn', type: 'button', textContent: 'Reset this joint', onclick: () => { stickboy.resetJoint(selected); sync(); actions.edited(); } }));
      box.append(sec);
    } else {
      box.append(h('section', {}, h('p', { className: 'muted', textContent: 'End point: nothing to rotate here. It follows the joint above it, and marks where that bone ends.' })));
    }

    readout = h('dl', { className: 'readout' });
    box.append(
      h('section', {}, h('h3', { textContent: 'World position' }), readout),
      h('section', {}, h('button', { className: 'btn', type: 'button', textContent: 'Focus camera here', onclick: () => actions.focus(selected) })),
    );
    updateReadout(true);
  }

  const fmt = (v) => `${Math.round(v)}°`;
  let lastReadout = '';

  function updateReadout(force = false) {
    if (!readout || !selected) return;
    const p = stickboy.worldPosition(selected);
    const cm = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} cm`;
    const text = `${cm(p.x)}|${(p.y * 100).toFixed(1)} cm|${cm(p.z)}`;
    if (!force && text === lastReadout) return;
    lastReadout = text;
    const [x, y, z] = text.split('|');
    readout.replaceChildren(
      h('dt', { textContent: 'Left (+) / right (−)' }), h('dd', { textContent: x }),
      h('dt', { textContent: 'Height' }), h('dd', { textContent: y }),
      h('dt', { textContent: 'Forward (+) / back (−)' }), h('dd', { textContent: z }),
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

  function buildToolbar() {
    const views = $('#views');
    for (const [key, label] of VIEWS) views.append(h('button', { className: 'btn', type: 'button', textContent: label, onclick: () => actions.view(key) }));
    $('#t-labels').addEventListener('change', (e) => actions.toggleLabels(e.target.checked));
    $('#t-bones').addEventListener('change', (e) => actions.toggleBones(e.target.checked));
    $('#t-ground').addEventListener('change', (e) => actions.toggleGround(e.target.checked));
  }

  const poseButtons = new Map();
  function buildPoseBar() {
    const bar = $('#posebar');
    for (const key of POSE_ORDER) {
      const b = h('button', { className: 'btn', type: 'button', textContent: POSES[key].label, onclick: () => actions.pose(key) });
      b.setAttribute('aria-pressed', 'false');
      poseButtons.set(key, b);
      bar.append(b);
    }
  }

  /* ----------------------------------------------------------- public */

  buildTree();
  buildToolbar();
  buildPoseBar();
  renderInspector();

  return {
    select(name) {
      if (selected) rows.get(selected)?.removeAttribute('aria-current');
      selected = name;
      if (name) {
        const row = rows.get(name);
        row.setAttribute('aria-current', 'true');
        for (let d = row.parentElement; d && d.id !== 'tree-body'; d = d.parentElement) if (d.tagName === 'DETAILS') d.open = true;
        row.scrollIntoView({ block: 'nearest' });
      }
      renderInspector();
    },
    hover(name) {
      if (hovered) rows.get(hovered)?.classList.remove('hover');
      hovered = name;
      if (name) rows.get(name)?.classList.add('hover');
    },
    setActivePose(key) {
      for (const [k, b] of poseButtons) b.setAttribute('aria-pressed', String(k === key));
    },
    sync,
    tick: () => updateReadout(),
  };
}
