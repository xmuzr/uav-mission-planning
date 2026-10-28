import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { generateKMZ } from '../src/utils/kmzGenerator.js';
import { gcj02ToWgs84 } from '../src/utils/coordTransform.js';

const config = { routeType: 'close', closeRoute: { workflowStage: 'fine' }, globalAction: 'takePhoto', executeHeightMode: 'relativeToStartPoint',
  globalTransitionalSpeed: 1.5, flyToWaylineMode: 'safely', finishAction: 'goHome', exitOnRCLost: 'executeLostAction', executeRCLostAction: 'goBack',
  takeOffSecurityHeight: 20, droneEnumValue: 67, payloadEnumValue: 53 };
const point = { lng: 104.39, lat: 31.09, height: 512, speed: 1.5, directionAngle: 90, gimbalPitch: -32 };
async function xml(mission, points) {
  const blob = await generateKMZ(mission, points);
  const archive = await JSZip.loadAsync(await blob.arrayBuffer());
  return { waylines: await archive.file('wpmz/waylines.wpml').async('string'), template: await archive.file('wpmz/template.kml').async('string') };
}

test('close KMZ preserves WGS84 model coordinates and ellipsoid heights', async () => {
  const output = await xml(config, [point]);
  assert.ok(output.waylines.includes('<coordinates>104.39,31.09</coordinates>'));
  assert.ok(output.waylines.includes('<wpml:executeHeight>512</wpml:executeHeight>'));
  assert.ok(output.waylines.includes('<wpml:executeHeightMode>WGS84</wpml:executeHeightMode>'));
  assert.ok(output.template.includes('<wpml:heightMode>relativeToStartPoint</wpml:heightMode>'));
  assert.ok(output.template.includes('<wpml:ellipsoidHeight>512</wpml:ellipsoidHeight>'));
  assert.ok(output.template.includes('<wpml:takeOffRefPoint>31.09,104.39,512</wpml:takeOffRefPoint>'));
  assert.ok(!output.waylines.includes('<wpml:takeOffPoint>'));
});

test('every close photo point stops, aims the gimbal, then photographs; transitions do not shoot', async () => {
  const output = await xml(config, [point, { ...point, lng: point.lng + 0.00001, isTransition: true, skipAction: true }, { ...point, height: 514, gimbalPitch: -55 }]);
  const placemarks = output.waylines.match(/<Placemark>[\s\S]*?<\/Placemark>/g);
  assert.equal(placemarks.length, 3);
  assert.equal((output.template.match(/<Placemark>/g) || []).length, 3);
  assert.ok(!output.template.includes('<wpml:executeHeightMode>'));
  assert.ok(output.template.includes('<wpml:height>2</wpml:height>'));
  assert.equal((output.waylines.match(/<wpml:actionActuatorFunc>takePhoto/g) || []).length, 2);
  assert.ok(!placemarks[1].includes('<wpml:actionGroup>'));
  for (const p of [placemarks[0], placemarks[2]]) {
    assert.ok(p.indexOf('>gimbalRotate<') < p.indexOf('>takePhoto<'));
    assert.ok(p.includes('toPointAndStopWithDiscontinuityCurvature'));
  }
  assert.ok(placemarks[2].includes('<wpml:gimbalPitchRotateAngle>-55</wpml:gimbalPitchRotateAngle>'));
});

test('close photo actions are retained even for older entries with no global action', async () => {
  const output = await xml({ ...config, globalAction: 'none' }, [point]);
  assert.ok(output.waylines.includes('>takePhoto<'));
});

test('ordinary waypoint export retains its existing coordinate conversion', async () => {
  const output = await xml({ ...config, routeType: 'waypoint' }, [point]);
  const expected = gcj02ToWgs84(point.lng, point.lat);
  assert.ok(output.waylines.includes(`<coordinates>${expected.lng},${expected.lat}</coordinates>`));
  assert.ok(output.waylines.includes('<wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>'));
});
