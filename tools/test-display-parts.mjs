// Individual display parts:  node tools/test-display-parts.mjs
// A display model is an editable collection of primitives (file decorations +
// custom cuboid/cylinder/sphere parts) under the object's display root. Editing
// one part never touches the others, the object, the rig, keys or the export.
import { readFileSync } from 'node:fs';
import { Editor } from '../js/ui/editor.js';
import * as DP from '../js/scene/display-parts.js';
import { exportGia } from '../js/gia/gia-export.js';
import { evaluatePose } from '../js/anim/evaluate.js';
import { quat, v3, xf } from '../js/core/math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const ang = (a, b) => quat.angle(a, b) * 180 / Math.PI;

const j = JSON.parse(readFileSync(new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
const ed = new Editor();
ed.openProjectFile(JSON.stringify(j));
const node = () => ed.project.nodes.find((n) => n.type === 'object' && n.name === 'Arm_L');
const id = node().id;
ed.select(id);
const giaBefore = Buffer.from(exportGia(ed.project, gia).bytes);
const projectBefore = JSON.stringify(ed.project);
const worldBefore = evaluatePose(ed.project, ed.project.activeClipId, ed.time).world.get(id);

// ---------- effective parts from the file ----------
let parts = ed.displayParts(id);
check('file decorations appear as parts with file defaults', parts.length === node().decorations.length && parts.every((p, i) => p.source === 'file' && p.kind === 'model' && v3.dist(p.pos, node().decorations[i].pos) === 0));
const first = parts[0], second = parts[1];

// ---------- editing one part leaves the others alone ----------
ed.setDisplayEdit(true);
ed.selectDisplayParts([first.id]);
ed.setPartTransform(id, first.id, { pos: v3.add(first.pos, [0.5, 0, 0]), scale: [2, 2, 2] });
parts = ed.displayParts(id);
check('edited part stores its own transform', v3.dist(parts[0].pos, v3.add(first.pos, [0.5, 0, 0])) < 1e-9 && parts[0].scale.join() === '2,2,2' && parts[0].edited);
check('the other parts are unchanged', v3.dist(parts[1].pos, second.pos) === 0 && parts[1].scale.join() === second.scale.join() && !parts[1].edited);
check('the object transform is unchanged', v3.dist(evaluatePose(ed.project, ed.project.activeClipId, ed.time).world.get(id).pos, worldBefore.pos) < 1e-12);
check('exported .gia byte-identical', Buffer.compare(Buffer.from(exportGia(ed.project, gia).bytes), giaBefore) === 0);
check('undo label names the part edit', ed.history.undoLabel() === 'Display part');

// ---------- part world ↔ local round trip through root offset + zoom + rotated object ----------
ed.setDisplayTransform(id, { pos: [0.1, 0.05, 0], rot: quat.fromEulerDeg([0, 30, 0]), scale: [1.5, 1, 1] });
const w = ed.partWorld(id, second.id);
const frame = ed.displayFrameWorld(id);
const expected = DP.partWorld(frame, ed.displayRootScale(id), ed.displayPart(id, second.id));
check('partWorld = root frame ∘ (root scale ⊙ part)', v3.dist(w.pos, expected.pos) < 1e-12 && ang(w.rot, expected.rot) < 1e-9);
const target = { pos: v3.add(w.pos, [0.2, -0.1, 0.3]), rot: quat.norm(quat.mul(quat.fromEulerDeg([15, 0, 0]), w.rot)) };
ed.setPartWorld(id, second.id, target);
const w2 = ed.partWorld(id, second.id);
check('setPartWorld round-trips exactly', v3.dist(w2.pos, target.pos) < 1e-9 && ang(w2.rot, target.rot) < 1e-9);
check("root scale shows up in the part's local position", Math.abs(ed.displayPart(id, second.id).pos[0] - DP.worldToPart(frame, ed.displayRootScale(id), target).pos[0]) < 1e-12);

// ---------- multi-part group rotation keeps spacing ----------
ed.selectDisplayParts([first.id, second.id]);
const wa = ed.partWorld(id, first.id), wb = ed.partWorld(id, second.id);
const pivot = v3.scale(v3.add(wa.pos, wb.pos), 0.5);
const R = quat.fromEulerDeg([0, 0, 40]);
for (const [pid, w0] of [[first.id, wa], [second.id, wb]]) ed.setPartWorld(id, pid, { pos: v3.add(pivot, quat.rotate(R, v3.sub(w0.pos, pivot))), rot: quat.norm(quat.mul(R, w0.rot)) });
const na = ed.partWorld(id, first.id), nb = ed.partWorld(id, second.id);
check('group rotation preserves the distance between parts', Math.abs(v3.dist(na.pos, nb.pos) - v3.dist(wa.pos, wb.pos)) < 1e-9);
check('both parts turned by the group rotation', Math.abs(ang(na.rot, wa.rot) - 40) < 1e-6 && Math.abs(ang(nb.rot, wb.rot) - 40) < 1e-6);

// ---------- add / duplicate / rename / hide / reorder / delete ----------
const before = ed.displayParts(id).length;
const cub = ed.addDisplayPart(id, 'cuboid');
check('added cuboid is a custom part, selected, named', !!cub && ed.displayParts(id).length === before + 1 && ed.displaySel.has(cub.id) && /Cuboid 1/.test(ed.displayPart(id, cub.id).name) && ed.history.undoLabel() === 'Add display part');
ed.setPartTransform(id, cub.id, { scale: [0.4, 0.1, 0.2], pos: [0, 0.3, 0] });
ed.renameDisplayPart(id, cub.id, 'Left Arm');
check('rename', ed.displayPart(id, cub.id).name === 'Left Arm' && ed.history.undoLabel() === 'Rename display part');
ed.setPartHidden(id, cub.id, true);
check('hide', ed.displayPart(id, cub.id).hidden && ed.history.undoLabel() === 'Display part visibility');
ed.setPartHidden(id, cub.id, false);
const dup = ed.duplicateDisplayParts(id, [cub.id, first.id]);
check('duplicate creates custom copies (model parts keep their model id)', dup.length === 2 && ed.displayPart(id, dup[1]).kind === 'model' && ed.displayPart(id, dup[1]).modelId === first.modelId && ed.displayPart(id, dup[0]).scale.join() === '0.4,0.1,0.2');
const orderBefore = ed.displayParts(id).map((p) => p.id);
ed.moveDisplayPart(id, cub.id, -1);
const orderAfter = ed.displayParts(id).map((p) => p.id);
check('reorder moves the part one slot up', orderAfter.indexOf(cub.id) === orderBefore.indexOf(cub.id) - 1 && ed.history.undoLabel() === 'Reorder display parts');
ed.deleteDisplayParts(id, [dup[0], second.id]);
check('delete removes custom parts and hides file parts', !ed.displayPart(id, dup[0]) && ed.displayPart(id, second.id).hidden && ed.history.undoLabel() === 'Delete display parts');
check('nothing selected after delete', ed.displaySel.size === 0);

// ---------- reset ----------
ed.resetDisplayPart(id, second.id);
check('reset part restores the file definition (visible, default transform)', !ed.displayPart(id, second.id).hidden && !ed.displayPart(id, second.id).edited && v3.dist(ed.displayPart(id, second.id).pos, second.pos) === 0);
ed.setPartTransform(id, cub.id, { pos: [1, 1, 1] });
ed.resetDisplayPart(id, cub.id);
check('reset custom part returns to its creation state', v3.dist(ed.displayPart(id, cub.id).pos, [0, 0, 0]) === 0 && ed.displayPart(id, cub.id).scale.join() === '0.2,0.2,0.2');
ed.resetDisplay(id);
const afterAll = ed.displayParts(id);
check('reset entire model: file parts back to reference, custom parts kept at creation state, root cleared', afterAll.filter((p) => p.source === 'file').every((p) => !p.edited && !p.hidden && !p.renamed) && afterAll.some((p) => p.source === 'custom') && !node().display.pos);

// ---------- undo / redo across part operations ----------
const labelsBefore = ed.history.undoStack.length;
ed.addDisplayPart(id, 'sphere'); ed.setPartTransform(id, ed.displayActive, { pos: [0, 0.5, 0] }); ed.renameDisplayPart(id, ed.displayActive, 'Head'); ed.deleteDisplayParts(id);
check('four part operations = four undo steps', ed.history.undoStack.length === labelsBefore + 4);
ed.undo(); check('undo delete brings the sphere back', ed.displayParts(id).some((p) => p.name === 'Head'));
ed.undo(); ed.undo(); ed.undo();
check('undo x3 more removes the sphere again', !ed.displayParts(id).some((p) => p.kind === 'sphere'));
ed.redo(); ed.redo();
check('redo restores add + move', ed.displayParts(id).some((p) => p.kind === 'sphere' && p.pos[1] === 0.5));

// ---------- drag = one step, cancel restores ----------
const stepsBefore = ed.history.undoStack.length;
const sphere = ed.displayParts(id).find((p) => p.kind === 'sphere');
ed.beginInteraction('gizmo-move', { finish: () => ed.commit('Display part'), cancel: () => ed.restoreCommitted() });
for (let i = 1; i <= 6; i++) ed.setPartTransform(id, sphere.id, { pos: [0, 0.5 + i * 0.01, 0] }, { commit: false });
ed.finishInteraction();
check('a drag is one undo step', ed.history.undoStack.length === stepsBefore + 1 && Math.abs(ed.displayPart(id, sphere.id).pos[1] - 0.56) < 1e-9);
ed.beginInteraction('gizmo-move', { finish: () => ed.commit('Display part'), cancel: () => ed.restoreCommitted() });
ed.setPartTransform(id, sphere.id, { pos: [5, 5, 5] }, { commit: false });
ed.cancelInteraction();
check('cancel restores the part', Math.abs(ed.displayPart(id, sphere.id).pos[1] - 0.56) < 1e-9);

// ---------- persistence + export ----------
const json = ed.projectFileJSON();
const ed2 = new Editor(); ed2.openProjectFile(json);
const n2 = ed2.project.nodes.find((n) => n.name === 'Arm_L' && n.type === 'object');
check('parts survive a project-file round trip', DP.displayParts(n2).some((p) => p.kind === 'sphere' && Math.abs(p.pos[1] - 0.56) < 1e-9) && DP.displayParts(n2).some((p) => p.name === 'Left Arm'));
check('exported .gia still byte-identical after all part edits', Buffer.compare(Buffer.from(exportGia(ed.project, gia).bytes), giaBefore) === 0);
check('project data apart from display is unchanged', (() => { const strip = (s) => JSON.stringify(JSON.parse(s), (k, v) => (k === 'display' ? undefined : v)); return strip(JSON.stringify(ed.project)) === strip(projectBefore); })());

// ---------- selection semantics ----------
ed.selectDisplayParts([first.id]); ed.selectDisplayParts([second.id], 'toggle'); ed.selectDisplayParts([first.id], 'toggle');
check('toggle selection', ed.displaySel.size === 1 && ed.displaySel.has(second.id) && ed.displayActive === second.id);
const other = ed.project.nodes.find((n) => n.type === 'object' && n.name === 'Head');
ed.select(other.id);
check('selecting another object clears the part selection', ed.displaySel.size === 0);
ed.setDisplayEdit(false);
check('leaving the mode clears part selection', ed.displaySel.size === 0 && !ed.displayEdit);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
