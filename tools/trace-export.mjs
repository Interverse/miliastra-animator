// Diagnostic CLI: trace one object's transform through every export stage.
//   node tools/trace-export.mjs <project.animator.json> [objectName] [exported.gia]
// Prints saved JSON → hierarchy → rest/placement → keys/evaluated poses → exported
// object transform + Motion Device waypoints, and compares with an exported file.
import { readFileSync } from 'node:fs';
import { restWorld, evaluatePose } from '../js/anim/evaluate.js';
import { exportBasePose, exportPlacement, referenceYaw } from '../js/gia/gia-export.js';
import { exportGia } from '../js/gia/gia-export.js';
import { parseGia, collectObjects } from '../js/gia/gia-file.js';
import { quat, v3, displayQuatToGameEuler, gameEulerToDisplayQuat } from '../js/core/math.js';
import { getNode, worldTransforms, localTransform } from '../js/scene/scene.js';

const j = JSON.parse(readFileSync(process.argv[2] || new URL('./fixtures/bangboo.animator.json', import.meta.url), 'utf8'));
const p = j.project;
const gia = Uint8Array.from(Buffer.from(j.gia, 'base64'));
const E = (q) => quat.toEulerDeg(q).map((a) => +a.toFixed(3));
const P = (v) => v.map((x) => +x.toFixed(4));
const name = process.argv[3] || 'Body';
const node = p.nodes.find((n) => n.type === 'object' && n.name === name);
const chain = []; for (let c = node; c; c = c.parent ? getNode(p, c.parent) : null) chain.unshift(c);

console.log(`=== ${name} (guid ${node.guid}) ===`);
console.log('1. saved JSON  node.pos', P(node.pos), 'node.rot euler', E(node.rot), 'correction', node.correction, 'filePos', P(node.filePos), 'fileRot euler', E(node.fileRot));
console.log('   original .gia object transform:');
const src = collectObjects(parseGia(gia)).find((o) => o.guid === node.guid);
console.log('   ', JSON.stringify(src.transform), 'devices', src.motionDevices.length);
console.log('2/3. hierarchy (root → object), local transforms:');
for (const c of chain) console.log(`    ${c.type.padEnd(6)} ${c.name.padEnd(12)} pos ${P(c.pos)} rot ${E(c.rot)}${c.type === 'object' ? ' corr ' + JSON.stringify(c.correction) : ''}`);
const rest = restWorld(p);
console.log('4/5. rest world (display space):', 'pos', P(rest.get(node.id).pos), 'rot euler', E(rest.get(node.id).rot));
console.log('    parent bone world rot', E(rest.get(node.parent).rot));
console.log('6. frame 0 of initial animation:', 'pos', P(exportBasePose(p).get(node.id).pos), 'rot euler', E(exportBasePose(p).get(node.id).rot));
console.log(`   export placement (turned by the reference output rotation ${referenceYaw(p)}°):`, 'pos', P(exportPlacement(p).get(node.id).pos), 'rot euler', E(exportPlacement(p).get(node.id).rot));
console.log('7. globalOffset', p.settings.globalOffset);
const clip = p.clips[0];
console.log(`8. clip "${clip.name}" duration ${clip.duration}, tracks on chain:`);
for (const c of chain) { const tr = clip.tracks[c.id]; if (tr) console.log(`    ${c.name}: pos keys ${tr.pos.map((k) => k.t).join(',')} | rot keys ${tr.rot.map((k) => k.t + '=' + E(k.v).join('/')).join('  ')}`); }
for (const t of [0, 0.25, 0.5, 0.75, 1, 1.5]) { const w = evaluatePose(p, clip.id, t).world.get(node.id); console.log(`    t=${t}: world pos ${P(w.pos)} rot ${E(w.rot)}`); }
console.log('9/10. export:');
const { bytes, report } = exportGia(p, gia);
const out = collectObjects(parseGia(bytes)).find((o) => o.guid === node.guid);
console.log('    exported object transform', JSON.stringify(out.transform));
console.log('    exported transform back to display euler', E(gameEulerToDisplayQuat(out.transform.rotation)), '(rest world euler', E(rest.get(node.id).rot), ')');
for (const d of out.motionDevices) {
  console.log(`    device "${d.name}" type ${d.motionType} points ${d.points.length}`);
  for (const pt of d.points.slice(0, 6)) console.log('      pos', JSON.stringify(pt.pos), 'rot', JSON.stringify(pt.rot), 'dur', pt.duration);
}
console.log('    report warnings', report.warnings.length);
if (process.argv[4]) {
  const ref = collectObjects(parseGia(readFileSync(process.argv[4]))).find((o) => o.guid === node.guid);
  console.log('11. user-supplied exported .gia:', JSON.stringify(ref.transform));
  for (const d of ref.motionDevices) { console.log(`    device "${d.name}" points ${d.points.length}`); for (const pt of d.points.slice(0, 6)) console.log('      pos', JSON.stringify(pt.pos), 'rot', JSON.stringify(pt.rot), 'dur', pt.duration); }
  const same = Buffer.compare(Buffer.from(bytes), readFileSync(process.argv[4])) === 0;
  console.log('    byte-identical to fresh export:', same);
}
