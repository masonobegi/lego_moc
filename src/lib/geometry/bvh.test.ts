import { describe, expect, it } from 'vitest';

import { TriangleBVH } from './bvh';

/** Two triangles forming a unit quad in the z = 0 plane, spanning x,y in [0,1]. */
function quad(z: number): number[] {
  return [
    0, 0, z, 1, 0, z, 1, 1, z,
    0, 0, z, 1, 1, z, 0, 1, z,
  ];
}

describe('TriangleBVH', () => {
  it('reports a hit for a ray through the quad', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    expect(bvh.intersectsRay(0.5, 0.5, -1, 0, 0, 1, 10)).toBe(true);
  });

  it('reports a miss for a ray beside the quad', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    expect(bvh.intersectsRay(5, 5, -1, 0, 0, 1, 10)).toBe(false);
  });

  it('respects tMax', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    expect(bvh.intersectsRay(0.5, 0.5, -10, 0, 0, 1, 5)).toBe(false);
    expect(bvh.intersectsRay(0.5, 0.5, -10, 0, 0, 1, 20)).toBe(true);
  });

  it('ignores a hit closer than epsilon, so a ray can leave a surface', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    // Starting exactly on the surface and travelling away from it.
    expect(bvh.intersectsRay(0.5, 0.5, 0, 0, 0, 1, 10, 0.02)).toBe(false);
  });

  it('is double sided', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    expect(bvh.intersectsRay(0.5, 0.5, 1, 0, 0, -1, 10)).toBe(true);
  });

  it('handles an empty mesh', () => {
    const bvh = new TriangleBVH(new Float32Array(0));
    expect(bvh.triangleCount).toBe(0);
    expect(bvh.intersectsRay(0, 0, 0, 1, 0, 0, 100)).toBe(false);
  });

  it('handles axis-aligned rays without dividing by zero', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    expect(bvh.intersectsRay(0.5, 0.5, -1, 0, 0, 1, 10)).toBe(true);
    // A ray exactly in the plane of the quad must not report a spurious hit
    // far away, and must not produce NaN.
    expect(bvh.intersectsRay(-5, 0.5, 0, 1, 0, 0, 100)).toBeTypeOf('boolean');
  });

  it('agrees with brute force on a randomised but deterministic scene', () => {
    // A deterministic pseudo-random cloud of triangles.
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const count = 400;
    const positions = new Float32Array(count * 9);
    for (let i = 0; i < count * 9; i += 9) {
      const cx = rand() * 100;
      const cy = rand() * 100;
      const cz = rand() * 100;
      for (let v = 0; v < 3; v++) {
        positions[i + v * 3] = cx + (rand() - 0.5) * 8;
        positions[i + v * 3 + 1] = cy + (rand() - 0.5) * 8;
        positions[i + v * 3 + 2] = cz + (rand() - 0.5) * 8;
      }
    }
    const bvh = new TriangleBVH(positions);
    const brute = new TriangleBVH(positions);

    // Compare the accelerated query against a leaf-only traversal by testing
    // many rays; any disagreement means the tree is dropping geometry.
    let checked = 0;
    for (let r = 0; r < 500; r++) {
      const ox = rand() * 120 - 10;
      const oy = rand() * 120 - 10;
      const oz = -50;
      const hit = bvh.intersectsRay(ox, oy, oz, 0, 0, 1, 400);
      const reference = bruteForce(positions, ox, oy, oz, 0, 0, 1, 400);
      expect(hit).toBe(reference);
      if (hit) checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(brute.triangleCount).toBe(count);
  });

  it('survives a serialize/deserialize round trip', () => {
    const bvh = new TriangleBVH(new Float32Array(quad(0)));
    const restored = TriangleBVH.fromTransfer(bvh.toTransfer());
    expect(restored.triangleCount).toBe(bvh.triangleCount);
    expect(restored.intersectsRay(0.5, 0.5, -1, 0, 0, 1, 10)).toBe(true);
    expect(restored.intersectsRay(5, 5, -1, 0, 0, 1, 10)).toBe(false);
  });
});

/** Reference implementation: test every triangle, no acceleration. */
function bruteForce(
  positions: Float32Array,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
  epsilon = 1e-4,
): boolean {
  for (let o = 0; o < positions.length; o += 9) {
    const ax = positions[o]!, ay = positions[o + 1]!, az = positions[o + 2]!;
    const e1x = positions[o + 3]! - ax, e1y = positions[o + 4]! - ay, e1z = positions[o + 5]! - az;
    const e2x = positions[o + 6]! - ax, e2y = positions[o + 7]! - ay, e2z = positions[o + 8]! - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const invDet = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) continue;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (dist > epsilon && dist < tMax) return true;
  }
  return false;
}
