// UI shell / information architecture: the four workspaces, their panel visibility, the command
// registry's labels and shortcuts, menus, and the palette shortcut — checked statically so no
// browser is needed. (Interactive behaviour is verified in the browser.)
//   node tools/test-ui-shell.mjs
import { readFileSync } from 'node:fs';
import { ACTIONS } from '../js/ui/shortcuts.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const en = (await import('../js/i18n/locales/en.js')).default;

// ---- workspaces ----
const html = read('index.html');
const MODES = ['model', 'rig', 'animate', 'export'];
check('four workspace tabs Model → Rig → Animate → Export in that order', MODES.every((m) => html.includes(`data-mode="${m}"`)) && MODES.map((m) => html.indexOf(`data-mode="${m}"`)).every((i, k, a) => k === 0 || i > a[k - 1]));
check('every workspace has a name and a tooltip key', MODES.every((m) => en['mode.' + m] && en['tip.mode.' + m]));
check('the shell starts in the Model workspace', /<body data-mode="model">/.test(html));
const css = read('css/style.css');
const PANELS = ['project', 'outliner', 'clips', 'export', 'properties', 'model', 'rigging', 'waypaths'];
check('all panels exist in the shell', PANELS.every((p) => html.includes(`id="panel-${p}"`)) && !html.includes('panel-display'));
const hidden = (mode) => { const m = css.match(new RegExp(`body\\[data-mode="${mode}"\\][^\\n]*`, 'g')) || []; return new Set(m.join(' ').match(/#panel-[a-z]+/g) || []); };
const expected = {
  model: ['#panel-clips', '#panel-export', '#panel-rigging', '#panel-waypaths'],
  rig: ['#panel-clips', '#panel-export', '#panel-model', '#panel-waypaths'],
  animate: ['#panel-export', '#panel-rigging', '#panel-model'],
  export: ['#panel-rigging', '#panel-waypaths', '#panel-model', '#panel-clips'],
};
for (const m of MODES) check(`${m}: hides exactly ${expected[m].join(', ')}`, expected[m].every((p) => hidden(m).has(p)) && [...hidden(m)].every((p) => expected[m].includes(p)), [...hidden(m)].join(','));
check('Project and Properties are visible in every workspace', MODES.every((m) => !hidden(m).has('#panel-project') && !hidden(m).has('#panel-properties')));
check('Outliner is visible in every workspace', MODES.every((m) => !hidden(m).has('#panel-outliner')));
check('Model panel only in Model, Rig panel only in Rig, Export panel only in Export', hidden('rig').has('#panel-model') && hidden('animate').has('#panel-model') && hidden('export').has('#panel-model') && !hidden('model').has('#panel-model') && !hidden('rig').has('#panel-rigging') && MODES.filter((m) => m !== 'rig').every((m) => hidden(m).has('#panel-rigging')) && !hidden('export').has('#panel-export') && MODES.filter((m) => m !== 'export').every((m) => hidden(m).has('#panel-export')));
check('narrow layouts turn the side rails into drawers', /@media \(max-width: 899px\)[\s\S]*#left\.open, #right\.open \{ transform: none; \}/.test(css) && html.includes('id="btn-left-drawer"') && html.includes('id="btn-right-drawer"'));

// ---- shortcuts ----
for (const a of ACTIONS) check(`shortcut ${a.id} has a label (sc.${a.id}) and a category label`, !!en['sc.' + a.id] && !!en['sc.cat.' + a.cat]);
const palette = ACTIONS.find((a) => a.id === 'app.search');
check('command search has a shortcut that does not collide with Auto Key (Ctrl+K)', palette && !palette.keys.includes('ctrl+k'));
const allKeys = ACTIONS.flatMap((a) => a.keys.map((k) => [k, a.id]));
const dupes = allKeys.filter(([k], i) => allKeys.findIndex(([k2]) => k2 === k) !== i);
check('no two actions share a default key binding', dupes.length === 0, dupes.map(([k, id]) => `${k}:${id}`).join(' '));
check('Spacebar still cycles Move/Rotate', ACTIONS.find((a) => a.id === 'tool.toggleMoveRotate')?.keys.includes('space'));

// ---- command registry, menus, palette, settings ----
const cmds = read('js/ui/commands.js');
const ids = [...cmds.matchAll(/\bid: '([\w.]+)',/g)].map((m) => m[1]);
check('command registry covers file / edit / model / rig / animate / export / view / help', ['file.', 'edit.', 'model.', 'rig.', 'anim.', 'export.', 'view.', 'help.'].every((p) => ids.some((id) => id.startsWith(p))), ids.length + ' commands');
check('no duplicate command ids', new Set(ids).size === ids.length);
const shortcutRefs = [...cmds.matchAll(/\bkey: '([\w.]+)',/g)].map((m) => m[1]);
check('every command shortcut reference is a real action', shortcutRefs.every((k) => ACTIONS.some((a) => a.id === k)), shortcutRefs.filter((k) => !ACTIONS.some((a) => a.id === k)).join(','));
for (const g of ['file', 'edit', 'model', 'rig', 'anim', 'export', 'view', 'display', 'help']) check(`command group label cmd.group.${g}`, !!en['cmd.group.' + g]);
const menus = read('js/ui/menus.js');
const menuIds = [...menus.matchAll(/item\(cmds, '([\w.]+)'\)/g)].map((m) => m[1]);
check('File / Edit / View / Help menus exist', ['file', 'edit', 'view', 'help'].every((k) => menus.includes(`${k}: (cmds) =>`) && en['menu.' + k]));
check('every menu item refers to a registered command', menuIds.every((id) => ids.includes(id)), menuIds.filter((id) => !ids.includes(id)).join(','));
check('File menu: new, open, save, import model/animation, export', ['file.new', 'file.open', 'file.save', 'file.importGia', 'file.importAnim', 'file.exportGia'].every((id) => menuIds.includes(id)));
check('View menu: display toggles + frame + validate', ['view.frameAll', 'view.validate', 'view.displayEdit', 'view.perf'].every((id) => menuIds.includes(id)) && menus.includes("'showGrid'") && menus.includes("'showWaypaths'") && menus.includes("item(cmds, 'view.' + k)"));
check('Help menu: tutorial, shortcuts, controls, settings, about', ['help.tutorial', 'help.shortcuts', 'help.controls', 'settings', 'help.about'].every((id) => menuIds.includes(id)));
const main = read('js/main.js');
check('toolbar keeps only tools, local/world + snapping and framing/views/display', main.includes('bar.append(tools, space, view);') && !main.includes('const rotMode') && !main.includes('const displayGroup') && !/tb\(t\('add\.menu'\)/.test(main));
check('Shift+A Add menu and the Ctrl+Shift+P palette are wired', main.includes("case 'edit.add'") && main.includes("case 'app.search'") && main.includes("case 'app.settings'"));
const settings = read('js/ui/settings-dialog.js');
check('Settings dialog has General / Navigation / Viewport / Input sections', ['settings.general', 'settings.navigation', 'settings.viewport', 'settings.input'].every((k) => settings.includes(`t('${k}')`) && en[k]));
check('Settings covers language, reverse pan/orbit, WASD, brightness, unknown geometry, performance, snapping, shortcuts', ['setLanguage', 'reversePanX', 'reverseOrbitY', 'setWasd', 'brightness', 'unknownMode', 'perfMode', 'setSnap', 'showShortcutsDialog'].every((s) => settings.includes(s)));
const right = read('js/ui/panels-right.js');
check('Properties has progressive disclosure (Advanced ▸) and the Preserve toggle', right.includes("t('props.advanced')") && right.includes("t('rotmode.preserve')"));
check('Rig panel is Bones → IK & controls → Rig utilities', ['rig.bonesHead', 'rig.ikHead', 'rig.utilities'].map((k) => right.indexOf(`t('${k}')`)).every((i, k, a) => i > 0 && (k === 0 || i > a[k - 1])));
check('Model panel hosts orientation/scale, scene settings and proxies', right.includes('function renderModel') && right.includes('showReorientDialog(editor)') && right.includes('showScaleModelDialog(editor)') && right.includes('setGlobalOffset') && right.includes("addProxy('cuboid')"));
const left = read('js/ui/panels-left.js');
check('Project panel carries the Model → Rig → Animate → Export guide', left.includes('function workflowGuide') && ['import', 'rig', 'animate', 'keys', 'export', 'done'].every((k) => en['guide.next.' + k]));
check('Export panel is a checklist (model, animations, initial, paths, scale, validation)', ['export.check.model', 'export.check.anims', 'export.check.initial', 'export.check.paths', 'export.check.scale'].every((k) => left.includes(`t('${k}'`) && en[k]) && left.includes("class: 'checklist'"));
check('Animations panel: empty state with Add animation, Import animation subsection', left.includes("t('clip.emptyTitle')") && left.includes("t('clip.importHead')") && left.includes("t('export.addAnimation')"));

// ---- localisation of the new keys in all 15 languages ----
const LOCALES = ['de', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'tr', 'vi', 'zhs', 'zht'];
const NEW = Object.keys(en).filter((k) => /^(mode\.model|panel\.model|menu\.(file|edit|view|help)|cmd\.|palette\.|settings\.|help\.|guide\.|model\.|rig\.(noModel|bonesHead|noBonesTitle|ikHead|utilities)|export\.check\.|props\.(advanced|selectHint)|clip\.(emptyTitle|importHead)|tut\.model)/.test(k));
for (const l of LOCALES) {
  const d = (await import(`../js/i18n/locales/${l}.js`)).default;
  const miss = NEW.filter((k) => !d[k]);
  const untranslated = NEW.filter((k) => d[k] === en[k] && !/^(Model|Rig|File|Miliastra Animator|Root Motion)/.test(en[k]) && en[k].length > 12);
  check(`${l}: all ${NEW.length} new UI keys present and translated`, miss.length === 0 && untranslated.length <= 2, (miss.length ? 'missing ' + miss.join(',') : '') + (untranslated.length ? ' same-as-en ' + untranslated.join(',') : ''));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall ui-shell checks passed');
process.exit(failures ? 1 : 0);
