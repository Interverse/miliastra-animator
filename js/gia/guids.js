// GUID allocation. Observed spaces: objects from 0x40400001, decorations from
// 0x4000000D, node graphs at 0x40000001…; only uniqueness within the file
// matters, so we take the next free number in the matching space.
export const OBJECT_GUID_BASE = 1077936129;
export const GRAPH_GUID_BASE = 1073741825;

export function nextFreeGuid(used, base) {
  let g = base;
  while (used.has(g)) g++;
  used.add(g);
  return g;
}

export function nextObjectGuid(used, existingObjects = []) {
  let max = OBJECT_GUID_BASE - 1;
  for (const g of existingObjects) if (g >= OBJECT_GUID_BASE && g < OBJECT_GUID_BASE + 0x100000) max = Math.max(max, g);
  return nextFreeGuid(used, max + 1);
}

export function nextGraphGuid(used) {
  return nextFreeGuid(used, GRAPH_GUID_BASE);
}
