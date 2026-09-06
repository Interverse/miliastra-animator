// Bone-name understanding and automatic source → target mapping.
//
// Roles are the shared vocabulary: hips, spine, chest, neck, head, shoulder.L/R,
// upperArm.L/R, forearm.L/R, hand.L/R, thigh.L/R, shin.L/R, foot.L/R, toe.L/R.
// Names are normalised (prefixes such as "mixamorig:", "Bip01 ", "DEF-",
// "J_Bip_C_" are stripped, left/right tokens in any common convention are
// detected) and matched against a keyword table; hierarchy depth breaks ties
// (first spine → spine, last → chest). Mapping presets are keyed by the source
// skeleton's signature so the same skeleton never has to be mapped twice.
export const ROLES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder.L', 'upperArm.L', 'forearm.L', 'hand.L', 'shoulder.R', 'upperArm.R', 'forearm.R', 'hand.R', 'thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R'];
export const MAJOR_ROLES = ['hips', 'spine', 'head', 'upperArm.L', 'forearm.L', 'upperArm.R', 'forearm.R', 'thigh.L', 'shin.L', 'thigh.R', 'shin.R'];
// parent role per role (for direction / hierarchy checks)
export const ROLE_PARENT = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', 'shoulder.L': 'chest', 'upperArm.L': 'shoulder.L', 'forearm.L': 'upperArm.L', 'hand.L': 'forearm.L', 'shoulder.R': 'chest', 'upperArm.R': 'shoulder.R', 'forearm.R': 'upperArm.R', 'hand.R': 'forearm.R', 'thigh.L': 'hips', 'shin.L': 'thigh.L', 'foot.L': 'shin.L', 'toe.L': 'foot.L', 'thigh.R': 'hips', 'shin.R': 'thigh.R', 'foot.R': 'shin.R', 'toe.R': 'foot.R' };
export const ROLE_CHILD = Object.fromEntries(Object.entries(ROLE_PARENT).map(([c, p]) => [p, c]).filter(([p]) => !/^(hips|chest)$/.test(p)));

const PREFIXES = /^(mixamorig[:_]?|bip0?1[ _]?|character\d*[_:]?|b_|def-|org-|mch-|j_bip_[clr]_|j_|armature[|:]|skeleton[|:]|root[|:])/i;
const SIDE_PATTERNS = [
  [/(^|[_\-. |])(l|left|lft)([_\-. |]|$)/i, 'L'], [/(^|[_\-. |])(r|right|rgt)([_\-. |]|$)/i, 'R'],
  [/^l(?=[A-Z])/, 'L'], [/^r(?=[A-Z])/, 'R'], [/(left)/i, 'L'], [/(right)/i, 'R'], [/[_.]l$/i, 'L'], [/[_.]r$/i, 'R'], [/_l_/i, 'L'], [/_r_/i, 'R'],
];
const KEYWORDS = [
  ['toe', /toe|ball/i], ['foot', /foot|ankle|feet/i], ['shin', /shin|calf|lower_?leg|leg_?lower|knee|(?<!up)leg$|^leg/i], ['thigh', /thigh|upper_?leg|up_?leg|leg_?upper|upleg/i],
  ['hand', /hand|wrist|palm/i], ['forearm', /fore_?arm|lower_?arm|arm_?lower|elbow|lowarm/i], ['upperArm', /upper_?arm|up_?arm|arm_?upper|uparm|(?<!fore)(?<!lower)arm/i], ['shoulder', /shoulder|clavicle|collar/i],
  ['head', /head/i], ['neck', /neck/i], ['chest', /chest|upper_?chest|spine_?0?[3-9]|thorax/i], ['spine', /spine|torso|abdomen|waist(?!.*hip)/i], ['hips', /hips?$|pelvis|^root$|cog|center|centre/i],
];

export function normalizeName(name) {
  let n = String(name || '').trim();
  n = n.replace(/^.*[|/]/, ''); // "Armature|Hips" / "Hips/Spine"
  n = n.replace(PREFIXES, '');
  return n;
}
export function sideOf(name) {
  const n = String(name || '');
  const nn = normalizeName(n);
  for (const [re, side] of SIDE_PATTERNS) if (re.test(nn) || re.test(n)) return side;
  return null;
}
// role keyword (without side) for a bone name, or null
export function roleKeyword(name) {
  const n = normalizeName(name).replace(/(^|[_\-. ])(l|r|left|right|lft|rgt)([_\-. ]|$)/gi, ' ').replace(/^l(?=[A-Z])|^r(?=[A-Z])/, '').replace(/_end$/i, '');
  if (/_end$|_?end$|_tip$|_nub$/i.test(normalizeName(name))) return null; // end sites / nubs are not bones to drive
  for (const [role, re] of KEYWORDS) if (re.test(n)) return role;
  return null;
}
const SIDED = new Set(['shoulder', 'upperArm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'toe']);
// full role for a name (e.g. "mixamorig:LeftForeArm" → forearm.L), null when unknown
export function roleOf(name) {
  const kw = roleKeyword(name);
  if (!kw) return null;
  if (!SIDED.has(kw)) return kw;
  const side = sideOf(name);
  return side ? `${kw}.${side}` : null;
}

// Assign roles to a list of bones ({ name, parent, depth, index }); ties broken by depth.
export function assignRoles(bones) {
  const byRole = new Map();
  for (const b of bones) {
    const kw = roleKeyword(b.name);
    if (!kw) continue;
    const side = sideOf(b.name);
    const role = SIDED.has(kw) ? (side ? `${kw}.${side}` : null) : kw;
    if (!role) continue;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(b);
  }
  const out = {};
  // spine family: spine = shallowest, chest = deepest spine-like bone (unless an explicit chest exists)
  const spines = (byRole.get('spine') || []).slice().sort((a, b) => a.depth - b.depth);
  const chests = (byRole.get('chest') || []).slice().sort((a, b) => b.depth - a.depth);
  if (spines.length) out.spine = spines[0];
  if (chests.length) out.chest = chests[0];
  else if (spines.length > 1) out.chest = spines[spines.length - 1]; // Spine/Spine1/Spine2 → the last one is the chest
  for (const [role, list] of byRole) {
    if (role === 'spine' || role === 'chest') continue;
    // prefer the shallowest candidate; "head" beats "HeadTop_End"
    out[role] = list.sort((a, b) => a.depth - b.depth)[0];
  }
  return out; // role → bone
}

// Automatic mapping: { targetBoneId → sourceBoneIndex } plus per-role info.
export function autoMap(sourceBones, targetBones, { humanoidMap = null } = {}) {
  const srcRoles = assignRoles(sourceBones);
  if (humanoidMap) for (const [role, name] of Object.entries(humanoidMap)) { const b = sourceBones.find((x) => x.name === name); if (b) srcRoles[role] = b; }
  const tgtRoles = assignRoles(targetBones);
  const mapping = {};
  const roles = {};
  for (const role of ROLES) {
    const s = srcRoles[role], tg = tgtRoles[role];
    if (s && tg) { mapping[tg.id] = s.index; roles[tg.id] = role; }
  }
  // torso fallback: a skeleton with a single torso bone (only "Spine" or only "Chest") still drives the other's torso
  const torsoPairs = [['spine', 'chest'], ['chest', 'spine']];
  for (const [a, b] of torsoPairs) {
    const tg = tgtRoles[a], s = srcRoles[b];
    if (tg && s && mapping[tg.id] == null && !srcRoles[a] && !tgtRoles[b]) { mapping[tg.id] = s.index; roles[tg.id] = a; }
  }
  return { mapping, roles, sourceRoles: Object.fromEntries(Object.entries(srcRoles).map(([r, b]) => [r, b.index])), targetRoles: Object.fromEntries(Object.entries(tgtRoles).map(([r, b]) => [r, b.id])) };
}

// Problems worth flagging before retargeting.
export function mappingIssues(mapping, targetBones, sourceBones, targetRoles) {
  const issues = [];
  const used = new Map();
  for (const [tid, si] of Object.entries(mapping)) { if (si == null) continue; if (!used.has(si)) used.set(si, []); used.get(si).push(tid); }
  for (const [si, tids] of used) if (tids.length > 1) issues.push({ kind: 'duplicate', source: sourceBones[si]?.name, targets: tids.map((id) => targetBones.find((b) => b.id === id)?.name) });
  const mappedRoles = new Set(Object.entries(targetRoles).filter(([, id]) => mapping[id] != null).map(([r]) => r));
  const missingRoles = MAJOR_ROLES.filter((r) => targetRoles[r] && !mappedRoles.has(r));
  if (missingRoles.length) issues.push({ kind: 'unmappedMajor', roles: missingRoles });
  // spine and chest are one torso family: a rig with only a "Chest" bone is not missing its spine
  const absent = MAJOR_ROLES.filter((r) => !targetRoles[r] && !(r === 'spine' && targetRoles.chest));
  if (absent.length) issues.push({ kind: 'targetMissing', roles: absent });
  if (!targetRoles.hips) issues.push({ kind: 'noHips' });
  return issues;
}

// ---------- presets ----------
export function skeletonSignature(sourceBones) { return sourceBones.map((b) => b.name).sort().join('|'); }
export function roleMappingFromIds(mapping, targetRoles, sourceBones) {
  // reusable form: role → source bone name
  const out = {};
  for (const [role, tid] of Object.entries(targetRoles)) if (mapping[tid] != null) out[role] = sourceBones[mapping[tid]]?.name;
  return out;
}
export function mappingFromRoles(roleMap, targetRoles, sourceBones) {
  const byName = new Map(sourceBones.map((b) => [b.name, b.index]));
  const mapping = {};
  for (const [role, name] of Object.entries(roleMap)) { const tid = targetRoles[role]; const si = byName.get(name); if (tid && si != null) mapping[tid] = si; }
  return mapping;
}
