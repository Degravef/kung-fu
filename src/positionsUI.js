import { $, h } from './dom.js';
import { PARTS, SIDED, allPositions, addPosition, removePosition, renamePosition, capturePosition, applyPosition, serialize, countPositions, parseLibrary, mergeLibrary, loadLibrary, emptyLibrary } from './positions.js';
import { t, sideLetter, positionName, onLangChange } from './i18n/index.js';

const STORAGE_KEY = 'kungfu.positions';
const FILE_NAME = 'kungfu-positions.json';

/**
 * The "Positions" tab: save / apply / rename / delete positions of a body part, and export / import
 * them as a file. The library of user positions lives in localStorage; built-ins are read-only.
 */
export function createPositionsPanel(stickboy, { applied }) {
  const root = $('#positions');
  let part = 'hand';
  let takeSide = 'L'; // which side "save" reads from
  let status = null; // { text, details[] }
  let storageOk = true;

  const load = () => {
    try {
      return loadLibrary(localStorage.getItem(STORAGE_KEY));
    } catch {
      storageOk = false;
      return emptyLibrary();
    }
  };
  let lib = load();

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, serialize(lib));
      storageOk = true;
    } catch {
      storageOk = false;
    }
  }

  const say = (text, details = []) => {
    status = { text, details };
    renderStatus();
  };

  const sideWord = (side) => (side === 'both' ? t('side_both') : t(`side_${side}`));

  /* -------------------------------------------------------------- actions */

  function apply(pos, side) {
    const clamped = applyPosition(stickboy, part, side, pos);
    applied();
    say(t('pos_applied', { name: positionName(pos), side: SIDED[part] ? sideWord(side) : t('part_torso') }), clamped.length ? [t('pos_clamped', { n: clamped.length })] : []);
  }

  function save(name) {
    const entry = addPosition(lib, part, name, capturePosition(stickboy, part, takeSide));
    persist();
    render();
    say(t('pos_saved', { name: entry.name }));
  }

  function exportFile() {
    const n = countPositions(lib);
    if (!n) return say(t('pos_export_none'));
    const url = URL.createObjectURL(new Blob([serialize(lib)], { type: 'application/json' }));
    const a = h('a', { href: url, download: FILE_NAME });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(t('pos_exported', { n, file: FILE_NAME }));
  }

  async function importFile(file) {
    if (!file) return;
    const r = parseLibrary(await file.text());
    if (r.fatal) return say(t('pos_import_failed', { reason: r.errors[0] }));
    const { added, replaced } = mergeLibrary(lib, r.library);
    if (!added && !replaced) return say(r.errors.length ? t('pos_import_skipped', { n: r.errors.length }) : t('pos_import_empty'), r.errors);
    persist();
    render();
    const details = [];
    if (r.errors.length) details.push(t('pos_import_skipped', { n: r.errors.length }), ...r.errors);
    if (r.warnings.length) details.push(t('pos_import_clamped', { n: r.warnings.length }));
    say(t('pos_import_done', { added, replaced }), details);
  }

  /* ---------------------------------------------------------------- render */

  const seg = (items, current, onPick, label) =>
    h('div', { className: 'seg', role: 'group', ariaLabel: label }, ...items.map(([key, text, title]) => {
      const b = h('button', { type: 'button', className: 'btn', textContent: text, title: title ?? text, onclick: () => onPick(key) });
      b.setAttribute('aria-pressed', String(key === current));
      return b;
    }));

  function row(pos) {
    const name = positionName(pos);
    const apply1 = (label, side, title) => h('button', { type: 'button', className: 'btn mini', textContent: label, title, ariaLabel: title, onclick: () => apply(pos, side) });
    const actions = SIDED[part]
      ? [
          apply1(sideLetter('L'), 'L', t('pos_apply_to', { name, side: t('side_L') })),
          apply1(sideLetter('R'), 'R', t('pos_apply_to', { name, side: t('side_R') })),
          apply1(`${sideLetter('L')}+${sideLetter('R')}`, 'both', t('pos_apply_to', { name, side: t('side_both') })),
        ]
      : [apply1(t('pos_apply'), null, t('pos_apply_to', { name, side: t('part_torso') }))];
    if (!pos.builtin) {
      actions.push(
        h('button', {
          type: 'button', className: 'btn mini ghost', textContent: '✎', title: t('pos_rename'), ariaLabel: `${t('pos_rename')}: ${name}`,
          onclick: () => {
            const next = window.prompt(t('pos_rename_prompt'), pos.name);
            if (next && renamePosition(lib, part, pos.id, next)) { persist(); render(); }
          },
        }),
        h('button', {
          type: 'button', className: 'btn mini ghost', textContent: '🗑', title: t('pos_delete'), ariaLabel: `${t('pos_delete')}: ${name}`,
          onclick: () => {
            if (!window.confirm(t('pos_delete_confirm', { name }))) return;
            removePosition(lib, part, pos.id);
            persist();
            render();
            say(t('pos_deleted', { name }));
          },
        }),
      );
    }
    return h('li', { className: 'pos-row' }, h('span', { className: 'pos-name', textContent: name, title: name }), h('span', { className: 'pos-actions' }, ...actions));
  }

  function renderStatus() {
    const box = $('#pos-status', root);
    if (!box) return;
    box.replaceChildren();
    if (!status) return;
    box.append(h('p', { textContent: status.text }));
    if (status.details.length) {
      const shown = status.details.slice(0, 8);
      box.append(h('ul', {}, ...shown.map((d) => h('li', { textContent: d })), status.details.length > 8 ? h('li', { textContent: `… +${status.details.length - 8}` }) : null));
    }
  }

  function render() {
    const user = lib.positions[part];
    const input = h('input', { type: 'text', className: 'pos-name-input', placeholder: t('pos_name_placeholder'), ariaLabel: t('pos_name_label'), maxLength: 60, autocomplete: 'off' });
    const saveBtn = h('button', { type: 'button', className: 'btn primary', textContent: t('pos_save', { part: t(`part_${part}`).toLowerCase() }), onclick: () => save(input.value) });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save(input.value));
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', () => {
      importFile(fileInput.files[0]);
      fileInput.value = '';
    });

    root.replaceChildren(
      h('p', { className: 'muted pos-intro', textContent: t('pos_intro') }),
      h('h3', { textContent: t('pos_part_label') }),
      seg(PARTS.map((p) => [p, t(`part_${p}`)]), part, (p) => { part = p; render(); }, t('pos_part_label')),
      SIDED[part] ? h('div', { className: 'take' }, h('span', { className: 'muted', textContent: t('pos_take_from') }), seg([['L', t('side_L')], ['R', t('side_R')]], takeSide, (s) => { takeSide = s; render(); }, t('pos_take_from'))) : null,
      h('div', { className: 'pos-save' }, input, saveBtn),
      h('h3', { textContent: t('pos_yours') }),
      user.length ? h('ul', { className: 'pos-list' }, ...user.map(row)) : h('p', { className: 'muted', textContent: t('pos_none') }),
      h('h3', { textContent: t('pos_builtin') }),
      h('ul', { className: 'pos-list' }, ...allPositions(emptyLibrary(), part).map(row)),
      h('div', { className: 'pos-io' },
        h('button', { type: 'button', className: 'btn', textContent: t('pos_export'), onclick: exportFile }),
        h('button', { type: 'button', className: 'btn', textContent: t('pos_import'), onclick: () => fileInput.click() }),
        fileInput,
      ),
      storageOk ? null : h('p', { className: 'muted warn', textContent: t('pos_storage_off') }),
      h('div', { id: 'pos-status', className: 'pos-status', role: 'status', 'aria-live': 'polite' }),
    );
    renderStatus();
  }

  /* ------------------------------------------------------------------ tabs */

  function showTab(name) {
    const joints = name === 'joints';
    $('#tree-body').hidden = !joints;
    $('#search').hidden = !joints;
    root.hidden = joints;
    for (const b of document.querySelectorAll('.tab')) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

  render();
  onLangChange(render);
  return { showTab };
}
