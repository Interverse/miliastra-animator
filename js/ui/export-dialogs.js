// Export-time path point limit: warning → automatic compression → preview → export / cancel,
// plus the manual "Simplify path…" dialog for waypaths.
import { t } from '../i18n/i18n.js';
import { h, button, hint, checkbox, slider, fmt } from './dom.js';
import { customDialog } from './dialogs.js';
import { compressPlan, MAX_PATH_POINTS, GAME_PATH_POINTS } from '../gia/gia-export.js';
import { simplifyPolyline } from '../anim/path-compress.js';

const PREVIEW_ORIGINAL = 0x6b7482, PREVIEW_COMPRESSED = 0xf0b429;

function deviceTable(rows) {
  const table = h('div', { class: 'limit-table' });
  table.append(h('div', { class: 'limit-row head' }, h('span', { text: t('limit.colAnimation') }), h('span', { text: t('limit.colObject') }), h('span', { text: t('limit.colPoints') }), h('span', { text: t('limit.colStatus') })));
  for (const r of rows) table.append(h('div', { class: 'limit-row' + (r.ok === false ? ' bad' : r.ok ? ' good' : '') }, h('span', { text: r.animation }), h('span', { text: r.object }), h('span', { class: 'num', text: r.points }), h('span', { text: r.status })));
  return table;
}

// Returns { plan, remember } to export with, or null to cancel. Never touches the project.
export async function showPathLimitFlow(editor, plan, over) {
  // 1. warning
  const body = h('div', { class: 'limit' });
  body.append(hint(t('limit.message', { max: MAX_PATH_POINTS, game: GAME_PATH_POINTS }), 'warn'));
  body.append(deviceTable(over.map((o) => ({ animation: o.slotName !== o.clipName ? `${o.slotName} (${o.clipName})` : o.slotName, object: o.objectName, points: `${o.count} / ${o.max}`, status: t('limit.over') }))));
  body.append(hint(t('limit.choices')));
  const first = await customDialog({ title: t('limit.title'), body, buttons: [
    { label: t('limit.cancelExport'), value: () => 'cancel' },
    { label: t('limit.compress'), primary: true, value: () => 'compress' },
  ] });
  if (first !== 'compress') return null;

  // 2. compress every affected path (export copy) and preview the result
  const { plan: compressed, results, ok } = compressPlan(plan, { max: MAX_PATH_POINTS });
  editor.setExportPathPreview([
    ...plan.devices.filter((d) => results.some((r) => r.nodeId === d.nodeId && r.slotIndex === d.slotIndex)).map((d) => ({ points: d.points.map((p) => p.pos), color: PREVIEW_ORIGINAL })),
    ...compressed.devices.filter((d) => results.some((r) => r.nodeId === d.nodeId && r.slotIndex === d.slotIndex)).map((d) => ({ points: d.points.map((p) => p.pos), color: PREVIEW_COMPRESSED })),
  ]);
  const body2 = h('div', { class: 'limit' });
  body2.append(hint(ok ? t('limit.previewOk', { max: MAX_PATH_POINTS }) : t('limit.previewFail', { max: MAX_PATH_POINTS }), ok ? 'ok' : 'err'));
  body2.append(deviceTable(results.map((r) => ({
    animation: r.slotName !== r.clipName ? `${r.slotName} (${r.clipName})` : r.slotName, object: r.objectName,
    points: t('limit.arrow', { before: r.before, after: r.after }),
    status: r.ok ? t('limit.errorOk', { pos: fmt(r.maxError.pos * 100, 1), rot: fmt(r.maxError.rot, 1) }) : r.reached ? t('limit.errorTooBig', { pos: fmt(r.maxError.pos * 100, 1), rot: fmt(r.maxError.rot, 1) }) : t('limit.notReached'),
    ok: r.ok,
  }))));
  body2.append(hint(t('limit.previewHint')));
  let remember = false;
  if (ok) body2.append(checkbox(t('limit.remember'), false, (v) => { remember = v; }, t('tip.limit.remember')));
  const second = await customDialog({ title: t('limit.previewTitle'), body: body2, buttons: ok ? [
    { label: t('limit.cancelExport'), value: () => 'cancel' },
    { label: t('limit.useCompressed'), primary: true, value: () => 'export' },
  ] : [{ label: t('limit.cancelExport'), primary: true, value: () => 'cancel' }] });
  editor.setExportPathPreview(null);
  if (second !== 'export' || !ok) return null;
  return { plan: compressed, remember };
}

// Manual simplification of a waypath's points with a live count.
export async function showSimplifyPathDialog(editor, wpId) {
  const wp = editor.project.waypaths.find((w) => w.id === wpId);
  if (!wp) return;
  let tol = 0.02;
  const body = h('div', { class: 'limit' });
  const result = h('div', { class: 'hint' });
  const val = h('span', { class: 'v', text: fmt(tol, 3) + ' m' });
  const update = () => {
    const r = simplifyPolyline(wp.points, tol);
    result.textContent = t('path.simplifyResult', { before: r.before, after: r.after, err: fmt(r.maxError.pos * 100, 1) });
    val.textContent = fmt(tol, 3) + ' m';
    const piv = editor.scenePivot(); // waypath points are relative to the model origin
    const world = (pts) => pts.map((p) => [p[0] + piv[0], p[1] + piv[1], p[2] + piv[2]]);
    editor.setExportPathPreview([{ points: world(wp.points), color: PREVIEW_ORIGINAL }, { points: world(r.points), color: PREVIEW_COMPRESSED }]);
  };
  const sl = slider(Math.log10(tol), (v) => { tol = +Math.pow(10, v).toPrecision(2); update(); }, { min: -3, max: 0, step: 0.05 });
  body.append(hint(t('path.simplifyIntro')), h('div', { class: 'row' }, h('span', { class: 'label', text: t('path.simplifyTolerance') }), sl, val), result);
  update();
  const r = await customDialog({ title: t('path.simplify'), body, buttons: [
    { label: t('btn.cancel'), value: () => 'cancel' },
    { label: t('path.simplifyApply'), primary: true, value: () => 'apply' },
  ] });
  editor.setExportPathPreview(null);
  if (r === 'apply') editor.simplifyWaypath(wpId, tol);
}
