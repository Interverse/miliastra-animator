// Preview Mode state: previews are view-only (no project change, no undo entries), update the
// displayed scene live, and every temporary preview ends when the project changes.
//   node tools/test-preview.mjs   (the floating panel itself is DOM and is verified in the browser)
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import { exportPivot } from '../js/gia/gia-export.js';
import { yawQuat } from '../js/anim/orient.js';
import { quat, v3 } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const same = (a, b, eps = 1e-6) => v3.dist(a.pos, b.pos) < eps && quat.angle(a.rot, b.rot) < eps;

const ed = new Editor();
ed.importGia(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)), 'Pantalone.gia');
ed.applyAutoRig(ed.proposeAutoRig({ ik: true }));
const committed = JSON.stringify(ed.snapshotState());
const undo0 = ed.history.undoStack.length;
const piv = exportPivot(ed.project);
const base = ed.displayWorld();

// scale preview: displayed positions scale about the pivot, project untouched, no history
ed.setScalePreview(2);
const shown = ed.displayWorld();
check('scale preview 2×: displayed positions are pivot + 2·(p − pivot), rotations unchanged', ed.project.nodes.every((n) => same(shown.get(n.id), { pos: v3.add(piv, v3.scale(v3.sub(base.get(n.id).pos, piv), 2)), rot: base.get(n.id).rot })));
check('scale preview changes nothing in the project and creates no undo entry', JSON.stringify(ed.snapshotState()) === committed && ed.history.undoStack.length === undo0);
ed.setScalePreview(0.5);
check('live update: 0.5× shows immediately', ed.project.nodes.every((n) => same(ed.displayWorld().get(n.id), { pos: v3.add(piv, v3.scale(v3.sub(base.get(n.id).pos, piv), 0.5)), rot: base.get(n.id).rot })));
ed.setScalePreview(1);
check('factor 1 clears the preview', ed.scalePreview === null && ed.project.nodes.every((n) => same(ed.displayWorld().get(n.id), base.get(n.id), 1e-6)));

// orientation preview composes with the scale preview about the same pivot
ed.setScalePreview(2); ed.setOrientPreview(yawQuat(90));
const both = ed.displayWorld();
const expect = (w) => { const s = v3.add(piv, v3.scale(v3.sub(w.pos, piv), 2)); const R = yawQuat(90); return { pos: v3.add(piv, quat.rotate(R, v3.sub(s, piv))), rot: quat.mul(R, w.rot) }; };
check('orientation + scale previews compose about the pivot', ed.project.nodes.every((n) => same(both.get(n.id), expect(base.get(n.id)), 1e-6)));
check('previews are view-only: project still identical', JSON.stringify(ed.snapshotState()) === committed);

// Auto-Rig preview (on an unrigged model): the proposal is not in the project; the flag only draws lines
const edR = new Editor();
edR.importGia(readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url)), 'Pantalone.gia');
const committedR = JSON.stringify(edR.snapshotState()), nodes0 = edR.project.nodes.length;
edR.setRigPreview(edR.proposeAutoRig({ ik: false, pose: 'apose' }));
check('auto-rig preview adds nothing to the project and creates no undo entry', edR.project.nodes.length === nodes0 && edR.rigPreview.bones.length > 0 && JSON.stringify(edR.snapshotState()) === committedR && edR.history.undoStack.length === 0);
edR.setRigPreview(null);
check('closing the auto-rig preview leaves no proposal', edR.rigPreview === null);
ed.setExportPathPreview([{ points: [[0, 0, 0], [1, 0, 0]], color: 0xffffff }]);

// project switch ends every preview
ed.newProject();
check('New Project cancels every preview (rig, orientation, scale, path)', ed.rigPreview === null && ed.orientPreview === null && ed.scalePreview === null && ed.exportPathPreview === null);

// cancelling a retarget-style preview restores the committed state exactly
const ed2 = new Editor();
ed2.importGia(readFileSync(new URL('./fixtures/White Square.gia', import.meta.url)), 'White Square.gia');
const c0 = JSON.stringify(ed2.snapshotState());
ed2.createClip('temp preview'); // a preview clip added transiently would be committed by createClip; emulate the retarget flow instead:
ed2.undo();
ed2.project.clips.push({ id: 'ctmp', name: 'tmp', duration: 1, loop: false, playhead: 0, tracks: {} }); ed2.project.activeClipId = 'ctmp'; ed2.transient();
ed2.restoreCommitted();
check('restoreCommitted drops a transient preview clip and returns to the committed state', JSON.stringify(ed2.snapshotState()) === c0);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
