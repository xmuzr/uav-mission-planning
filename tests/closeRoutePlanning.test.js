import test from 'node:test';
import assert from 'node:assert/strict';
import { closePhotoSpacing, coveringRows, estimateSurfaceNormal, planClosePhotography, connectCloseSegments, closeRouteLegs } from '../src/utils/closeRoutePlanning.js';

const camera = { sensorWidth: 6.3, sensorHeight: 4.7, focalLength: 4.88 };
const box = { center: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 10 };
const waypoint = (position, target, attributes = {}) => ({ ...attributes, cartesian: position, targetCartesian: target });
const defaults = { box, camera, range: 3, lateralOverlap: 0, longitudinalOverlap: 0, faces: ['top'],
  raycast: async (origin) => ({ x: origin.x, y: origin.y, z: 2 + 0.2 * origin.x + 0.1 * origin.y }),
  isVisible: async () => true, isClear: async () => true, connect: async () => [], makeWaypoint: waypoint };

test('spacing uses the vertical field of view for side layers and preserves overlap', () => {
  const s = closePhotoSpacing(camera, 10, 80, 70);
  assert.ok(Math.abs(s.wallRows - 10 * 4.7 / 4.88 * 0.2) < 1e-10);
  assert.ok(Math.abs(s.wallPoints - 10 * 6.3 / 4.88 * 0.3) < 1e-10);
  const rows = coveringRows(0, 10, s.wallRows);
  assert.equal(rows[0], 0); assert.equal(rows.at(-1), 10);
  assert.ok(rows.slice(1).every((z, i) => z - rows[i] <= s.wallRows + 1e-10));
});

test('sloping roof follows local height with stable vertical stand-off and retains every photo', async () => {
  const result = await planClosePhotography(defaults);
  const photos = result.points.filter(p => !p.isTransition);
  assert.equal(photos.length, result.targets.length);
  assert.equal(result.diagnostics.scheduled, photos.length);
  assert.equal(result.diagnostics.uncovered, 0);
  assert.ok(Math.max(...photos.map(p => p.cartesian.z)) - Math.min(...photos.map(p => p.cartesian.z)) > 2.5);
  for (const photo of photos) {
    const p = photo.cartesian, t = photo.targetCartesian;
    assert.ok(Math.abs(Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) - 3) < 1e-8);
    assert.ok(Math.abs(p.x - t.x) < 1e-8 && Math.abs(p.y - t.y) < 1e-8);
    assert.ok(Math.abs(p.z - t.z - 3) < 1e-8);
    assert.ok(Math.abs(photo.normal.x / photo.normal.z + 0.2) < 1e-8);
    assert.ok(Math.abs(photo.normal.y / photo.normal.z + 0.1) < 1e-8);
  }
});

test('missed roof rays create neither fake targets nor fake photo points', async () => {
  const result = await planClosePhotography({ ...defaults, raycast: async origin => origin.x < 5 ? null : { x: origin.x, y: origin.y, z: 4 } });
  assert.ok(result.diagnostics.missing > 0);
  assert.equal(result.points.length + result.diagnostics.missing, result.diagnostics.requested);
  assert.ok(result.points.every(p => p.targetCartesian.x >= 5));
});

test('recessed facade samples are retained rather than deleted by a near-depth percentile', async () => {
  const result = await planClosePhotography({ ...defaults, faces: ['front'], range: 2,
    raycast: async origin => ({ x: origin.x, y: origin.x < 5 ? 10 : 3, z: origin.z }) });
  assert.ok(result.targets.some(t => t.position.y === 3));
  assert.ok(result.targets.some(t => t.position.y === 10));
  assert.equal(result.points.length, result.targets.length);
});

test('local oblique alternatives repair occluded photo positions and report remaining targets', async () => {
  const result = await planClosePhotography({ ...defaults, raycast: async origin => ({ x: origin.x, y: origin.y, z: 4 }),
    isVisible: async (position, target) => target.x > 8 ? false : Math.abs(position.x - target.x) > 0.1 });
  assert.ok(result.diagnostics.repaired > 0);
  assert.ok(result.diagnostics.uncovered > 0);
  assert.equal(result.points.length, result.diagnostics.scheduled);
  assert.equal(result.targets.filter(t => !t.scheduled).length, result.diagnostics.uncovered);
});

test('oversized requests fail before ray casting and never silently thin photos', async () => {
  let calls = 0;
  await assert.rejects(planClosePhotography({ ...defaults, lateralOverlap: 95, longitudinalOverlap: 95, maxSamples: 100,
    raycast: () => { calls++; return null; } }), /不会自动放大间距/);
  assert.equal(calls, 0);
});

test('unsafe gaps receive tested non-photo connectors, including isolated photo samples', async () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  const result = await connectCloseSegments([[a], [b, c]], {
    isClear: async (from, to) => !(from === a && to === b),
    connect: async () => [{ id: 'detour' }]
  });
  assert.deepEqual(result.points.filter(p => !p.isTransition), [a, b, c]);
  assert.equal(result.points[1].skipAction, true);
  assert.equal(result.connectorPointCount, 1);
  const renderedEdges = closeRouteLegs(result.points).flatMap(leg => leg.points.slice(1).map((p, i) => [leg.points[i].id, p.id]));
  assert.deepEqual(renderedEdges, [['a', 'detour'], ['detour', 'b'], ['b', 'c']]);
});

test('unconnectable or invalid connectors fail instead of silently dropping a surface', async () => {
  await assert.rejects(connectCloseSegments([[{}], [{}]], { isClear: async () => false, connect: async () => null }), /无法安全连接/);
  await assert.rejects(connectCloseSegments([[{}], [{}]], { isClear: async () => false, connect: async () => [{}] }), /模型碰撞/);
});

test('cancellation stops asynchronous planning before it can publish a route', async () => {
  let cancelled = false;
  await assert.rejects(planClosePhotography({ ...defaults,
    yieldControl: async () => { cancelled = true; }, checkCancelled: () => { if (cancelled) throw new Error('cancelled'); } }), /cancelled/);
});

test('unreliable discontinuous neighbor normals fall back to the scanning direction', () => {
  const fallback = { x: 0, y: 1, z: 0 };
  assert.equal(estimateSurfaceNormal({ x: 0, y: 0, z: 0 }, null, null, fallback), fallback);
});
