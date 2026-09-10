// UI shell / information architecture: the four workspaces, their panel visibility, the command
// registry's labels and shortcuts, menus, and the palette shortcut — checked statically so no
// browser is needed. (Interactive behaviour is verified in the browser.)
//   node tools/test-ui-shell.mjs
import { readFileSync } from 'node:fs';
import { ACTIONS } from '../js/ui/shortcuts.js';
import { FEATURES } from '../js/ui/feature-flags.js';
import { placePopover } from '../js/ui/popover-place.js';

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
const PANELS = ['outliner', 'clips', 'export', 'properties', 'model', 'rigging', 'waypaths'];
check('all panels exist in the shell', PANELS.every((p) => html.includes(`id="panel-${p}"`)) && !html.includes('panel-display') && !html.includes('panel-project'));
const hidden = (mode) => { const m = css.match(new RegExp(`body\\[data-mode="${mode}"\\][^\\n]*`, 'g')) || []; return new Set(m.join(' ').match(/#panel-[a-z]+/g) || []); };
const expected = {
  model: ['#panel-clips', '#panel-export', '#panel-rigging', '#panel-waypaths'],
  rig: ['#panel-clips', '#panel-export', '#panel-model', '#panel-waypaths'],
  animate: ['#panel-export', '#panel-rigging', '#panel-model'],
  export: ['#panel-rigging', '#panel-waypaths', '#panel-model', '#panel-clips'],
};
for (const m of MODES) check(`${m}: hides exactly ${expected[m].join(', ')}`, expected[m].every((p) => hidden(m).has(p)) && [...hidden(m)].every((p) => expected[m].includes(p)), [...hidden(m)].join(','));
check('Properties is visible in every workspace', MODES.every((m) => !hidden(m).has('#panel-properties')));
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
const bar = read('js/ui/project-bar.js');
const projects = read('js/ui/projects.js');
const modeRules = (css.match(/body\[data-mode="[a-z]+"\][^\n]*/g) || []).join(' ');
check('one compact project header sits above the scrolling panels, not inside them', html.includes('id="project-bar"') && html.indexOf('id="project-bar"') < html.indexOf('class="rail-scroll"') && (html.match(/id="project-bar"/g) || []).length === 1);
check('no workspace hides, reorders or restyles the project header', !modeRules.includes('#project-bar') && !modeRules.includes('#next-step') && !main.includes("'project-bar'") && !left.includes('renderProject') && !left.includes('workflowGuide'));
check('the header carries project identity and save state only', ['pb-name', 'pb-file', 'pb-state'].every((c) => bar.includes(c)) && !bar.includes('stat-grid'));
check('project name truncates with a tooltip at narrow widths', /#project-bar \.pb-name \{[^}]*text-overflow: ellipsis[^}]*\}/.test(css) && bar.includes('title: name'));
check('metadata is collapsed into Project details, workflow controls are not', bar.includes('loadPrefs().projectDetails') && ['project.details', 'project.modified', 'project.objects'].every((k) => bar.includes(k) && en[k]) && !/pb-details[\s\S]{0,400}setMode\(/.test(bar));
check('project actions live in a small menu instead of permanent buttons', bar.includes('function projectMenu') && ['project.saveLocal', 'project.saveAs', 'start.rename', 'project.allProjects', 'project.new'].every((k) => bar.includes(k)));
check('save state is shown once: header text, top bar icon only', bar.includes("t(editor.dirty ? 'project.stateUnsaved' : 'project.stateSaved')") && projects.includes("state.textContent = editor.dirty ? '●' : '✓';"));
check('a single next-step line, derived from project state and hidden only when finished', bar.includes('workflowState(editor)') && bar.includes("step.hidden = st.step === 'done'") && ['import', 'rig', 'animate', 'keys', 'export'].every((k) => en['guide.next.' + k]));
check('Export panel is a checklist (model, animations, initial, paths, scale, validation)', ['export.check.model', 'export.check.anims', 'export.check.initial', 'export.check.paths', 'export.check.scale'].every((k) => left.includes(`t('${k}'`) && en[k]) && left.includes("class: 'checklist'"));
check('Animations panel: empty state with Add animation, Import animation subsection', left.includes("t('clip.emptyTitle')") && left.includes("t('clip.importHead')") && left.includes("t('export.addAnimation')"));

// ---- Experimental Auto-Rig: hidden from the UI, implementation and data kept ----
const autorigImpl = read('js/rig/autorig.js'), autorigDialog = read('js/ui/autorig-dialog.js'), editorSrc = read('js/ui/editor.js');
check('Auto-Rig implementation, dialog and editor API are still in the build', /export function proposeRig/.test(autorigImpl) && /export function applyRig/.test(autorigImpl) && /export (async )?function showAutoRigDialog/.test(autorigDialog) && editorSrc.includes("from '../rig/autorig.js'") && /proposeAutoRig|applyAutoRig/.test(editorSrc));
const autoRigSites = [['panels-right.js', right], ['commands.js', cmds]].flatMap(([f, src]) => src.split('\n').filter((l) => l.includes('showAutoRigDialog(editor)')).map((l) => `${f}: ${l.trim().slice(0, 40)}`));
check('every Auto-Rig entry point is behind the feature flag', autoRigSites.length > 0 && autoRigSites.every((l) => l.includes('FEATURES.autoRig')), autoRigSites.filter((l) => !l.includes('FEATURES.autoRig')).join(' | '));
check('the flag is off, so nothing offers Auto-Rig right now', FEATURES.autoRig === false);
const PROMPTS = ['guide.next.rig', 'rig.noBonesHint', 'rig.noBonesTitle', 'retarget.needRig', 'viewport.emptyHint', 'outliner.empty', 'rig.empty'];
check('no beginner prompt suggests Auto-Rig (English)', PROMPTS.every((k) => !/auto[- ]?rig/i.test(en[k] || '')));

// ---- Graph Editor shares the timeline area and the key data ----
const timelineSrc = read('js/ui/timeline.js'), graphSrc = read('js/ui/graph-editor.js');
check('the timeline header switches between Dope Sheet and Graph Editor', html.includes('id="graph-body"') && html.includes('id="graph-canvas"') && timelineSrc.includes("setMode('graph')") && timelineSrc.includes("t('graph.mode.dope')") && en['graph.mode.dope'] && en['graph.mode.graph']);
check('graph edits go through editor methods, never a private key store', ['updateKeyDrag', 'setPointValue', 'setPointTime', 'setPointTangent', 'setKeyHandles', 'selectCurvePoints', 'simplifyCurves'].every((m) => graphSrc.includes('ed.' + m + '(')) && !/clip\.tracks\[[^\]]+\]\[[^\]]+\]\s*=/.test(graphSrc));
check('graph shortcuts share the timeline handling (select all, delete, copy/paste)', main.includes('timeline.isFocused()') && main.includes('timeline.selectAllKeys()'));
check('palette exposes the Graph Editor and Simplify curves', ids.includes('anim.graph') && ids.includes('anim.simplify'));
check('beginner tooltips exist for handles and interpolation', ['tip.graph.handle', 'tip.handle.auto', 'tip.handle.flat', 'tip.interp.linear', 'tip.interp.step', 'tip.interp.ease'].every((k) => en[k]));

// ---- floating UI: one layering scale, portal menus that flip, filter field that survives rerenders ----
const dialogs = read('js/ui/dialogs.js');
check('menus render in the fixed overlay layer (document.body), not inside the opening toolbar', dialogs.includes('document.body.appendChild(menu)') && !dialogs.includes("host.style.position = 'relative'") && /\.menu \{ position: fixed;[^}]*z-index: var\(--z-popover\)/.test(css));
check('one z-index scale: every floating element uses a --z-* tier', /--z-hud: \d+; --z-handles: \d+; --z-drop: \d+; --z-drawer: \d+; --z-popover: \d+; --z-float: \d+;/.test(css) && (css.match(/z-index: \d+/g) || []).every((m) => m === 'z-index: 1'));
check('menus close on outside pointerdown, Escape, blur, resize and follow scrolling', ['onDown', 'onKey', "addEventListener('blur', close)", "addEventListener('resize', close)", "addEventListener('scroll', onScroll, true)"].every((x) => dialogs.includes(x)) && dialogs.includes('e.stopPropagation(); close();'));
const vp = { w: 1000, h: 600 };
const below = placePopover({ left: 100, top: 100, width: 80, height: 24 }, { w: 200, h: 150 }, vp);
check('popover opens below its anchor', below.top === 128 && below.left === 100 && !below.flipped);
const flip = placePopover({ left: 100, top: 520, width: 80, height: 24 }, { w: 200, h: 150 }, vp);
check('popover flips above near the bottom edge', flip.flipped && flip.top === 520 - 4 - 150);
const rightEdge = placePopover({ left: 950, top: 100, width: 40, height: 24 }, { w: 200, h: 150 }, vp);
check('popover is pulled back inside at the right edge', rightEdge.left === 1000 - 8 - 200);
const pt = placePopover({ x: 990, y: 590 }, { w: 200, h: 150 }, vp);
check('context menus at a pointer near the corner stay inside the window', pt.left + 200 <= 1000 - 8 && pt.top + 150 <= 600 - 8);
check('the Graph Editor filter field is created once, outside the rerendered rows', graphSrc.includes("this.search = h('input', { type: 'search'") && graphSrc.includes("this.rows.innerHTML = ''") && !graphSrc.includes("this.list.innerHTML = ''"));
check('search inputs share the editor input style', css.includes('input[type="search"], select, textarea {') && css.includes('input::placeholder'));
check('dialogs re-render their title, body and buttons on language change', dialogs.includes('onLangChange(() => {') && read('js/ui/settings-dialog.js').includes("body: () => buildSettings(editor)") && read('js/ui/shortcuts.js').includes('body: buildShortcutsBody'));
check('every panel module subscribes to language changes', ['js/ui/panels-left.js', 'js/ui/panels-right.js', 'js/ui/timeline.js', 'js/ui/graph-editor.js', 'js/ui/project-bar.js', 'js/ui/menus.js', 'js/ui/tutorial.js', 'js/main.js'].every((f) => read(f).includes('onLangChange(')));
check('graph and dope-sheet drags run through the key drag transaction with pointer capture and rAF coalescing', ['beginKeyDrag', 'updateKeyDrag', 'endKeyDrag', 'requestAnimationFrame', 'setPointerCapture'].every((x) => graphSrc.includes(x) && timelineSrc.includes(x)) && !graphSrc.includes('moveCurvePoints({ dt: dDt') && !timelineSrc.includes('moveSelectedKeys(dt - d.lastDt'));
check('a view switch ends any drag first', timelineSrc.includes("this.editor.finishInteraction(); // a drag never survives a view switch"));

// ---- localisation of the new keys in all 15 languages ----
const LOCALES = ['de', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'tr', 'vi', 'zhs', 'zht'];
const NEW = Object.keys(en).filter((k) => /^(graph\.|handle\.|tip\.graph\.|tip\.handle\.|tip\.interp\.|project\.(details|modified|actions)|mode\.model|panel\.model|menu\.(file|edit|view|help)|cmd\.|palette\.|settings\.|help\.|guide\.|model\.|rig\.(noModel|bonesHead|noBonesTitle|ikHead|utilities)|export\.check\.|props\.(advanced|selectHint)|clip\.(emptyTitle|importHead)|tut\.model)/.test(k));
for (const l of LOCALES) {
  const d = (await import(`../js/i18n/locales/${l}.js`)).default;
  const miss = NEW.filter((k) => !d[k]);
  const untranslated = NEW.filter((k) => d[k] === en[k] && !/^(Model|Rig|File|Miliastra Animator|Root Motion)/.test(en[k]) && en[k].length > 12);
  const autoRigPrompts = PROMPTS.filter((k) => /auto[- ]?rig/i.test(d[k] || ''));
  check(`${l}: all ${NEW.length} new UI keys present and translated, no Auto-Rig prompts`, miss.length === 0 && untranslated.length <= 2 && autoRigPrompts.length === 0, (miss.length ? 'missing ' + miss.join(',') : '') + (untranslated.length ? ' same-as-en ' + untranslated.join(',') : '') + (autoRigPrompts.length ? ' autorig in ' + autoRigPrompts.join(',') : ''));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall ui-shell checks passed');
process.exit(failures ? 1 : 0);
