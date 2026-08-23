/**
 * Minimal, dependency-free linear algebra for LDraw geometry.
 *
 * LDraw uses a right-handed coordinate system where **-Y is up** and one LDraw
 * Unit (LDU) is 0.4 mm. A line type 1 stores a translation (x, y, z) and the
 * top-left 3x3 of a homogeneous transform as `a b c d e f g h i`, applied as:
 *
 *     u' = a*u + b*v + c*w + x
 *     v' = d*u + e*v + f*w + y
 *     w' = g*u + h*v + i*w + z
 *
 * i.e. the 3x3 is ROW-MAJOR and points are column vectors: p' = M*p + t.
 * (LDraw File Format 1.0.2, https://ldraw.org/article/218.html)
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Row-major 3x3: [a, b, c, d, e, f, g, h, i]. */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleVec(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l === 0 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Apply the 3x3 (rotation/scale) part only. */
export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/** Full affine transform: M*p + t. */
export function transformPoint(m: Mat3, t: Vec3, p: Vec3): Vec3 {
  return addVec(applyMat3(m, p), t);
}

/** Matrix product a*b (both row-major). */
export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],

    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],

    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

/**
 * Compose parent (M1, t1) with child (M2, t2) so that a child-local point p maps
 * to M1*(M2*p + t2) + t1.
 */
export function composeTransform(
  parentM: Mat3,
  parentT: Vec3,
  childM: Mat3,
  childT: Vec3,
): { matrix: Mat3; position: Vec3 } {
  return {
    matrix: multiplyMat3(parentM, childM),
    position: addVec(applyMat3(parentM, childT), parentT),
  };
}

export function determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function invertMat3(m: Mat3): Mat3 | null {
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * id,
    (m[2] * m[7] - m[1] * m[8]) * id,
    (m[1] * m[5] - m[2] * m[4]) * id,

    (m[5] * m[6] - m[3] * m[8]) * id,
    (m[0] * m[8] - m[2] * m[6]) * id,
    (m[2] * m[3] - m[0] * m[5]) * id,

    (m[3] * m[7] - m[4] * m[6]) * id,
    (m[1] * m[6] - m[0] * m[7]) * id,
    (m[0] * m[4] - m[1] * m[3]) * id,
  ];
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export function emptyBox(): Box3 {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

export function expandBox(box: Box3, p: Vec3): void {
  if (p.x < box.min.x) box.min = { ...box.min, x: p.x };
  if (p.y < box.min.y) box.min = { ...box.min, y: p.y };
  if (p.z < box.min.z) box.min = { ...box.min, z: p.z };
  if (p.x > box.max.x) box.max = { ...box.max, x: p.x };
  if (p.y > box.max.y) box.max = { ...box.max, y: p.y };
  if (p.z > box.max.z) box.max = { ...box.max, z: p.z };
}

export function boxIsEmpty(box: Box3): boolean {
  return box.min.x > box.max.x || box.min.y > box.max.y || box.min.z > box.max.z;
}

export function boxCenter(box: Box3): Vec3 {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

export function boxSize(box: Box3): Vec3 {
  return {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  };
}
