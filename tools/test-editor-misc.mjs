// Empty-state Add Animation, navigation preference migration, and the modal backdrop
// guard.   node tools/test-editor-misc.mjs
import { Editor } from '../js/ui/editor.js';
import { migrateNavPrefs, NAV_PREFS_VERSION } from '../js/core/persistence.js';
import { orbitSigns } from '../js/viewport/camera.js';
import { BackdropGuard } from '../js/ui/backdrop-guard.js';
import { createNode } from '../js/scene/scene.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

// ---------- 1. Add Animation with zero animations ----------
{
  const ed = new Editor();
  ed.newProject();
  createNode(ed.project, 'object', { name: 'o', guid: 1 });
  ed.history.reset(ed.snapshotState());
  const empty = JSON.stringify(ed.snapshotState());
  check('starts with zero animations and no active clip', ed.project.clips.length === 0 && ed.project.activeClipId === null);
  const c = ed.createClip();
  check('Add Animation creates "Animation 1", active, with an empty timeline at t=0', c.name === 'Animation 1' && ed.project.activeClipId === c.id && Object.keys(c.tracks).length === 0 && ed.time === 0 && c.duration > 0);
  check('the new clip is an export slot', ed.slots.length === 1 && ed.slots[0].clipId === c.id);
  check('creation is one undo step', ed.history.undoStack.length === 1 && ed.history.undoLabel() === 'New clip');
  ed.undo();
  check('undo returns to the zero-animation state exactly', JSON.stringify(ed.snapshotState()) === empty && ed.project.clips.length === 0 && ed.project.activeClipId === null && ed.slots.length === 0);
  ed.redo();
  check('redo restores exactly one clip, active again, no duplicates', ed.project.clips.length === 1 && ed.project.activeClipId === ed.project.clips[0].id && ed.slots.length === 1);
  const c2 = ed.createClip();
  check('the next clip is "Animation 2"', c2.name === 'Animation 2' && ed.project.activeClipId === c2.id);
  // a project record without exportConfig.slots (older saves) must not break creation
  const ed2 = new Editor();
  ed2.newProject();
  ed2.project.exportConfig = { initialSlot: 0 };
  let err = null; try { ed2.createClip(); } catch (e) { err = e; }
  check('creation works when the project has no export slots array yet', !err && ed2.project.clips.length === 1 && ed2.slots.length === 1);
  // playing state and key selection are reset
  const ed3 = new Editor(); ed3.newProject(); ed3.playing = true; ed3.selectedKeys = new Set(['x']);
  ed3.createClip('Walk');
  check('named creation keeps the given name and resets playback / key selection', ed3.project.clips[0].name === 'Walk' && ed3.playing === false && ed3.selectedKeys.size === 0);
}

// ---------- 2. vertical orbit polarity + preference migration ----------
{
  check('new default (unchecked) uses the direction that used to require "reverse"', orbitSigns({}).y === -1 && orbitSigns({ reverseOrbitY: false }).y === -1);
  check('checked reverses the new default', orbitSigns({ reverseOrbitY: true }).y === 1);
  check('horizontal orbit unchanged', orbitSigns({}).x === 1 && orbitSigns({ reverseOrbitX: true }).x === -1);
  // migration
  const fresh = migrateNavPrefs({});
  check('new user: corrected default, version stamped', fresh.changed && fresh.prefs.navVersion === NAV_PREFS_VERSION && !fresh.prefs.view.reverseOrbitY && !fresh.migratedExistingUser);
  const oldDefault = migrateNavPrefs({ lang: 'en', view: { brightness: 1 } });
  check('existing user who never touched the option keeps the old physical direction (flag now on)', oldDefault.prefs.view.reverseOrbitY === true && orbitSigns(oldDefault.prefs.view).y === 1);
  const oldReversed = migrateNavPrefs({ view: { reverseOrbitY: true, reverseOrbitX: true, reversePanY: true } });
  check('existing user with the option on keeps their direction (flag now off); other axes untouched', oldReversed.prefs.view.reverseOrbitY === false && orbitSigns(oldReversed.prefs.view).y === -1 && oldReversed.prefs.view.reverseOrbitX === true && oldReversed.prefs.view.reversePanY === true);
  const again = migrateNavPrefs(oldReversed.prefs);
  check('migration is idempotent (persisted version is respected)', !again.changed && again.prefs.view.reverseOrbitY === false);
  // the editor applies the migration on construction (no localStorage here → new user)
  const ed = new Editor();
  check('editor starts with the corrected default', ed.view.reverseOrbitY === false);
}

// ---------- 3. modal backdrop guard ----------
{
  const g = new BackdropGuard();
  g.pointerDown(true); g.pointerUp(true);
  check('down + up on the backdrop closes', g.click(true) === true);
  g.pointerDown(false); g.pointerUp(true);
  check('drag from inside the dialog released over the backdrop does not close', g.click(true) === false);
  g.pointerDown(true); g.pointerUp(false);
  check('down on the backdrop released inside the dialog does not close', g.click(true) === false);
  g.pointerDown(true); g.interrupt(); g.pointerUp(true);
  check('pointercancel / lost capture / blur in between cancels the close', g.click(true) === false);
  g.dragStart(); g.pointerDown(true); g.pointerUp(true);
  check('a file drag over the window blocks backdrop closing entirely', g.click(true) === false && g.blocked);
  g.dragEnd(); g.pointerDown(true); g.pointerUp(true);
  check('after the drag ends a genuine backdrop click closes again', g.click(true) === true);
  check('a click on dialog content never closes', (g.pointerDown(true), g.pointerUp(true), g.click(false)) === false);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
