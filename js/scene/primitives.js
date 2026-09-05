// Display-only proxy geometry for known Miliastra model ids, plus the user
// proxy primitives (cuboid / cylinder / sphere). Sizes are the canonical
// in-game size at world scale 1 (a decoration's world scale is parent zoom ×
// local scale, e.g. 0.1 × 10 = 1 → the sphere is 1 m across).
//
// Geometry descriptions are renderer-agnostic: { kind, size } for standard
// shapes or { kind: 'mesh', positions: [...], indices: [...] } for custom ones.

export const MODEL_IDS = {
  20001925: { key: 'triangle', name: 'Roof Component' },
  20002125: { key: 'triangleLegacy', name: 'Right Triangle (legacy)' },
  10009001: { key: 'cuboid', name: 'Cuboid' },
  10009002: { key: 'sphere', name: 'Sphere' },
  10009003: { key: 'plane', name: 'Plane' },
  10009004: { key: 'prism', name: 'Triangular Prism' },
  10009006: { key: 'pyramid', name: 'Triangular Pyramid' },
  10009008: { key: 'cylinder', name: 'Cylinder' },
  10009009: { key: 'cone', name: 'Cone' },
};

export function modelInfo(modelId) {
  return MODEL_IDS[modelId] || null;
}

// Equilateral triangular pyramid (model 10009006): base side 0.75, height 1,
// base at the bottom, two base vertices at ±X, third toward -Z, apex above the
// base centre, pivot at the centre of the pyramid.
export function pyramidMesh(side = 0.75, height = 1) {
  const h = side * Math.sqrt(3) / 2; // triangle height
  const cz = -h / 3; // centroid z of base triangle (vertices at z=0 and z=-h)
  const y0 = -height / 2, y1 = height / 2;
  const A = [side / 2, y0, 0 - cz], B = [-side / 2, y0, 0 - cz], C = [0, y0, -h - cz], T = [0, y1, 0];
  // recentre: base vertices at z=-cz(=h/3) and z=-h-cz(=-2h/3) → centroid at 0
  const positions = [...A, ...B, ...C, ...T];
  const indices = [0, 2, 1, /* base (facing down) */ 0, 1, 3, 1, 2, 3, 2, 0, 3];
  return { kind: 'mesh', positions, indices };
}

// Triangular prism: equilateral cross-section (side) in the XZ plane, height along Y.
export function prismMesh(side = 0.75, height = 1) {
  const r = side / Math.sqrt(3); // circumradius
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + i * (2 * Math.PI / 3);
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  const positions = [];
  for (const y of [-height / 2, height / 2]) for (const [x, z] of pts) positions.push(x, y, z);
  const indices = [
    0, 1, 2, // bottom
    3, 5, 4, // top
    0, 3, 1, 1, 3, 4,
    1, 4, 2, 2, 4, 5,
    2, 5, 0, 0, 5, 3,
  ];
  return { kind: 'mesh', positions, indices };
}

// Roof component / right triangle: right angle at origin, thin along X,
// legs 1.3 m along +Y and 2.7 m along -Z at world scale 1 (0.13/0.27 × 10).
export function triangleMesh(legY = 1.3, legZ = 2.7, thickness = 0.1) {
  const t = thickness / 2;
  const P = [[0, 0, 0], [0, legY, 0], [0, 0, -legZ]];
  const positions = [];
  for (const x of [-t, t]) for (const p of P) positions.push(x + p[0], p[1], p[2]);
  const indices = [0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0];
  return { kind: 'mesh', positions, indices };
}

// Geometry for a decoration with a known model id (unit world scale).
export function geometryForModel(modelId) {
  const info = modelInfo(modelId);
  switch (info?.key) {
    case 'cuboid': return { kind: 'box', size: [1, 1, 1] };
    case 'sphere': return { kind: 'sphere', size: [1, 1, 1] };
    case 'plane': return { kind: 'box', size: [1, 0.02, 1] };
    case 'cylinder': return { kind: 'cylinder', size: [1, 1, 1] };
    case 'cone': return { kind: 'cone', size: [1, 1, 1] };
    case 'prism': return prismMesh(0.75, 1);
    case 'pyramid': return pyramidMesh(0.75, 1);
    case 'triangle': return triangleMesh(1.3, 2.7, 0.1);
    case 'triangleLegacy': return triangleMesh(5, 5, 0.1);
    default: return null;
  }
}

export const PROXY_SHAPES = ['cuboid', 'cylinder', 'sphere'];
export function geometryForProxy(shape) {
  switch (shape) {
    case 'cylinder': return { kind: 'cylinder', size: [1, 1, 1] };
    case 'sphere': return { kind: 'sphere', size: [1, 1, 1] };
    default: return { kind: 'box', size: [1, 1, 1] };
  }
}

// ARGB → css hex + alpha
export function argbToRgb(argb) {
  if (argb == null) return { hex: '#8fa3bf', alpha: 1 };
  const a = ((argb >>> 24) & 255) / 255;
  const rgb = argb & 0xffffff;
  return { hex: '#' + rgb.toString(16).padStart(6, '0'), alpha: a };
}
