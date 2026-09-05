// Rendering plan for large models:  node tools/test-parts-plan.mjs
// Instanced grouping, adaptive unknown-geometry representation, level of detail,
// Performance Mode switching and instance → part pick mapping, using the
// supplied 1,750-decoration Pantalone.gia as the regression case.
import { readFileSync } from 'node:fs';
import { importGia } from '../js/gia/gia-import.js';
import { displayParts } from '../js/scene/display-parts.js';
import { planGroups, unknownRepresentation, clusterStride, lodLevel, pixelRadius, perfModeActive, partIdForInstance, PERF_AUTO_PARTS, UNKNOWN_BOXES_MAX, UNKNOWN_POINTS_MAX } from '../js/viewport/parts-plan.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

const bytes = readFileSync(new URL('./fixtures/Pantalone.gia', import.meta.url));
const t0 = performance.now();
const { project } = importGia(new Uint8Array(bytes), 'Pantalone.gia');
const importMs = performance.now() - t0;
const objects = project.nodes.filter((n) => n.type === 'object');
const totalParts = objects.reduce((a, o) => a + o.decorations.length, 0);
check('fixture: 16 objects, 1750 decorations, mostly unknown model IDs', objects.length === 16 && totalParts === 1750);
check('import stays fast (< 400 ms)', importMs < 400, `${importMs.toFixed(0)} ms`);

// ---------- grouping ----------
let drawCalls = 0, meshes = 0;
for (const o of objects) {
  const parts = displayParts(o);
  const plan = planGroups(parts);
  meshes += parts.length;
  drawCalls += plan.groups.size;
  const ids = new Set();
  for (const g of plan.groups.values()) for (const id of g.ids) ids.add(id);
  if (ids.size !== parts.length) check(`every part of ${o.name} lands in exactly one group`, false);
}
check('one instanced draw per geometry instead of one per part', drawCalls < meshes / 20, `${drawCalls} groups for ${meshes} parts`);
const jacket = objects.find((o) => o.name === 'jacket');
const jp = planGroups(displayParts(jacket));
check('jacket: unknown decorations share a single instanced group', jp.groups.get('unknown')?.ids.length === jp.unknownCount && jp.unknownCount > 400);
check('instance id maps back to the logical part id', partIdForInstance(jp.groups.get('unknown'), 5) === displayParts(jacket).filter((p) => jp.groups.get('unknown').ids.includes(p.id))[5].id && partIdForInstance(jp.groups.get('unknown'), 99999) === null);

// ---------- unknown geometry representation ----------
check('few unknown parts → wireframe boxes', unknownRepresentation('simplified', 10) === 'boxes' && unknownRepresentation('simplified', UNKNOWN_BOXES_MAX) === 'boxes');
check('medium groups → points + bounds', unknownRepresentation('simplified', 200) === 'points');
check('very large groups → clustered points', unknownRepresentation('simplified', UNKNOWN_POINTS_MAX + 1) === 'cluster' && clusterStride(1200) === 4);
check('explicit modes override the adaptive choice', unknownRepresentation('boxes', 5000) === 'boxes' && unknownRepresentation('hidden', 3) === 'hidden');
const reps = objects.map((o) => unknownRepresentation('simplified', planGroups(displayParts(o)).unknownCount));
check('Pantalone: big pieces are simplified, tiny pieces keep boxes', reps.includes('points') && reps.includes('cluster') && reps.includes('boxes'), reps.join(','));

// ---------- level of detail ----------
const px = (r, d) => pixelRadius(r, d, 50, 800);
check('projected radius grows as the camera approaches', px(0.5, 2) > px(0.5, 10) && px(0.5, 10) > 0);
check('near → full, mid → medium, far → far', lodLevel({ pixelRadius: 300 }) === 'full' && lodLevel({ pixelRadius: 30 }) === 'medium' && lodLevel({ pixelRadius: 5 }) === 'far');
check('selected objects always get full detail', lodLevel({ pixelRadius: 2, selected: true }) === 'full');
check('Performance Mode simplifies earlier and during playback', lodLevel({ pixelRadius: 12, perf: true }) === 'far' && lodLevel({ pixelRadius: 12 }) === 'medium' && lodLevel({ pixelRadius: 300, perf: true, playing: true }) === 'medium');
check('orthographic projection has its own radius formula', pixelRadius(0.5, 1, 50, 800, true, 2) === 200);

// ---------- performance mode ----------
check('auto performance mode above the part threshold', perfModeActive('auto', PERF_AUTO_PARTS + 1) && !perfModeActive('auto', 100) && perfModeActive('on', 1) && !perfModeActive('off', 1e6));
check('Pantalone triggers automatic performance mode', perfModeActive('auto', totalParts));

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
