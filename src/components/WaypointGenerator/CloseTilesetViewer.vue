<template>
  <div class="close-tileset-viewer">
    <vc-viewer
      class="close-cesium"
      :camera="camera"
      :animation="false"
      :timeline="false"
      :base-layer-picker="false"
      :geocoder="false"
      :home-button="false"
      :scene-mode-picker="false"
      :navigation-help-button="false"
      :fullscreen-button="false"
      @ready="onViewerReady"
    >
      <vc-navigation></vc-navigation>
    </vc-viewer>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { CAMERA_PRESETS, calculateSpacing } from '../../utils/polygonRouteGenerator';

const DEFAULT_TILESET_URL = '/models/ruansan/tileset.json';

const props = defineProps({
  missionConfig: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['update-route', 'state-change']);

const camera = ref({
  position: {
    lng: 104.3903,
    lat: 31.0909,
    height: 900
  },
  heading: 0,
  pitch: -45,
  roll: 0
});

const routeSummary = reactive({
  targetPointCount: 0,
  waypointCount: 0
});

const modelReady = ref(false);
const hasArea = ref(false);
const drawing = ref(false);
const statusText = ref('正在加载 ruansan 三维模型...');

const routeConfig = computed(() => ({
  closeDistance: 10,
  layerCount: 1,
  layerSpacing: 5,
  lateralOverlap: 80,
  longitudinalOverlap: 80,
  modelUrl: DEFAULT_TILESET_URL,
  ...(props.missionConfig.closeRoute || {})
}));

const modelUrl = computed(() => routeConfig.value.modelUrl || DEFAULT_TILESET_URL);

let CesiumApi = null;
let viewerInstance = null;
let tileset = null;
let clickHandler = null;
let loadingToken = 0;
let targetLineEntity = null;
let routeEntity = null;
let pointEntities = [];
let targetCartesians = [];
let targetWaypoints = [];
let generatedWaypoints = [];

const emitState = () => {
  emit('state-change', {
    modelReady: modelReady.value,
    hasArea: hasArea.value,
    statusText: statusText.value,
    routeSummary: {
      targetPointCount: routeSummary.targetPointCount,
      waypointCount: routeSummary.waypointCount
    }
  });
};

const setStatus = (message) => {
  statusText.value = message;
  emitState();
};

const clearEntity = (entity) => {
  if (viewerInstance && entity) {
    viewerInstance.entities.remove(entity);
  }
};

const emitEmptyRoute = () => {
  emit('update-route', {
    waypoints: [],
    boundaryPoints: [],
    boundaryGroups: [],
    routeCount: 0
  });
};

const clearRouteOnly = (emitEmpty = true) => {
  clearEntity(routeEntity);
  routeEntity = null;
  generatedWaypoints = [];
  routeSummary.waypointCount = 0;

  if (emitEmpty) {
    emitEmptyRoute();
  }
};

const clearVisuals = () => {
  clearEntity(targetLineEntity);
  clearEntity(routeEntity);
  pointEntities.forEach(clearEntity);
  targetLineEntity = null;
  routeEntity = null;
  pointEntities = [];
};

function clearPlanning(emitEmpty = false) {
  clearVisuals();
  targetCartesians = [];
  targetWaypoints = [];
  generatedWaypoints = [];
  drawing.value = false;
  hasArea.value = false;
  routeSummary.targetPointCount = 0;
  routeSummary.waypointCount = 0;

  if (emitEmpty) {
    emitEmptyRoute();
  }

  setStatus(modelReady.value ? 'ruansan 模型已就绪，可以绘制贴近摄影目标线。' : '正在加载 ruansan 三维模型...');
}

const waypointFromCartesian = (cartesian) => {
  const cartographic = CesiumApi.Cartographic.fromCartesian(cartesian);
  return {
    lng: CesiumApi.Math.toDegrees(cartographic.longitude),
    lat: CesiumApi.Math.toDegrees(cartographic.latitude),
    height: cartographic.height
  };
};

const cartesianFromWaypoint = (waypoint) =>
  CesiumApi.Cartesian3.fromDegrees(waypoint.lng, waypoint.lat, waypoint.height || 0);

const addImageryLayer = () => {
  viewerInstance.imageryLayers.removeAll();
  const amapProvider = new CesiumApi.UrlTemplateImageryProvider({
    url: 'https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    minimumLevel: 3,
    maximumLevel: 18
  });
  viewerInstance.imageryLayers.addImageryProvider(amapProvider);
};

const pickByRay = (ray) => {
  if (!viewerInstance || !CesiumApi || !ray) return null;

  const scene = viewerInstance.scene;
  let hit = null;

  if (typeof scene.pickFromRay === 'function') {
    try {
      hit = scene.pickFromRay(ray);
    } catch (error) {
      console.warn('pickFromRay failed, falling back to globe picking', error);
    }
  }

  const position = hit?.position || hit?.cartesian || hit?.object?.position || hit;
  if (CesiumApi.defined(position)) {
    return position;
  }

  const globePosition = scene.globe?.pick(ray, scene);
  return CesiumApi.defined(globePosition) ? globePosition : null;
};

const getPickCartesian = (windowPosition) => {
  if (!viewerInstance || !CesiumApi || !windowPosition) return null;

  const scene = viewerInstance.scene;
  const ray = viewerInstance.camera.getPickRay(windowPosition);
  if (!ray) return null;

  const scenePosition = pickByRay(ray);
  if (CesiumApi.defined(scenePosition)) {
    return scenePosition;
  }

  const ellipsoidPosition = viewerInstance.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
  return CesiumApi.defined(ellipsoidPosition) ? ellipsoidPosition : null;
};

const removeTileset = () => {
  if (viewerInstance && tileset) {
    viewerInstance.scene.primitives.remove(tileset);
  }
  tileset = null;
};

const loadTileset = async () => {
  if (!viewerInstance || !CesiumApi) return;

  const token = ++loadingToken;
  const url = modelUrl.value || DEFAULT_TILESET_URL;

  modelReady.value = false;
  clearPlanning(true);
  removeTileset();
  setStatus(`正在加载模型: ${url}`);

  try {
    const tilesetOptions = {
      maximumScreenSpaceError: 8,
      enableDebugWireframe: true
    };

    const loadedTileset = CesiumApi.Cesium3DTileset.fromUrl
      ? await CesiumApi.Cesium3DTileset.fromUrl(url, tilesetOptions)
      : new CesiumApi.Cesium3DTileset({ url, ...tilesetOptions });

    if (token !== loadingToken) return;

    tileset = viewerInstance.scene.primitives.add(loadedTileset);

    if (tileset.readyPromise) {
      await tileset.readyPromise;
    }

    if (token !== loadingToken) return;

    modelReady.value = true;
    viewerInstance.zoomTo(tileset);
    setStatus('ruansan 模型已加载，可以绘制贴近摄影目标线。');
  } catch (error) {
    console.error('Failed to load close route tileset', error);
    modelReady.value = false;
    setStatus(`模型加载失败: ${error?.message || error}`);
  }
};

const normalizeVector = (vector) => {
  if (!CesiumApi || !vector) return null;
  const length = CesiumApi.Cartesian3.magnitude(vector);
  if (length < 1e-8) return null;
  return CesiumApi.Cartesian3.divideByScalar(vector, length, new CesiumApi.Cartesian3());
};

const addVectors = (...vectors) =>
  vectors.reduce(
    (acc, vector) => CesiumApi.Cartesian3.add(acc, vector, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3(0, 0, 0)
  );

const getBearingDegrees = (start, end) => {
  if (!start || !end) return 0;

  const lat1 = start.lat * Math.PI / 180;
  const lat2 = end.lat * Math.PI / 180;
  const deltaLng = (end.lng - start.lng) * Math.PI / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const normalizeOverlapRate = (value, fallbackPercent = 80) => {
  let overlap = Number(value);
  if (!Number.isFinite(overlap)) {
    overlap = fallbackPercent;
  }
  if (overlap <= 1) {
    overlap *= 100;
  }
  return Math.min(Math.max(overlap, 0), 95) / 100;
};

const getCameraConfig = () => CAMERA_PRESETS[props.missionConfig.aircraftModel] || CAMERA_PRESETS.m30t;

const getFovSpacing = (distance, direction) => {
  const cameraConfig = getCameraConfig();
  const overlapKey = direction === 'longitudinal' ? 'longitudinalOverlap' : 'lateralOverlap';
  const overlapRate = normalizeOverlapRate(routeConfig.value[overlapKey], 80);
  const safeDistance = Math.max(Number(distance) || 0, 0.5);
  return Math.max(0.2, calculateSpacing(safeDistance, cameraConfig, overlapRate, direction));
};

const getOffsetNormal = (target, tangent) => {
  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(target, new CesiumApi.Cartesian3());
  const toCamera = CesiumApi.Cartesian3.subtract(
    viewerInstance.camera.positionWC,
    target,
    new CesiumApi.Cartesian3()
  );

  let normal = CesiumApi.Cartesian3.subtract(
    toCamera,
    CesiumApi.Cartesian3.multiplyByScalar(up, CesiumApi.Cartesian3.dot(toCamera, up), new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );
  normal = CesiumApi.Cartesian3.subtract(
    normal,
    CesiumApi.Cartesian3.multiplyByScalar(tangent, CesiumApi.Cartesian3.dot(normal, tangent), new CesiumApi.Cartesian3()),
    normal
  );

  if (CesiumApi.Cartesian3.magnitudeSquared(normal) < 1e-8) {
    normal = CesiumApi.Cartesian3.cross(tangent, up, new CesiumApi.Cartesian3());
  }

  return normalizeVector(normal) || up;
};

const getCloseOrientation = (droneCartesian, targetCartesian) => {
  const drone = waypointFromCartesian(droneCartesian);
  const target = waypointFromCartesian(targetCartesian);
  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(droneCartesian, new CesiumApi.Cartesian3());
  const toTarget = CesiumApi.Cartesian3.subtract(targetCartesian, droneCartesian, new CesiumApi.Cartesian3());
  const vertical = CesiumApi.Cartesian3.dot(toTarget, up);
  const horizontal = CesiumApi.Cartesian3.magnitude(
    CesiumApi.Cartesian3.subtract(
      toTarget,
      CesiumApi.Cartesian3.multiplyByScalar(up, vertical, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    )
  );
  const pitch = Math.atan2(vertical, Math.max(horizontal, 0.01)) * 180 / Math.PI;

  return {
    directionAngle: getBearingDegrees(drone, target),
    gimbalPitch: Math.max(-90, Math.min(30, pitch))
  };
};

const resampleTargetLine = (pointSpacing) => {
  const samples = [];
  const spacing = Math.max(0.2, Number(pointSpacing) || 0.2);

  for (let index = 0; index < targetCartesians.length - 1; index += 1) {
    const start = targetCartesians[index];
    const end = targetCartesians[index + 1];
    const segment = CesiumApi.Cartesian3.subtract(end, start, new CesiumApi.Cartesian3());
    const length = CesiumApi.Cartesian3.magnitude(segment);
    if (length < 0.01) continue;

    const tangent = CesiumApi.Cartesian3.normalize(segment, new CesiumApi.Cartesian3());
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = 0; step <= steps; step += 1) {
      if (index > 0 && step === 0) continue;
      const t = step / steps;
      samples.push({
        target: CesiumApi.Cartesian3.lerp(start, end, t, new CesiumApi.Cartesian3()),
        tangent
      });
    }
  }

  return samples;
};

const createCloseWaypoint = (targetCartesian, tangent, layerOffset, closeDistance, pointSpacing, index) => {
  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(targetCartesian, new CesiumApi.Cartesian3());
  const shiftedTarget = addVectors(
    targetCartesian,
    CesiumApi.Cartesian3.multiplyByScalar(up, layerOffset, new CesiumApi.Cartesian3())
  );
  const normal = getOffsetNormal(shiftedTarget, tangent);
  const droneCartesian = addVectors(
    shiftedTarget,
    CesiumApi.Cartesian3.multiplyByScalar(normal, closeDistance, new CesiumApi.Cartesian3())
  );
  const orientation = getCloseOrientation(droneCartesian, shiftedTarget);

  return {
    ...waypointFromCartesian(droneCartesian),
    index,
    speed: props.missionConfig.globalSpeed || props.missionConfig.globalTransitionalSpeed || 5,
    gimbalPitch: orientation.gimbalPitch,
    directionAngle: orientation.directionAngle,
    photoDistance: pointSpacing,
    lateralOverlap: Math.round(normalizeOverlapRate(routeConfig.value.lateralOverlap, 80) * 100),
    longitudinalOverlap: Math.round(normalizeOverlapRate(routeConfig.value.longitudinalOverlap, 80) * 100)
  };
};

const generateCloseRoute = () => {
  const closeDistance = Math.max(0.5, Number(routeConfig.value.closeDistance) || 10);
  const pointSpacing = getFovSpacing(closeDistance, 'longitudinal');
  const layerSpacing = Math.max(0, Number(routeConfig.value.layerSpacing) || 0);
  const layerCount = Math.max(1, Math.min(20, Math.round(Number(routeConfig.value.layerCount) || 1)));
  const samples = resampleTargetLine(pointSpacing);
  const route = [];

  for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
    const rowSamples = layerIndex % 2 === 0 ? samples : [...samples].reverse();
    rowSamples.forEach((sample) => {
      route.push(createCloseWaypoint(
        sample.target,
        sample.tangent,
        layerIndex * layerSpacing,
        closeDistance,
        pointSpacing,
        route.length
      ));
    });
  }

  return {
    route,
    pointSpacing,
    layerCount
  };
};

const drawTargetLine = () => {
  if (!viewerInstance || !CesiumApi) return;

  clearEntity(targetLineEntity);
  pointEntities.forEach(clearEntity);
  targetLineEntity = null;
  pointEntities = [];

  pointEntities = targetCartesians.map((position, index) =>
    viewerInstance.entities.add({
      position,
      point: {
        pixelSize: 9,
        color: CesiumApi.Color.fromCssColorString('#ffd447'),
        outlineColor: CesiumApi.Color.BLACK,
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: String(index + 1),
        font: '12px sans-serif',
        fillColor: CesiumApi.Color.WHITE,
        outlineColor: CesiumApi.Color.BLACK,
        outlineWidth: 2,
        pixelOffset: new CesiumApi.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    })
  );

  if (targetCartesians.length >= 2) {
    targetLineEntity = viewerInstance.entities.add({
      polyline: {
        positions: targetCartesians,
        width: 3,
        material: CesiumApi.Color.fromCssColorString('#ffd447'),
        arcType: CesiumApi.ArcType.NONE,
        clampToGround: false
      }
    });
  }
};

const drawRoute = () => {
  clearEntity(routeEntity);
  routeEntity = null;

  if (!viewerInstance || !CesiumApi || generatedWaypoints.length < 2) return;

  routeEntity = viewerInstance.entities.add({
    polyline: {
      positions: generatedWaypoints.map(cartesianFromWaypoint),
      width: 4,
      material: CesiumApi.Color.fromCssColorString('#55ff78'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });
};

const emitBoundaryState = () => {
  emit('update-route', {
    waypoints: [],
    boundaryPoints: targetWaypoints,
    boundaryGroups: [],
    routeCount: 0
  });
};

const onCanvasClick = (movement) => {
  if (!drawing.value || !modelReady.value) return;

  const cartesian = getPickCartesian(movement.position);
  if (!cartesian) {
    setStatus('没有拾取到模型表面，请靠近 ruansan 模型再点击。');
    return;
  }

  targetCartesians.push(cartesian);
  targetWaypoints.push(waypointFromCartesian(cartesian));
  hasArea.value = targetCartesians.length >= 2;
  routeSummary.targetPointCount = targetCartesians.length;
  clearRouteOnly(false);
  drawTargetLine();
  emitBoundaryState();
  setStatus(
    hasArea.value
      ? `已选择 ${targetCartesians.length} 个目标点，可以继续补点或生成贴近摄影航线。`
      : '已选择 1 个目标点，请继续选择至少 1 个点。'
  );
};

const setupClickHandler = () => {
  if (!viewerInstance || !CesiumApi) return;

  if (clickHandler) {
    clickHandler.destroy();
  }

  clickHandler = new CesiumApi.ScreenSpaceEventHandler(viewerInstance.scene.canvas);
  clickHandler.setInputAction(onCanvasClick, CesiumApi.ScreenSpaceEventType.LEFT_CLICK);
};

function fitCamera() {
  if (!viewerInstance) return;

  if (routeEntity || targetLineEntity || pointEntities.length > 0) {
    viewerInstance.zoomTo(routeEntity || targetLineEntity || pointEntities[0]);
  } else if (tileset) {
    viewerInstance.zoomTo(tileset);
  }
}

function beginDraw() {
  if (!modelReady.value) {
    setStatus('模型还没有加载完成。');
    return;
  }

  clearPlanning(true);
  drawing.value = true;
  setStatus('请在 ruansan 模型上按顺序点击贴近摄影目标线，至少选择 2 个点。');
}

function buildRoute(showStatus = true) {
  if (targetCartesians.length < 2) {
    setStatus('需要至少选择 2 个目标点才能生成贴近摄影航线。');
    return;
  }

  const result = generateCloseRoute();
  if (result.route.length < 2) {
    setStatus('当前目标线太短，无法生成有效贴近摄影航线。');
    return;
  }

  generatedWaypoints = result.route;
  drawing.value = false;
  routeSummary.targetPointCount = targetCartesians.length;
  routeSummary.waypointCount = result.route.length;
  drawTargetLine();
  drawRoute();

  emit('update-route', {
    waypoints: result.route,
    boundaryPoints: targetWaypoints,
    boundaryGroups: [],
    routeCount: result.layerCount
  });

  if (showStatus) {
    setStatus(`贴近摄影航线已生成。目标点 ${targetCartesians.length} 个，拍摄层数 ${result.layerCount} 层，航向间距 ${result.pointSpacing.toFixed(2)}m，航点 ${result.route.length} 个。`);
  } else {
    emitState();
  }
}

const onViewerReady = ({ Cesium, viewer }) => {
  CesiumApi = Cesium;
  viewerInstance = viewer;

  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.pickTranslucentDepth = true;
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

  addImageryLayer();
  setupClickHandler();
  emitState();
  loadTileset();
};

watch(modelUrl, (nextValue, prevValue) => {
  if (nextValue !== prevValue) {
    loadTileset();
  }
});

watch(
  () => [
    routeConfig.value.closeDistance,
    routeConfig.value.layerCount,
    routeConfig.value.layerSpacing,
    routeConfig.value.lateralOverlap,
    routeConfig.value.longitudinalOverlap
  ],
  () => {
    if (hasArea.value) {
      clearRouteOnly(true);
      drawTargetLine();
      setStatus('贴近摄影参数已更新，请重新点击生成航线。');
    } else {
      emitState();
    }
  },
  { deep: true }
);

onBeforeUnmount(() => {
  if (clickHandler) {
    clickHandler.destroy();
    clickHandler = null;
  }

  clearVisuals();
  removeTileset();
});

defineExpose({
  fitCamera,
  beginDraw,
  buildRoute,
  clearPlanning
});
</script>

<style scoped>
.close-tileset-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: #070b12;
}

.close-cesium {
  width: 100%;
  height: 100%;
}
</style>
