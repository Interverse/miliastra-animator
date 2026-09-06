// Canonical state → viewport reconciliation (no Three.js here, so it is testable headless).
//
// The project is the single source of truth. Every editor-rendered entity is
// registered under its state id; each frame the registry is reconciled with the
// desired entity list derived from the project:
//   state entity missing  + viewport entity present → dispose
//   state entity present  + viewport entity missing → create (may be deferred for progressive builds)
//   both present, signature changed                 → dispose + create
//   both present                                    → update
// Nothing else may add or keep objects under the project scene root.

export class EntityRegistry {
  constructor() { this.entries = new Map(); } // id → record (must carry { id, sig })
  get size() { return this.entries.size; }
  get(id) { return this.entries.get(id); }
  has(id) { return this.entries.has(id); }
  ids() { return [...this.entries.keys()]; }
  values() { return this.entries.values(); }
  // desired: iterable of { id, sig, ...payload }; hooks: { create(desc) → record, update(record, desc), dispose(record), defer?(desc) → bool }
  reconcile(desired, { create, update, dispose, defer = null }) {
    const stats = { created: 0, updated: 0, disposed: 0, deferred: 0, total: 0 };
    const live = new Set();
    for (const desc of desired) {
      stats.total++;
      let rec = this.entries.get(desc.id);
      if (rec && rec.sig !== desc.sig) { dispose(rec); this.entries.delete(desc.id); rec = null; stats.disposed++; }
      if (!rec) {
        if (defer && defer(desc)) { stats.deferred++; continue; } // not created yet: never counted as live, retried next frame
        rec = create(desc);
        rec.id = desc.id; rec.sig = desc.sig;
        this.entries.set(desc.id, rec);
        stats.created++;
      }
      live.add(desc.id);
      if (update) { update(rec, desc); stats.updated++; }
    }
    for (const [id, rec] of [...this.entries]) if (!live.has(id)) { dispose(rec); this.entries.delete(id); stats.disposed++; }
    return stats;
  }
  clear(dispose) {
    for (const rec of this.entries.values()) dispose(rec);
    this.entries.clear();
  }
}

// Signature of a node's structural representation: a change rebuilds its visual.
export function nodeSignature(node) {
  switch (node.type) {
    case 'object': return `o|${node.zoom?.join(',')}`;
    case 'bone': return 'b';
    case 'proxy': return `p|${node.shape}|${node.color}`;
    default: return node.type;
  }
}
// The entities the viewport must show for a project: exactly its nodes (objects,
// bones, proxies, IK targets and poles). Constraint / parent lines, waypaths and
// previews are derived per frame from state and own no registry entries.
export function viewportEntities(project) {
  return project.nodes.map((node) => ({ id: node.id, sig: nodeSignature(node), type: node.type, node }));
}

// Development diagnostics over a plain description of the viewport (built by the
// viewport or a test double). Returns { ok, issues: [{ kind, id? }] }.
export function validateSceneModel({ project, registryIds, attached = () => true, building = false, rootChildCount = null, gizmoIds = [], selection = [], active = null, pathPointWaypaths = [], pathPointSel = null, extraIssues = [] }) {
  const issues = [...extraIssues];
  const stateIds = new Set(project.nodes.map((n) => n.id));
  const reg = new Set(registryIds);
  for (const id of reg) {
    if (!stateIds.has(id)) issues.push({ kind: 'orphanEntity', id }); // rendered, but no state entity
    else if (!attached(id)) issues.push({ kind: 'detachedEntity', id }); // registered, but not in the scene graph
  }
  if (!building) for (const id of stateIds) if (!reg.has(id)) issues.push({ kind: 'missingEntity', id });
  if (rootChildCount != null && rootChildCount !== reg.size) issues.push({ kind: 'strayRootChildren', n: rootChildCount - reg.size });
  for (const id of gizmoIds) if (id && !stateIds.has(id)) issues.push({ kind: 'gizmoStale', id });
  for (const id of selection) if (!stateIds.has(id)) issues.push({ kind: 'staleSelection', id });
  if (active && !stateIds.has(active)) issues.push({ kind: 'staleActive', id: active });
  const wpIds = new Set(project.waypaths.map((w) => w.id));
  for (const id of pathPointWaypaths) if (!wpIds.has(id)) issues.push({ kind: 'stalePathPoint', id });
  if (pathPointSel && (!wpIds.has(pathPointSel.wpId) || !(project.waypaths.find((w) => w.id === pathPointSel.wpId)?.points?.[pathPointSel.index]))) issues.push({ kind: 'stalePathSelection', id: pathPointSel.wpId });
  return { ok: issues.length === 0, issues, entities: reg.size, stateNodes: stateIds.size };
}
