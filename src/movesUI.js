import { h } from './dom.js';
import { POSES, POSE_ORDER } from './poses.js';
import { addMove, updateMove, removePosition, DURATION, MAX_STEPS } from './positions.js';
import { t, poseLabel } from './i18n/index.js';

const DEFAULT_SECONDS = 0.5;

/**
 * The "Move" mode of the Positions tab: build an ordered list of poses (each with the seconds taken to
 * blend into it), preview it, save it, edit / play / delete saved moves. The draft lives here; saved
 * moves live in the library owned by positionsUI.
 */
export function createMoveBuilder({ getLib, persist, rerender, say, movesChanged, playSteps, playMove }) {
  let draft = { id: null, name: '', steps: [] }; // id is set while editing a saved move
  let addChoice = POSE_ORDER[1];
  let nameInput = null; // the name field currently on screen

  const poseName = (key) => {
    if (POSES[key]) return poseLabel(key, POSES[key].label);
    const p = getLib().poses.find((x) => x.id === key);
    return p ? `★ ${p.name}` : t('mv_missing');
  };
  const options = () => [...POSE_ORDER.map((k) => [k, poseLabel(k, POSES[k].label)]), ...getLib().poses.map((p) => [p.id, `★ ${p.name}`])];
  const clampSeconds = (v) => Math.min(DURATION.max, Math.max(DURATION.min, Number.isFinite(v) ? v : DEFAULT_SECONDS));
  const reset = () => { draft = { id: null, name: '', steps: [] }; };

  function save() {
    if (nameInput) draft.name = nameInput.value; // read the field itself, not only 'input' events (autofill, paste…)
    if (!draft.steps.length) return say(t('mv_need_steps'));
    const lib = getLib();
    let entry;
    if (draft.id) {
      entry = updateMove(lib, draft.id, draft.name, draft.steps);
      say(t('mv_updated', { name: entry.name }));
    } else {
      entry = addMove(lib, draft.name, draft.steps);
      say(t('mv_saved', { name: entry.name }));
    }
    persist();
    movesChanged();
    reset();
    rerender();
  }

  const iconBtn = (text, title, onclick, disabled = false) =>
    h('button', { type: 'button', className: 'btn mini ghost', textContent: text, title, ariaLabel: title, disabled, onclick });

  function stepRow(step, i) {
    const last = draft.steps.length - 1;
    const seconds = h('input', { type: 'number', className: 'mv-seconds', min: DURATION.min, max: DURATION.max, step: 0.05, value: step.duration, ariaLabel: `${t('mv_duration')} (${i + 1})` });
    seconds.addEventListener('input', () => { if (seconds.value !== '') step.duration = clampSeconds(+seconds.value); });
    seconds.addEventListener('change', () => { step.duration = clampSeconds(+seconds.value); seconds.value = step.duration; });
    const missing = !POSES[step.pose] && !getLib().poses.some((p) => p.id === step.pose);
    return h('li', { className: `mv-step${missing ? ' missing' : ''}` },
      h('span', { className: 'mv-n', textContent: `${i + 1}.` }),
      h('span', { className: 'mv-pose', textContent: poseName(step.pose), title: poseName(step.pose) }),
      h('span', { className: 'mv-time' }, seconds, h('span', { className: 'muted', textContent: 's' })),
      iconBtn('↑', t('mv_up'), () => { [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; rerender(); }, i === 0),
      iconBtn('↓', t('mv_down'), () => { [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]]; rerender(); }, i === last),
      iconBtn('✕', t('mv_remove'), () => { draft.steps.splice(i, 1); rerender(); }),
    );
  }

  function savedRow(m) {
    const summary = m.steps.map((s) => poseName(s.pose)).join(' → ');
    return h('li', { className: 'pos-row mv-saved' },
      h('span', { className: 'pos-name' }, h('span', { textContent: m.name, title: m.name }), h('small', { className: 'muted mv-summary', textContent: summary, title: summary })),
      h('span', { className: 'pos-actions' },
        h('button', { type: 'button', className: 'btn mini', textContent: '▶', title: t('mv_play_title', { name: m.name }), ariaLabel: t('mv_play_title', { name: m.name }), onclick: () => playMove(m.id) }),
        h('button', { type: 'button', className: 'btn mini', textContent: t('mv_edit'), title: `${t('mv_edit')}: ${m.name}`, onclick: () => { draft = { id: m.id, name: m.name, steps: m.steps.map((s) => ({ ...s })) }; rerender(); } }),
        h('button', {
          type: 'button', className: 'btn mini ghost', textContent: '🗑', title: t('pos_delete'), ariaLabel: `${t('pos_delete')}: ${m.name}`,
          onclick: () => {
            if (!window.confirm(t('pos_delete_confirm', { name: m.name }))) return;
            removePosition(getLib(), 'move', m.id);
            if (draft.id === m.id) reset();
            persist();
            movesChanged();
            rerender();
            say(t('pos_deleted', { name: m.name }));
          },
        }),
      ),
    );
  }

  /** The DOM nodes of the Move mode (everything between the part picker and Export / Import). */
  function render() {
    const lib = getLib();
    const opts = options();
    if (!opts.some(([k]) => k === addChoice)) addChoice = opts[0][0];
    const name = h('input', { type: 'text', className: 'pos-name-input', placeholder: t('mv_name_placeholder'), ariaLabel: t('mv_name_label'), maxLength: 60, autocomplete: 'off', value: draft.name });
    name.addEventListener('input', () => { draft.name = name.value; });
    nameInput = name;
    const select = h('select', { className: 'btn mv-select', ariaLabel: t('mv_add_pose_label') }, ...opts.map(([k, label]) => h('option', { value: k, textContent: label, selected: k === addChoice })));
    select.addEventListener('change', () => { addChoice = select.value; });
    const add = h('button', {
      type: 'button', className: 'btn', textContent: t('mv_add'), disabled: draft.steps.length >= MAX_STEPS,
      onclick: () => { draft.steps.push({ pose: addChoice, duration: draft.steps.length ? DEFAULT_SECONDS : 0.6 }); rerender(); },
    });
    const editing = draft.id ? lib.moves.find((m) => m.id === draft.id) : null;

    return [
      editing ? h('p', { className: 'mv-editing', textContent: t('mv_editing', { name: editing.name }) }) : null,
      h('div', { className: 'pos-save' }, name),
      h('h3', { textContent: t('mv_steps') }),
      draft.steps.length ? h('ol', { className: 'mv-steps' }, ...draft.steps.map(stepRow)) : h('p', { className: 'muted', textContent: t('mv_no_steps') }),
      h('div', { className: 'mv-add' }, select, add),
      h('div', { className: 'mv-actions' },
        h('button', { type: 'button', className: 'btn', textContent: `▶ ${t('mv_preview')}`, disabled: !draft.steps.length, onclick: () => playSteps(draft.steps) }),
        h('button', { type: 'button', className: 'btn primary', textContent: editing ? t('mv_update', { name: editing.name }) : t('mv_save'), disabled: !draft.steps.length, onclick: save }),
        draft.id || draft.steps.length || draft.name ? h('button', { type: 'button', className: 'btn ghost', textContent: t('mv_new'), onclick: () => { reset(); rerender(); } }) : null,
      ),
      h('h3', { textContent: t('mv_yours') }),
      lib.moves.length ? h('ul', { className: 'pos-list' }, ...lib.moves.map(savedRow)) : h('p', { className: 'muted', textContent: t('mv_none') }),
    ];
  }

  return { render };
}
