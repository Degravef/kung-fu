/** Tiny DOM helpers shared by the UI modules. */
export const $ = (sel, root = document) => root.querySelector(sel);

/** h('button', { className, onclick }, ...children) — props are assigned onto the element. */
export function h(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.flat().filter((k) => k != null));
  return node;
}
