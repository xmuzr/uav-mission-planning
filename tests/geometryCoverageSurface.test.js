import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeometryOccluded, sampleGeometryCoverageSurface } from '../src/utils/geometryCoverageSurface.js';

const box = (tilt = 0) => ({
  center: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: Math.sqrt(1 - tilt * tilt), z: tilt },
  zAxis: { x: 0, y: 0, z: 1 },
  minX: -20, maxX: 20, minY: -10, maxY: 10, minZ: -20, maxZ: 20
});
const at = (shape, x, y, z) => ({
  x: shape.center.x + x * shape.xAxis.x + y * shape.yAxis.x + z * shape.zAxis.x,
  y: shape.center.y + x * shape.xAxis.y + y * shape.yAxis.y + z * shape.zAxis.y,
  z: shape.center.z + x * shape.xAxis.z + y * shape.yAxis.z + z * shape.zAxis.z
});
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

for (const tilt of [0, -0.1, -0.05, 0.05, 0.1]) {
  test(`front wall remains complete and back wall stays hidden (tilt ${tilt})`, () => {
    const shape = box(tilt);
    const eye = at(shape, 0, 100, 10);
    const samples = sampleGeometryCoverageSurface(shape);
    const front = samples.filter(p => dot(p.normal, shape.yAxis) > 0.99);
    const back = samples.filter(p => dot(p.normal, shape.yAxis) < -0.99);
    assert.equal(front.length, 196);
    assert.equal(front.filter(p => isGeometryOccluded(eye, p.position, shape)).length, 0);
    assert.equal(back.filter(p => isGeometryOccluded(eye, p.position, shape)).length, back.length);
  });
}

test('rotated and translated skew geometry has complete visible samples on all four walls', () => {
  const shape = box(0.1);
  const rotate = p => ({ x: (p.x - p.y) / Math.sqrt(2), y: p.z, z: (p.x + p.y) / Math.sqrt(2) });
  shape.xAxis = rotate(shape.xAxis);
  shape.yAxis = rotate(shape.yAxis);
  shape.zAxis = rotate(shape.zAxis);
  shape.center = { x: -2200000, y: 4300000, z: 4100000 };
  const samples = sampleGeometryCoverageSurface(shape);
  for (const [axis, sign, eye] of [
    [shape.yAxis, 1, at(shape, 0, 100, 10)],
    [shape.yAxis, -1, at(shape, 0, -100, 10)],
    [shape.xAxis, 1, at(shape, 100, 0, 10)],
    [shape.xAxis, -1, at(shape, -100, 0, 10)]
  ]) {
    const wall = samples.filter(p => sign * dot(p.normal, axis) > 0.99);
    assert.ok(wall.length > 0);
    assert.ok(wall.every(p => !isGeometryOccluded(eye, p.position, shape)));
  }
});

test('silhouette contacts stay visible, through-body segments stay hidden', () => {
  const shape = box(0.05);
  const eye = at(shape, 0, 100, 0);
  assert.equal(isGeometryOccluded(eye, at(shape, shape.maxX, shape.maxY, shape.minZ), shape), false);
  assert.equal(isGeometryOccluded(eye, at(shape, 0, shape.minY, 0), shape), true);
  assert.equal(isGeometryOccluded(eye, at(shape, 0, 110, 0), shape), false);
});

test('cylinder visible half and roof remain visible, back stays hidden', () => {
  const shape = { ...box(), radius: 10, minX: -10, maxX: 10 };
  const eye = { x: 0, y: 100, z: 0 };
  const samples = sampleGeometryCoverageSurface(shape);
  const facing = samples.filter(p => p.normal.y > 0.5);
  const back = samples.filter(p => p.normal.y < -0.5);
  assert.ok(facing.length > 0 && back.length > 0);
  assert.ok(facing.every(p => !isGeometryOccluded(eye, p.position, shape)));
  assert.ok(back.every(p => isGeometryOccluded(eye, p.position, shape)));
  const roof = samples.filter(p => p.normal === shape.zAxis);
  assert.ok(roof.every(p => !isGeometryOccluded({ x: 0, y: 0, z: 100 }, p.position, shape)));
});
