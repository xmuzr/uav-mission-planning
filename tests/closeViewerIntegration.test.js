import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import { computed, reactive, ref } from 'vue';
import { CAMERA_PRESETS, calculateSpacing } from '../src/utils/polygonRouteGenerator.js';
import { planClosePhotography, closeRouteLegs } from '../src/utils/closeRoutePlanning.js';

// Exercise the actual SFC controller without creating a WebGL context.
const source = fs.readFileSync(new URL('../src/components/WaypointGenerator/GeometryTilesetViewer.vue', import.meta.url), 'utf8')
  .split('<script setup>')[1].split('</script>')[0].replace(/^import .*?;\s*$/gm, '');
function controller(pick = async () => null) {
  const entities = [];
  const viewer = { entities: { add: value => { entities.push(value); return value; }, remove: () => true },
    scene: { requestRender() {}, pickFromRayMostDetailed: pick } };
  const events = [];
  const factory = new Function('deps', `
    const { computed, reactive, ref, CAMERA_PRESETS, calculateSpacing, planClosePhotography, closeRouteLegs,
      defineProps, defineEmits, defineExpose, watch, onBeforeUnmount } = deps;
    ${source}
    return { drawBoundary, drawRoute, emitState, clearPlanning, hasClearFlightSegment, hasPhotoPositionClearance,
      prepareBoundary() { boundaryCartesians = [
        deps.Cesium.Cartesian3.fromDegrees(118.04, 24.61, 100), deps.Cesium.Cartesian3.fromDegrees(118.0402, 24.61, 100),
        deps.Cesium.Cartesian3.fromDegrees(118.0402, 24.6102, 100), deps.Cesium.Cartesian3.fromDegrees(118.04, 24.6102, 100)
      ]; },
      prepare(route) { CesiumApi = deps.Cesium; viewerInstance = deps.viewer;
        generatedWaypoints = route; generatedRouteSegments = [route];
        closeSurfaceTargets = [{ position: route[0].cartesian, scheduled: true }];
        generatedSurfaceTargetCartesians = [route[0].cartesian];
        closeDiagnostics.value = { scheduled: 1 }; generating.value = true;
      }, snapshot() { return { diagnostics: closeDiagnostics.value, targets: closeSurfaceTargets.length,
        segments: generatedRouteSegments.length, revision: closePlanningRevision, generating: generating.value }; }
    };`);
  const instance = factory({ computed, reactive, ref, CAMERA_PRESETS, calculateSpacing, planClosePhotography, closeRouteLegs, Cesium, viewer,
    defineProps: () => ({ plannerMode: 'close', missionConfig: { aircraftModel: 'm30t', closeRoute: { closeDistance: 10 } } }),
    defineEmits: () => (...args) => events.push(args), defineExpose() {}, watch() {}, onBeforeUnmount() {} });
  return { instance, entities, events };
}
const photo = (lng, height = 100) => ({ lng, lat: 24.61, height, cartesian: Cesium.Cartesian3.fromDegrees(lng, 24.61, height) });

test('redrawing the selected boundary preserves planning diagnostics, targets, and continuous route', () => {
  const { instance, entities } = controller();
  const route = [photo(118.04), { ...photo(118.0401), isTransition: true }, photo(118.0402)];
  instance.prepare(route);
  const before = instance.snapshot();
  instance.drawBoundary();
  assert.deepEqual(instance.snapshot(), before);
  instance.drawRoute();
  assert.ok(entities.some(entity => entity.point?.color));
  const legs = entities.filter(entity => entity.polyline);
  assert.equal(legs.reduce((edges, leg) => edges + leg.polyline.positions.length - 1, 0), 2);
  assert.ok(legs[0].polyline.material instanceof Cesium.PolylineDashMaterialProperty);
});

test('asynchronous model collision checks are awaited and reject blocked flight segments', async () => {
  const { instance } = controller(async ray => ({ position: Cesium.Ray.getPoint(ray, 1) }));
  const route = [photo(118.04), photo(118.041)];
  instance.prepare(route);
  assert.equal(await instance.hasClearFlightSegment(route[0], route[1]), false);
});

test('clearing invalidates pending planning and removes route diagnostics', () => {
  const { instance, events } = controller();
  instance.prepare([photo(118.04), photo(118.041)]);
  instance.clearPlanning(true);
  const state = instance.snapshot();
  assert.equal(state.generating, false);
  assert.equal(state.diagnostics, null);
  assert.equal(state.targets, 0);
  assert.ok(state.revision > 0);
  assert.ok(events.some(([event, payload]) => event === 'update-route' && payload.waypoints.length === 0));
});

test('photo poses with clear immediate space but blocked exits are rejected before route connection', async () => {
  // Five meters clears the 1.8m body probes, but obstructs the longer exit leg.
  const { instance } = controller(async ray => ({ position: Cesium.Ray.getPoint(ray, 5) }));
  instance.prepare([photo(118.04), photo(118.041)]);
  instance.prepareBoundary();
  assert.equal(await instance.hasPhotoPositionClearance(Cesium.Cartesian3.fromDegrees(118.0401, 24.6101, 110)), false);
});
