// Scale Entire Model: uniform factor (presets, factor or percentage), resulting size and
// per-object scale preview, a warning (Cancel / Apply anyway) when an object would exceed
// Miliastra's maximum scale of 50, then one undoable whole-model scale.
import { t } from '../i18n/i18n.js';
import { h, button, btnRow, hint, numInput, fmt } from './dom.js';
import { customDialog, toast } from './dialogs.js';
import { MAX_OBJECT_SCALE } from '../gia/gia-export.js';

export async function showScaleModelDialog(editor) {
  let factor = 1;
  const body = h('div', { class: 'limit scale' });
  const info = h('div');
  const warn = h('div');
  const extent0 = editor.modelExtent();
  const factorIn = numInput(factor, (v) => setFactor(v), { step: 0.1, min: 0.0001, precision: 4 });
  const pctIn = numInput(100, (v) => setFactor(v / 100), { step: 10, min: 0.01, precision: 2 });
  const render = () => {
    info.innerHTML = '';
    const pred = editor.predictObjectScales(factor);
    const worst = pred.reduce((a, b) => (b.value > (a?.value ?? -1) ? b : a), null);
    const extent = extent0.map((v) => v * factor);
    info.append(h('div', { class: 'stat-grid' },
      h('span', { class: 'k', text: t('scale.factor') }), h('span', { class: 'v', text: `${fmt(factor, 4)}× (${fmt(factor * 100, 2)} %)` }),
      h('span', { class: 'k', text: t('scale.extent') }), h('span', { class: 'v', text: `${extent0.map((v) => fmt(v, 2)).join(' × ')} m → ${extent.map((v) => fmt(v, 2)).join(' × ')} m` }),
      h('span', { class: 'k', text: t('scale.largest') }), h('span', { class: 'v' + (worst?.over ? ' warn' : ''), text: worst ? `${worst.name}: ${fmt(worst.value / factor, 3)} → ${fmt(worst.value, 3)} (${t('scale.max', { max: MAX_OBJECT_SCALE })})` : '—' }),
    ));
    warn.innerHTML = '';
    const over = pred.filter((p) => p.over);
    if (over.length) {
      warn.append(hint(t('scale.overWarning', { n: over.length, max: MAX_OBJECT_SCALE }), 'err'));
      const list = h('div', { class: 'limit-table' });
      for (const o of over.slice(0, 12)) list.append(h('div', { class: 'limit-row bad' }, h('span', { text: o.name }), h('span', { text: o.guid != null ? String(o.guid) : '' }), h('span', { class: 'num', text: fmt(o.value, 2) }), h('span', { text: t('scale.axis', { axis: o.axes.join('/') }) })));
      if (over.length > 12) list.append(h('div', { class: 'limit-row' }, h('span', { text: t('scale.more', { n: over.length - 12 }) })));
      warn.append(list, hint(t('scale.overHint')));
    }
    // the footer button says "Apply anyway" while the result would exceed the limit
    if (footBtn) footBtn.textContent = over.length ? t('scale.applyAnyway') : t('scale.apply');
  };
  let footBtn = null;
  const setFactor = (v) => { if (!Number.isFinite(v) || v <= 0) return; factor = v; factorIn.value = fmt(factor, 4); pctIn.value = fmt(factor * 100, 2); render(); };
  body.append(
    hint(t('scale.explain')),
    h('div', { class: 'subhead-inline', text: t('scale.presets') }),
    btnRow(...[0.25, 0.5, 1, 2].map((f) => button(`${f}×`, () => setFactor(f), { cls: 'mini' }))),
    h('div', { class: 'row' }, h('span', { class: 'label', text: t('scale.factorLabel') }), factorIn),
    h('div', { class: 'row' }, h('span', { class: 'label', text: t('scale.percent') }), pctIn),
    info,
    warn,
    hint(t('scale.bakeNote')),
  );
  render();
  const r = await customDialog({ title: t('scale.title'), body, setup: (dlg) => { footBtn = dlg.querySelector('.dlg-foot button:last-child'); render(); }, buttons: [
    { label: t('btn.cancel'), value: () => 'cancel' },
    { label: t('scale.apply'), primary: true, value: () => 'apply' },
  ] });
  if (r !== 'apply') return;
  if (Math.abs(factor - 1) < 1e-12) { toast(t('scale.noop'), 'info'); return; }
  if (!editor.scaleModel(factor)) return;
  const over = editor.objectScaleViolations();
  toast(over.length ? t('scale.appliedOver', { f: fmt(factor, 4), n: over.length, max: MAX_OBJECT_SCALE }) : t('scale.applied', { f: fmt(factor, 4) }), over.length ? 'warn' : 'success', 5000);
}
