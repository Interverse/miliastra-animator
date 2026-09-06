// Global preferences (persist across projects; never project data): General, Navigation,
// Viewport, Input. Project settings live in the Model / Animate / Export workspaces.
import { t, setLanguage, currentLang, LANGS } from '../i18n/i18n.js';
import { h, row, checkbox, selectInput, slider, button, btnRow, hint, numInput } from './dom.js';
import { customDialog } from './dialogs.js';
import { showShortcutsDialog } from './shortcuts.js';

export function showSettingsDialog(editor) {
  const body = h('div', { class: 'settings' });
  const section = (title, ...items) => h('details', { class: 'settings-sec', open: true }, h('summary', { text: title }), ...items);
  // General
  const langSel = selectInput(LANGS.map((l) => ({ value: l.code, label: l.name })), currentLang(), (v) => setLanguage(v, true));
  body.append(section(t('settings.general'),
    row(t('settings.language'), langSel),
    row(t('settings.timeDisplay'), selectInput([{ value: 'frames', label: t('settings.frames') }, { value: 'seconds', label: t('settings.seconds') }], editor.timeDisplay, (v) => editor.setTimeDisplay(v))),
    hint(t('settings.autosave')),
  ));
  // Navigation
  body.append(section(t('settings.navigation'),
    checkbox(t('display.reversePanX'), !!editor.view.reversePanX, (v) => editor.setViewPref({ reversePanX: v }), t('tip.display.reversePan')),
    checkbox(t('display.reversePanY'), !!editor.view.reversePanY, (v) => editor.setViewPref({ reversePanY: v }), t('tip.display.reversePan')),
    checkbox(t('display.reverseOrbitX'), !!editor.view.reverseOrbitX, (v) => editor.setViewPref({ reverseOrbitX: v }), t('tip.display.reverseOrbit')),
    checkbox(t('display.reverseOrbitY'), !!editor.view.reverseOrbitY, (v) => editor.setViewPref({ reverseOrbitY: v }), t('tip.display.reverseOrbit')),
    checkbox(t('display.wasd'), editor.wasd, (v) => editor.setWasd(v), t('tip.display.wasd')),
    hint(t('display.navHint')),
  ));
  // Viewport
  const bright = slider(editor.view.brightness ?? 1, (v) => editor.setViewPref({ brightness: v }), { min: 0.3, max: 2.2, step: 0.05 });
  const bRow = row(t('display.brightness'), bright, t('tip.display.brightness'));
  bRow.append(button('↺', () => { editor.setViewPref({ brightness: 1 }); bright.value = 1; }, { tip: t('display.resetBrightness'), cls: 'mini' }));
  body.append(section(t('settings.viewport'),
    bRow,
    row(t('display.unknown'), selectInput([{ value: 'simplified', label: t('display.unknownSimplified') }, { value: 'boxes', label: t('display.unknownBoxes') }, { value: 'hidden', label: t('display.unknownHidden') }], editor.view.unknownMode || 'simplified', (v) => editor.setViewPref({ unknownMode: v })), t('tip.display.unknown')),
    row(t('display.perf'), selectInput([{ value: 'auto', label: t('display.perfAuto') }, { value: 'on', label: t('display.perfOn') }, { value: 'off', label: t('display.perfOff') }], editor.view.perfMode || 'auto', (v) => editor.setViewPref({ perfMode: v })), t('tip.display.perf')),
    hint(t('settings.viewportHint')),
  ));
  // Input
  body.append(section(t('settings.input'),
    row(t('settings.snapPos'), numInput(editor.snap.pos, (v) => editor.setSnap({ pos: Math.max(0.001, v) }), { step: 0.01, min: 0.001, precision: 3 })),
    row(t('settings.snapRot'), numInput(editor.snap.rot, (v) => editor.setSnap({ rot: Math.max(1, v) }), { step: 1, min: 1, precision: 0 })),
    btnRow(button(t('tip.shortcuts') + '…', () => showShortcutsDialog(), { tip: t('settings.shortcutsTip') })),
  ));
  body.append(hint(t('settings.scopeHint')));
  return customDialog({ title: t('settings.title'), body, buttons: [{ label: t('btn.close'), primary: true, value: () => 'close' }] });
}
