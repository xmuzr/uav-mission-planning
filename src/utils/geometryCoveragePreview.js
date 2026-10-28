import { cameraFrame, pointEffectivelyCovered, DEFAULT_COVERAGE_QUALITY, referencePhotoGsd, previewLayerBand, createPreviewTimeline, previewPoseAt } from './coveragePreviewMath.js';
import { isGeometryOccluded } from './geometryCoverageSurface.js';
import { geometryCameraFaces, cameraSurfaceFootprint, footprintConnectors } from './geometryCameraFootprint.js';

// Playback is entirely local: no aircraft connection and no real capture telemetry.
export function createGeometryCoveragePreview({ Cesium: C, viewer, route, targets, camera, maxDistance, onState, cameraLabel, geometry, qualityPolicy }) {
  const timeline = createPreviewTimeline(route);
  const surfaceFaces = geometryCameraFaces(geometry);
  const counts = new Uint32Array(targets.length);
  const entities = [];
  let disposed = false, phase = 'ready', elapsed = 0, cursor = 0, multiplier = 20;
  let frameId = null, lastTime = 0, lastEmit = 0, lastRender = -Infinity, lastTrail = -Infinity;
  let covered = 0, repeated = 0, showFrustum = true, showCoverage = true;
  let currentVisible = 0, hasFootprint = false;
  let currentPolicy = null, layerBand = null;
  const layers = geometry ? [...new Set(route.filter(p => ['orbit', 'cylinder-orbit'].includes(p.surfaceKey)).map(p => {
    const v = C.Cartesian3.subtract(p.position, geometry.center, new C.Cartesian3());
    return Math.round(C.Cartesian3.dot(v, geometry.zAxis) * 1000) / 1000;
  }))].sort((a, b) => a - b) : [];
  const policyFor = point => qualityPolicy ? {
    ...DEFAULT_COVERAGE_QUALITY, ...qualityPolicy,
    referenceDistance: point.surfaceKey?.includes('top') ? qualityPolicy.topDistance : qualityPolicy.sideDistance
  } : null;
  const cartesian = p => new C.Cartesian3(p.x, p.y, p.z);
  const routePositions = route.map(p => cartesian(p.position));
  const red = C.Color.fromCssColorString('#ff6262'), green = C.Color.fromCssColorString('#42ef98'), yellow = C.Color.fromCssColorString('#facc15');
  const markerStates = new Uint8Array(targets.length);
  const collection = viewer.scene.primitives.add(new C.PointPrimitiveCollection());
  const markers = targets.map(target => collection.add({
    position: target.normal ? C.Cartesian3.add(cartesian(target.position), C.Cartesian3.multiplyByScalar(cartesian(target.normal), 0.12, new C.Cartesian3()), new C.Cartesian3()) : cartesian(target.position),
    pixelSize: 7, color: red, outlineColor: C.Color.BLACK.withAlpha(0.3), outlineWidth: 1
  }));
  const addEntity = options => { const entity = viewer.entities.add(options); entities.push(entity); return entity; };
  const droneSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52"><g fill="#facc15" stroke="#111827" stroke-width="2"><path d="M13 13L39 39M39 13L13 39" stroke="#facc15" stroke-width="6"/><circle cx="12" cy="12" r="8"/><circle cx="40" cy="12" r="8"/><circle cx="12" cy="40" r="8"/><circle cx="40" cy="40" r="8"/><rect x="20" y="16" width="12" height="20" rx="4"/></g></svg>';
  const drone = addEntity({
    position: cartesian(route[0].position),
    billboard: { image: `data:image/svg+xml,${encodeURIComponent(droneSvg)}`, width: 36, height: 36, disableDepthTestDistance: 0 },
    label: { text: '模拟无人机', font: '13px sans-serif', fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -30), disableDepthTestDistance: 0 }
  });
  let trailPositions = [routePositions[0]];
  const trail = addEntity({ polyline: { positions: new C.CallbackProperty(() => trailPositions, false), width: 4, material: C.Color.fromCssColorString('#facc15'), arcType: C.ArcType.NONE } });
  // Dynamic wireframe avoids rebuilding four static polyline primitives and
  // triangulating a moving translucent polygon on every animation frame.
  const rayPositions = Array.from({ length: 4 }, () => []);
  const rays = rayPositions.map(positions => addEntity({ polyline: { positions: new C.CallbackProperty(() => positions, false), width: 1.5, material: C.Color.fromCssColorString('#fbbf24').withAlpha(0.85), arcType: C.ArcType.NONE } }));
  const patchLines = [], patchPositions = [], patchSurfaces = [];
  let dronePosition = routePositions[0], lastEye = null;
  const updateOcclusion = () => {
    if (disposed) return;
    const eye = viewer.camera.positionWC;
    const visible = !isGeometryOccluded(eye, dronePosition, geometry);
    drone.show = visible;
    rays.forEach(ray => { ray.show = showFrustum && visible && hasFootprint; });
    patchLines.forEach((line, i) => {
      line.show = showFrustum && visible && patchPositions[i].length > 0 && !isGeometryOccluded(eye, patchSurfaces[i], geometry);
    });
    // Surface visibility changes only with the observer position, so orbiting
    // while paused works without recomputing the simulated camera coverage.
    if (!lastEye || !C.Cartesian3.equalsEpsilon(eye, lastEye, 0, 1e-5)) {
      markers.forEach((marker, i) => { marker.show = !isGeometryOccluded(eye, targets[i].position, geometry); });
      lastEye = C.Cartesian3.clone(eye, lastEye || new C.Cartesian3());
    }
  };
  const removeOcclusionListener = viewer.scene.preRender.addEventListener(updateOcclusion);
  const frameFor = pose => {
    const position = cartesian(pose.position);
    const transform = C.Transforms.eastNorthUpToFixedFrame(position);
    const axis = index => C.Matrix4.getColumn(transform, index, new C.Cartesian3());
    return cameraFrame(position, pose.heading, pose.pitch, { east: axis(0), north: axis(1), up: axis(2) });
  };
  const state = () => ({
    phase, multiplier, photoCount: cursor, totalPhotos: timeline.captures.length, currentVisible, layerBand,
    quality: currentPolicy ? { ...currentPolicy, referenceGsdCm: referencePhotoGsd(camera, currentPolicy.referenceDistance) * 100, maxGsdCm: referencePhotoGsd(camera, currentPolicy.referenceDistance) * currentPolicy.maxGsdRatio * 100 } : null,
    covered, repeated, targetCount: targets.length, unseen: targets.length - covered,
    coveragePercent: targets.length ? Math.round(covered / targets.length * 1000) / 10 : 0,
    flightPercent: timeline.duration ? Math.round(elapsed / timeline.duration * 1000) / 10 : (phase === 'finished' ? 100 : 0),
    elapsed, duration: timeline.duration, showFrustum, showCoverage, cameraLabel
  });
  const emit = () => { if (!disposed) onState(state()); };
  const render = (now = performance.now(), force = false) => {
    if (disposed) return;
    if (!force && now - lastRender < 1000 / 30) return;
    lastRender = now;
    const pose = previewPoseAt(timeline, elapsed), position = cartesian(pose.position);
    dronePosition = position;
    drone.position = position;
    if (force || now - lastTrail >= 100) {
      trailPositions = [...routePositions.slice(0, pose.index + 1), position];
      lastTrail = now;
    }
    const frame = frameFor(pose);
    currentPolicy = policyFor(route[pose.index]);
    layerBand = currentPolicy ? previewLayerBand(geometry, position, pose.pitch, camera, currentPolicy.referenceDistance, layers) : null;
    currentVisible = 0;
    targets.forEach((target, i) => {
      const active = pointEffectivelyCovered(frame, target, camera, maxDistance, currentPolicy);
      if (active) currentVisible++;
      const nextState = active ? 2 : counts[i] > 0 ? 1 : 0;
      if (nextState !== markerStates[i]) {
        markers[i].color = active ? yellow : counts[i] > 0 ? green : red;
        markers[i].pixelSize = active ? 9 : 7;
        markerStates[i] = nextState;
      }
    });
    if (showFrustum) {
      const patches = cameraSurfaceFootprint(surfaceFaces, frame, camera, maxDistance);
      const corners = footprintConnectors(patches, frame, camera);
      hasFootprint = corners.length === 4;
      rayPositions.forEach((positions, i) => { positions.length = 0; if (hasFootprint) positions.push(position, cartesian(corners[i])); });
      patches.forEach((patch, i) => {
        if (!patchLines[i]) {
          patchPositions[i] = [];
          patchLines[i] = addEntity({ polyline: { positions: new C.CallbackProperty(() => patchPositions[i], false), width: 2, material: yellow, arcType: C.ArcType.NONE } });
        }
        // A small outward bias avoids z-fighting without changing the coverage test.
        const points = patch.vertices.map(p => C.Cartesian3.add(cartesian(p), C.Cartesian3.multiplyByScalar(cartesian(patch.normal), 0.08, new C.Cartesian3()), new C.Cartesian3()));
        patchSurfaces[i] = patch.vertices.reduce((center, p) => ({ x: center.x + p.x / patch.vertices.length, y: center.y + p.y / patch.vertices.length, z: center.z + p.z / patch.vertices.length }), { x: 0, y: 0, z: 0 });
        patchPositions[i] = [...points, points[0]];
      });
      for (let i = patches.length; i < patchLines.length; i++) patchPositions[i] = [];
    }
    updateOcclusion();
    collection.show = showCoverage;
    viewer.scene.requestRender();
  };
  const expose = capture => {
    const point = route[capture.index];
    const frame = frameFor({ position: point.position, heading: Number(point.directionAngle) || 0, pitch: Number(point.gimbalPitch) || 0 });
    const policy = policyFor(point);
    targets.forEach((target, i) => {
      if (counts[i] >= 2 || !pointEffectivelyCovered(frame, target, camera, maxDistance, policy)) return;
      // Both proxy shapes are convex. An outward-facing surface visible from
      // this camera cannot be hidden by another part of the same proxy.
      if (counts[i]++ === 0) covered++;
      else repeated++;
    });
  };
  const tick = now => {
    if (disposed || phase !== 'playing') return;
    const next = Math.min(timeline.duration, elapsed + Math.min((now - lastTime) / 1000, 0.25) * multiplier);
    lastTime = now;
    const budgetStart = performance.now();
    while (cursor < timeline.captures.length && timeline.captures[cursor].time <= next) {
      expose(timeline.captures[cursor++]);
      if (performance.now() - budgetStart >= 4) break;
    }
    // Never skip exposures when playback is faster than the visibility evaluator.
    elapsed = cursor < timeline.captures.length && timeline.captures[cursor].time <= next ? timeline.captures[cursor - 1].time : next;
    if (elapsed >= timeline.duration && cursor === timeline.captures.length) phase = 'finished';
    render(now, phase === 'finished');
    if (now - lastEmit > 120 || phase === 'finished') { emit(); lastEmit = now; }
    if (phase === 'playing') frameId = requestAnimationFrame(tick);
  };
  const pause = () => { if (phase === 'playing') { phase = 'paused'; cancelAnimationFrame(frameId); render(performance.now(), true); emit(); } };
  const reset = () => {
    cancelAnimationFrame(frameId); elapsed = 0; cursor = 0; covered = 0; repeated = 0; phase = 'ready'; counts.fill(0);
    markerStates.fill(255); render(performance.now(), true); emit();
  };
  render(); emit();
  return {
    play() { if (disposed || phase === 'playing') return; if (phase === 'finished') reset(); phase = 'playing'; lastTime = performance.now(); emit(); frameId = requestAnimationFrame(tick); },
    pause, reset,
    setSpeed(value) { const speed = Number(value); if ([1, 5, 20, 50, 100].includes(speed)) { multiplier = speed; emit(); } },
    toggleFrustum() { showFrustum = !showFrustum; render(performance.now(), true); emit(); },
    toggleCoverage() { showCoverage = !showCoverage; render(performance.now(), true); emit(); },
    dispose() {
      if (disposed) return; disposed = true; cancelAnimationFrame(frameId);
      removeOcclusionListener();
      if (!viewer.isDestroyed()) {
        entities.forEach(entity => viewer.entities.remove(entity));
        viewer.scene.primitives.remove(collection);
        viewer.scene.requestRender();
      }
    }
  };
}
