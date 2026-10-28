const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = a => Math.sqrt(dot(a, a));
const unit = a => scale(a, 1 / Math.max(length(a), 1e-12));
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const finitePosition = p => p && [p.x, p.y, p.z].every(Number.isFinite);

export function cameraFrame(position, heading, pitch, axes) {
  const h = heading * Math.PI / 180, p = pitch * Math.PI / 180;
  const horizontal = add(scale(axes.east, Math.sin(h)), scale(axes.north, Math.cos(h)));
  const forward = unit(add(scale(horizontal, Math.cos(p)), scale(axes.up, Math.sin(p))));
  // This remains defined when the camera points vertically down.
  const right = unit(add(scale(axes.east, Math.cos(h)), scale(axes.north, -Math.sin(h))));
  return { position, forward, right, up: unit(cross(right, forward)) };
}

export function pointInCamera(frame, target, camera, maxDistance) {
  const x = target.position.x - frame.position.x;
  const y = target.position.y - frame.position.y;
  const z = target.position.z - frame.position.z;
  const project = axis => x * axis.x + y * axis.y + z * axis.z;
  const depth = project(frame.forward);
  if (depth <= 0.05 || depth > maxDistance) return false;
  const tanH = camera.sensorWidth / (2 * camera.focalLength);
  const tanV = camera.sensorHeight / (2 * camera.focalLength);
  if (Math.abs(project(frame.right)) > depth * tanH || Math.abs(project(frame.up)) > depth * tanV) return false;
  // Exact outward normals of the convex proxy reject its back faces.
  return !target.normal || -project(target.normal) > 1e-8;
}

export const DEFAULT_COVERAGE_QUALITY = Object.freeze({ maxIncidenceDegrees: 45, maxGsdRatio: 1.5 });

export function referencePhotoGsd(camera, distance) {
  return distance * Math.max(camera.sensorWidth / (camera.focalLength * camera.imageWidth), camera.sensorHeight / (camera.focalLength * camera.imageHeight));
}

// Largest surface pixel footprint from the pinhole camera Jacobian. This
// estimates sampling resolution only; blur/exposure/focus need actual images.
export function photoPointQuality(frame, target, camera) {
  const v = sub(target.position, frame.position), range = length(v), depth = dot(v, frame.forward);
  if (!target.normal || range < 1e-8 || depth <= 0) return null;
  const nv = dot(target.normal, v), cosine = -nv / range;
  if (cosine <= 0) return null;
  const horizontal = scale(sub(frame.right, scale(v, dot(target.normal, frame.right) / nv)), depth * camera.sensorWidth / (camera.focalLength * camera.imageWidth));
  const vertical = scale(sub(frame.up, scale(v, dot(target.normal, frame.up) / nv)), depth * camera.sensorHeight / (camera.focalLength * camera.imageHeight));
  const a = dot(horizontal, horizontal), b = dot(vertical, vertical), c = dot(horizontal, vertical);
  return { cosine, gsd: Math.sqrt((a + b + Math.sqrt((a - b) ** 2 + 4 * c * c)) / 2) };
}

export function pointEffectivelyCovered(frame, target, camera, maxDistance, policy) {
  if (!pointInCamera(frame, target, camera, maxDistance)) return false;
  if (!policy) return true;
  const v = sub(target.position, frame.position), distance = length(v);
  // Cheap angle rejection precedes the pixel footprint calculation.
  if (!target.normal || -dot(target.normal, v) < distance * Math.cos(policy.maxIncidenceDegrees * Math.PI / 180)) return false;
  const quality = photoPointQuality(frame, target, camera);
  return !!quality && quality.gsd <= referencePhotoGsd(camera, policy.referenceDistance) * policy.maxGsdRatio + 1e-10;
}

export function previewLayerBand(shape, position, pitch, camera, distance, layers) {
  if (!shape || Math.abs(pitch) > 5 || !layers.length) return null;
  const height = dot(sub(position, shape.center), shape.zAxis);
  const span = distance * camera.sensorHeight / camera.focalLength;
  const min = Math.max(shape.minZ, height - span / 2), max = Math.min(shape.maxZ, height + span / 2);
  const included = layers.flatMap((z, index) => z >= min - 1e-4 && z <= max + 1e-4 ? [index + 1] : []);
  const nearest = layers.reduce((best, z, i) => Math.abs(z - height) < Math.abs(layers[best] - height) ? i : best, 0);
  return { currentLayer: nearest + 1, totalLayers: layers.length, firstLayer: included[0], lastLayer: included.at(-1), layerCount: included.length,
    span, halfSpan: span / 2, minHeight: min - shape.minZ, maxHeight: max - shape.minZ };
}

export function createPreviewTimeline(route) {
  if (!route.length || route.some(p => !finitePosition(p.position))) throw new Error('模拟航点坐标无效。');
  const times = [0], distances = [0];
  for (let i = 1; i < route.length; i++) {
    const distance = length(sub(route[i].position, route[i - 1].position));
    const speed = Number(route[i - 1].speed);
    if (!(speed > 0)) throw new Error('模拟飞行速度必须大于零。');
    distances.push(distances[i - 1] + distance);
    times.push(times[i - 1] + distance / speed);
  }
  const captures = route.flatMap((point, index) => point.isTransition || point.skipAction || point.shootPhoto === false ? [] : [{ index, time: times[index] }]);
  return { route, times, distances, captures, duration: times.at(-1), distance: distances.at(-1) };
}

export function previewPoseAt(timeline, elapsed) {
  const time = Math.max(0, Math.min(timeline.duration, Number(elapsed) || 0));
  let low = 0, high = timeline.times.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (timeline.times[mid] <= time) low = mid;
    else high = mid - 1;
  }
  const index = low, nextIndex = Math.min(index + 1, timeline.route.length - 1);
  const a = timeline.route[index], b = timeline.route[nextIndex];
  const duration = timeline.times[nextIndex] - timeline.times[index];
  const fraction = duration > 0 ? (time - timeline.times[index]) / duration : 0;
  const heading = Number(a.directionAngle) || 0;
  const headingDelta = (((Number(b.directionAngle) || 0) - heading + 540) % 360) - 180;
  return {
    position: add(a.position, scale(sub(b.position, a.position), fraction)),
    heading: heading + headingDelta * fraction,
    pitch: (Number(a.gimbalPitch) || 0) + ((Number(b.gimbalPitch) || 0) - (Number(a.gimbalPitch) || 0)) * fraction,
    distance: timeline.distances[index] + (timeline.distances[nextIndex] - timeline.distances[index]) * fraction,
    index, time
  };
}

export function recordPreviewExposure(counts, visibleIndices) {
  for (const index of new Set(visibleIndices)) {
    if (Number.isInteger(index) && index >= 0 && index < counts.length) counts[index] += 1;
  }
  let covered = 0, repeated = 0;
  for (const count of counts) { if (count > 0) covered++; if (count > 1) repeated++; }
  return { covered, repeated, unseen: counts.length - covered };
}
