import { dot } from './coveragePreviewMath.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const negative = a => ({ x: -a.x, y: -a.y, z: -a.z });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

// Faces belong to the selected blue proxy, never to the surrounding tileset.
export function geometryCameraFaces(shape) {
  if (!shape) return [];
  const { center, xAxis: x, yAxis: y, zAxis: z, minX, maxX, minY, maxY, minZ, maxZ, radius } = shape;
  const at = (u, v, w) => ({
    x: center.x + x.x * u + y.x * v + z.x * w,
    y: center.y + x.y * u + y.y * v + z.y * w,
    z: center.z + x.z * u + y.z * v + z.z * w
  });
  if (radius > 0) {
    const count = 72, faces = [], roof = [];
    for (let i = 0; i < count; i++) {
      const a = i * 2 * Math.PI / count, b = (i + 1) * 2 * Math.PI / count, mid = (a + b) / 2;
      const u = radius * Math.cos(a), v = radius * Math.sin(a), u2 = radius * Math.cos(b), v2 = radius * Math.sin(b);
      const normal = { x: x.x * Math.cos(mid) + y.x * Math.sin(mid), y: x.y * Math.cos(mid) + y.y * Math.sin(mid), z: x.z * Math.cos(mid) + y.z * Math.sin(mid) };
      faces.push({ normal, vertices: [at(u, v, minZ), at(u2, v2, minZ), at(u2, v2, maxZ), at(u, v, maxZ)] });
      roof.push(at(u, v, maxZ));
    }
    return [...faces, { normal: z, vertices: roof }];
  }
  return [
    { normal: y, vertices: [at(minX, maxY, minZ), at(maxX, maxY, minZ), at(maxX, maxY, maxZ), at(minX, maxY, maxZ)] },
    { normal: negative(y), vertices: [at(minX, minY, minZ), at(maxX, minY, minZ), at(maxX, minY, maxZ), at(minX, minY, maxZ)] },
    { normal: x, vertices: [at(maxX, minY, minZ), at(maxX, maxY, minZ), at(maxX, maxY, maxZ), at(maxX, minY, maxZ)] },
    { normal: negative(x), vertices: [at(minX, minY, minZ), at(minX, maxY, minZ), at(minX, maxY, maxZ), at(minX, minY, maxZ)] },
    { normal: z, vertices: [at(minX, minY, maxZ), at(maxX, minY, maxZ), at(maxX, maxY, maxZ), at(minX, maxY, maxZ)] }
  ];
}

export function cameraSurfaceFootprint(faces, frame, camera, far) {
  const tanH = camera.sensorWidth / (2 * camera.focalLength), tanV = camera.sensorHeight / (2 * camera.focalLength);
  const planes = [
    v => dot(v, frame.forward) - 0.05,
    v => far - dot(v, frame.forward),
    v => dot(v, frame.forward) * tanH + dot(v, frame.right),
    v => dot(v, frame.forward) * tanH - dot(v, frame.right),
    v => dot(v, frame.forward) * tanV + dot(v, frame.up),
    v => dot(v, frame.forward) * tanV - dot(v, frame.up)
  ];
  const patches = [];
  for (const face of faces) {
    if (dot(face.normal, sub(frame.position, face.vertices[0])) <= 1e-8) continue;
    let vertices = face.vertices.map(p => sub(p, frame.position));
    for (const plane of planes) {
      const clipped = [];
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i], b = vertices[(i + 1) % vertices.length];
        const da = plane(a), db = plane(b);
        if (da >= 0) clipped.push(a);
        if ((da >= 0) !== (db >= 0)) clipped.push(lerp(a, b, da / (da - db)));
      }
      vertices = clipped;
      if (vertices.length < 3) break;
    }
    if (vertices.length >= 3) patches.push({ normal: face.normal, vertices: vertices.map(v => ({ x: frame.position.x + v.x, y: frame.position.y + v.y, z: frame.position.z + v.z })) });
  }
  return patches;
}

// Four connectors end at actual surface vertices, including a clipped image
// border at a building edge. There is no arbitrary far rectangle in mid-air.
export function footprintConnectors(patches, frame, camera) {
  const vertices = patches.flatMap(patch => patch.vertices);
  if (!vertices.length) return [];
  const tanH = camera.sensorWidth / (2 * camera.focalLength), tanV = camera.sensorHeight / (2 * camera.focalLength);
  const projected = vertices.map(position => {
    const v = sub(position, frame.position), depth = dot(v, frame.forward);
    return { position, h: dot(v, frame.right) / (depth * tanH), v: dot(v, frame.up) / (depth * tanV) };
  });
  return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([h, v]) => {
    let best = projected[0], score = -Infinity;
    for (const point of projected) {
      const next = h * point.h + v * point.v;
      if (next > score) { best = point; score = next; }
    }
    return best.position;
  });
}
