// "How to export a .gia from Miliastra": the tutorial image plus captions.
//
// The two steps are always written out under the image (step 1 under the left half, step 2
// and the Stage warning under the right half), translated in every language, so the
// instructions never depend on reading the English baked into the picture. The body is
// rebuilt when the language changes while the dialog is open.
import { t } from '../i18n/i18n.js';
import { h } from './dom.js';
import { customDialog } from './dialogs.js';

export const GIA_TUTORIAL_IMAGE = 'samples/gia-export-tutorial.webp';
export const GIA_HELP_STEPS = ['giaHelp.step1', 'giaHelp.step2', 'giaHelp.warn'];


function buildBody(editor) {
  const body = h('div', { class: 'gia-help' });
  body.append(h('img', { class: 'gia-help-img', src: GIA_TUTORIAL_IMAGE, alt: t('giaHelp.alt'), width: 2000, height: 807, decoding: 'async' }));
  const list = h('ol', { class: 'gia-help-captions', start: 1 });
  list.append(
    h('li', { text: t('giaHelp.step1') }),
    h('li', null, h('span', { text: t('giaHelp.step2') }), h('strong', { class: 'gia-help-warn', text: t('giaHelp.warn') })),
  );
  body.append(list);
  body.append(h('div', { class: 'hint', text: t('giaHelp.after') }));
  void editor;
  return body;
}

export function showGiaHelp(editor) {
  return customDialog({
    title: () => t('giaHelp.title'),
    body: () => buildBody(editor),
    buttons: [
      ...(editor?.pickGiaFile ? [{ label: () => t('viewport.import'), value: () => 'import' }] : []),
      { label: () => t('btn.close'), primary: true, value: () => 'close' },
    ],
  }).then((r) => { if (r === 'import') editor.pickGiaFile?.(); return r; });
}
