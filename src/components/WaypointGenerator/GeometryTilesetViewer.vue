<template>
  <div class="geometry-tileset-viewer">
    <vc-viewer
      class="geometry-cesium"
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
    <div v-if="!isClosePlanner && previewState.phase !== 'idle'" class="coverage-overlay">
      <strong>{{ previewPhaseLabel }} · 模拟数据</strong>
      <div>飞行 {{ previewState.flightPercent || 0 }}% · 模拟拍照 {{ previewState.photoCount || 0 }} / {{ previewState.totalPhotos || 0 }}</div>
      <div>有效采样覆盖 {{ previewState.coveragePercent || 0 }}% · {{ previewState.covered || 0 }} / {{ previewState.targetCount || 0 }} 点</div>
      <div>当前可有效拍摄 {{ previewState.currentVisible || 0 }} 点</div>
      <div v-if="previewState.layerBand">第 {{ previewState.layerBand.currentLayer }} / {{ previewState.layerBand.totalLayers }} 层 · 本层正拍高差 ±{{ previewState.layerBand.halfSpan.toFixed(1) }}m</div>
      <div class="coverage-legend"><span class="unseen-dot">●</span> 未达标 <span class="seen-dot">●</span> 累计有效 <span class="frustum-dot">●</span> 当前有效</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { CAMERA_PRESETS, calculateSpacing } from '../../utils/polygonRouteGenerator';
import { createGeometryCoveragePreview } from '../../utils/geometryCoveragePreview';
import { sampleGeometryCoverageSurface } from '../../utils/geometryCoverageSurface';
import { planClosePhotography, closeRouteLegs } from '../../utils/closeRoutePlanning';

const DEFAULT_TILESET_URL = '/models/ruansan/tileset.json';
const BOX_POINT_COUNT = 8;
const CLOSE_BASE_POINT_COUNT = 4;
const CLOSE_SURFACE_MARKER_LIMIT = 800;
const CLOSE_ROUTE_SEGMENT_BLOCK_TOLERANCE = 0.05;
const CLOSE_ROUTE_SAFETY_RADIUS_MIN = 1.2;
const CLOSE_ROUTE_SAFETY_RADIUS_MAX = 3;
const CLOSE_ROUTE_CONNECTOR_MIN_CLEARANCE = 25;
const CYLINDER_POINT_COUNT = 3;

const props = defineProps({
  missionConfig: {
    type: Object,
    required: true
  },
  plannerMode: {
    type: String,
    default: 'geometry'
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
  surfaceCount: 0,
  scanLineCount: 0,
  waypointCount: 0
});

const modelReady = ref(false);
const hasArea = ref(false);
const drawing = ref(false);
const statusText = ref('正在加载 ruansan 三维模型...');
const generating = ref(false);
const closeDiagnostics = ref(null);
const previewState = ref({ phase: 'idle' });
const previewPhaseLabel = computed(() => ({ preparing: '准备表面采样', ready: '待播放', playing: '模拟飞行中', paused: '已暂停', finished: '模拟结束', error: '模拟未启动' }[previewState.value.phase] || '飞行模拟'));

const isClosePlanner = computed(() => props.plannerMode === 'close');
const usesBaseFootprint = computed(() => isClosePlanner.value);

const routeConfig = computed(() => {
  if (isClosePlanner.value) {
    const closeRoute = props.missionConfig.closeRoute || {};
    const closeDistance = Number(closeRoute.closeDistance ?? closeRoute.offset);

    return {
      radiusOffset: 0,
      lateralOverlap: 80,
      longitudinalOverlap: 70,
      offset: Number.isFinite(closeDistance) ? closeDistance : 10,
      bottomHeight: 0,
      topHeight: 20,
      modelUrl: DEFAULT_TILESET_URL,
      ...closeRoute,
      geometryType: 'box',
      offset: Number.isFinite(closeDistance) ? closeDistance : 10
    };
  }

  return {
    geometryType: 'box',
    radiusOffset: 0,
    lateralOverlap: 80,
    longitudinalOverlap: 80,
    offset: 20,
    modelUrl: DEFAULT_TILESET_URL,
    ...(props.missionConfig.geometryRoute || {})
  };
});

const modelUrl = computed(() => routeConfig.value.modelUrl || DEFAULT_TILESET_URL);

let CesiumApi = null;
let viewerInstance = null;
let tileset = null;
let clickHandler = null;
let loadingToken = 0;
let boundaryEntity = null;
let outlineEntity = null;
let routeEntity = null;
let routeEntities = [];
let boxEdgeEntities = [];
let pointEntities = [];
let surfaceEntities = [];
let recognizedSurfaceEntities = [];
let boundaryCartesians = [];
let boundaryWaypoints = [];
let generatedWaypoints = [];
let generatedRouteSegments = [];
let generatedSurfaceTargetCartesians = [];
let closeSurfaceTargets = [];
let closePlanningRevision = 0;
const detailedRayCache = new Map();
const flightSegmentCache = new Map();
let gizmoXAxisLineEntity = null;
let gizmoYAxisLineEntity = null;
let gizmoZAxisLineEntity = null;
let gizmoXAxisHandleEntity = null;
let gizmoYAxisHandleEntity = null;
let gizmoZAxisHandleEntity = null;
let gizmoCenterHandleEntity = null;
let activeTransformMode = 'none';
let activeTransformAxis = null;
let transformDragAxisVector = null;
let transformDragging = false;
let transformDragPlane = null;
let transformDragStartPoint = null;
let transformDragStartBoundary = [];
let suppressNextClick = false;
let isViewerUnmounted = false;
let coveragePreview = null;
let previewRevision = 0;
let previewSpeed = 20;

const clearCoveragePreview = () => {
  previewRevision += 1;
  coveragePreview?.dispose();
  coveragePreview = null;
  previewState.value = { phase: 'idle' };
};

const getCylinderPreview = () => (
  routeConfig.value.geometryType === 'cylinder' ? getCylinderFromThreePoints() : null
);

const emitState = () => {
  const cylinder = getCylinderPreview();
  emit('state-change', {
    modelReady: modelReady.value,
    hasArea: hasArea.value,
    transformMode: activeTransformMode,
    statusText: statusText.value,
    generating: generating.value,
    diagnostics: closeDiagnostics.value,
    baseRadius: cylinder?.baseRadius ?? null,
    currentRadius: cylinder?.radius ?? null,
    preview: { ...previewState.value },
    routeSummary: {
      surfaceCount: routeSummary.surfaceCount,
      scanLineCount: routeSummary.scanLineCount,
      waypointCount: routeSummary.waypointCount
    }
  });
};

const setStatus = (message) => {
  statusText.value = message;
  emitState();
};

const getReadyStatus = () => usesBaseFootprint.value ? '模型已加载，可以选择底面 4 个角点，并设置相对底面的扫描高度。' : (
  routeConfig.value.geometryType === 'cylinder'
    ? 'ruansan 模型已加载。圆柱体选择顺序：第一个点选顶面圆心，第二点点选顶面圆周，第三个点选底面任意一点。'
    : 'ruansan 模型已加载，可以选择长方体 8 个角点。'
);

const clearEntity = (entity) => {
  if (viewerInstance && entity && !entity.isDestroyed?.()) {
    try {
      viewerInstance.entities.remove(entity);
    } catch (error) {
      console.warn('Failed to remove Cesium entity safely', error);
    }
  }
};

const destroyCesiumObject = (object) => {
  if (!object || object.isDestroyed?.()) return;

  try {
    object.destroy?.();
  } catch (error) {
    console.warn('Failed to destroy Cesium object safely', error);
  }
};

const setPlanningVisualsVisible = (visible) => {
  [
    boundaryEntity,
    outlineEntity,
    ...boxEdgeEntities,
    ...pointEntities,
    ...surfaceEntities,
    ...recognizedSurfaceEntities
  ].forEach((entity) => {
    if (entity) entity.show = visible;
  });

  viewerInstance?.scene?.requestRender?.();
};

const waitForBrowserFrame = () => new Promise((resolve) => {
  requestAnimationFrame(() => resolve());
});

const emitEmptyRoute = () => {
  emit('update-route', {
    waypoints: [],
    boundaryPoints: [],
    boundaryGroups: [],
    routeCount: 0
  });
};

const clearRecognizedSurfaceVisuals = () => {
  recognizedSurfaceEntities.forEach(clearEntity);
  recognizedSurfaceEntities = [];
};

const clearRouteOnly = (emitEmpty = true) => {
  closePlanningRevision++;
  generating.value = false;
  closeDiagnostics.value = null;
  closeSurfaceTargets = [];
  detailedRayCache.clear();
  flightSegmentCache.clear();
  clearCoveragePreview();
  clearEntity(routeEntity);
  routeEntities.forEach(clearEntity);
  clearRecognizedSurfaceVisuals();
  routeEntity = null;
  routeEntities = [];
  generatedWaypoints = [];
  generatedRouteSegments = [];
  generatedSurfaceTargetCartesians = [];
  routeSummary.surfaceCount = 0;
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;

  if (emitEmpty) {
    emitEmptyRoute();
  }
};

const clearVisuals = () => {
  clearCoveragePreview();
  clearEntity(boundaryEntity);
  clearEntity(outlineEntity);
  clearEntity(routeEntity);
  routeEntities.forEach(clearEntity);
  boxEdgeEntities.forEach(clearEntity);
  pointEntities.forEach(clearEntity);
  surfaceEntities.forEach(clearEntity);
  clearRecognizedSurfaceVisuals();
  boundaryEntity = null;
  outlineEntity = null;
  routeEntity = null;
  routeEntities = [];
  boxEdgeEntities = [];
  pointEntities = [];
  surfaceEntities = [];
};

const clearTransformGizmo = () => {
  [
    gizmoXAxisLineEntity,
    gizmoYAxisLineEntity,
    gizmoZAxisLineEntity,
    gizmoXAxisHandleEntity,
    gizmoYAxisHandleEntity,
    gizmoZAxisHandleEntity,
    gizmoCenterHandleEntity
  ].forEach(clearEntity);

  gizmoXAxisLineEntity = null;
  gizmoYAxisLineEntity = null;
  gizmoZAxisLineEntity = null;
  gizmoXAxisHandleEntity = null;
  gizmoYAxisHandleEntity = null;
  gizmoZAxisHandleEntity = null;
  gizmoCenterHandleEntity = null;
};

const getRequiredPointCount = () => (
  usesBaseFootprint.value
    ? CLOSE_BASE_POINT_COUNT
    : (routeConfig.value.geometryType === 'cylinder' ? CYLINDER_POINT_COUNT : BOX_POINT_COUNT)
);

function clearPlanning(emitEmpty = false) {
  clearRouteOnly(false);
  clearVisuals();
  clearTransformGizmo();
  boundaryCartesians = [];
  boundaryWaypoints = [];
  generatedWaypoints = [];
  drawing.value = false;
  hasArea.value = false;
  activeTransformMode = 'none';
  activeTransformAxis = null;
  transformDragAxisVector = null;
  transformDragging = false;
  transformDragPlane = null;
  transformDragStartPoint = null;
  transformDragStartBoundary = [];
  suppressNextClick = false;
  routeSummary.surfaceCount = 0;
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;

  if (emitEmpty) {
    emitEmptyRoute();
  }

  setStatus(modelReady.value ? getReadyStatus() : '正在加载 ruansan 三维模型...');
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

const getHorizontalDistanceMeters = (start, end) => {
  if (!start || !end) return 0;

  const radius = 6378137;
  const dLat = (end.lat - start.lat) * Math.PI / 180;
  const dLng = (end.lng - start.lng) * Math.PI / 180;
  const lat1 = start.lat * Math.PI / 180;
  const lat2 = end.lat * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const addImageryLayer = () => {
  if (!viewerInstance || !CesiumApi) return;

  try {
    viewerInstance.imageryLayers.removeAll();
  } catch (error) {
    console.warn('Failed to clear imagery layers safely', error);
  }

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


const pickDetailedModelByRay = async (ray) => {
  const scene = viewerInstance?.scene;
  if (!scene || isViewerUnmounted || typeof scene.pickFromRayMostDetailed !== 'function') {
    throw new Error('当前浏览器不支持三维模型精细射线采样，请使用支持 WebGL 的 Chrome 或 Edge。');
  }
  const key = [ray.origin.x, ray.origin.y, ray.origin.z].map(n => n.toFixed(4)).join(',') + ':' +
    [ray.direction.x, ray.direction.y, ray.direction.z].map(n => n.toFixed(9)).join(',');
  if (!detailedRayCache.has(key)) {
    const pending = scene.pickFromRayMostDetailed(ray).then(hit => {
      const position = hit?.position;
      return position && [position.x, position.y, position.z].every(Number.isFinite) ? position : null;
    });
    detailedRayCache.set(key, pending);
    scene.requestRender();
  }
  return detailedRayCache.get(key);
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
    try {
      viewerInstance.scene.primitives.remove(tileset);
    } catch (error) {
      console.warn('Failed to remove tileset safely', error);
      destroyCesiumObject(tileset);
    }
  }
  tileset = null;
};

const loadTileset = async () => {
  if (!viewerInstance || !CesiumApi || isViewerUnmounted) return;

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

    if (token !== loadingToken || isViewerUnmounted || !viewerInstance) {
      destroyCesiumObject(loadedTileset);
      return;
    }

    tileset = viewerInstance.scene.primitives.add(loadedTileset);

    if (tileset.readyPromise) {
      await tileset.readyPromise;
    }

    if (token !== loadingToken || isViewerUnmounted || !viewerInstance) {
      removeTileset();
      return;
    }

    modelReady.value = true;
    viewerInstance.zoomTo(tileset);
    setStatus(getReadyStatus());
  } catch (error) {
    console.error('Failed to load geometry tileset', error);
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

const getBoundaryCentroid = () => {
  if (!CesiumApi || boundaryCartesians.length === 0) return null;

  const centroid = boundaryCartesians.reduce((acc, point) => {
    acc.x += point.x;
    acc.y += point.y;
    acc.z += point.z;
    return acc;
  }, new CesiumApi.Cartesian3(0, 0, 0));

  centroid.x /= boundaryCartesians.length;
  centroid.y /= boundaryCartesians.length;
  centroid.z /= boundaryCartesians.length;
  return centroid;
};

const computeBoundaryPlane = () => {
  if (!CesiumApi || boundaryCartesians.length < 3) return null;

  const centroid = getBoundaryCentroid();
  if (!centroid) return null;

  const normal = boundaryCartesians.reduce((acc, current, index) => {
    const next = boundaryCartesians[(index + 1) % boundaryCartesians.length];
    acc.x += (current.y - next.y) * (current.z + next.z);
    acc.y += (current.z - next.z) * (current.x + next.x);
    acc.z += (current.x - next.x) * (current.y + next.y);
    return acc;
  }, new CesiumApi.Cartesian3(0, 0, 0));

  const unitNormal = normalizeVector(normal);
  if (!unitNormal) return null;

  return {
    origin: centroid,
    normal: unitNormal
  };
};

const orientNormalTowardCamera = (plane) => {
  if (!CesiumApi || !viewerInstance || !plane) return plane?.normal;

  const normal = CesiumApi.Cartesian3.clone(plane.normal, new CesiumApi.Cartesian3());
  const toCamera = CesiumApi.Cartesian3.subtract(
    viewerInstance.camera.positionWC,
    plane.origin,
    new CesiumApi.Cartesian3()
  );

  if (CesiumApi.Cartesian3.dot(normal, toCamera) < 0) {
    CesiumApi.Cartesian3.negate(normal, normal);
  }

  return normal;
};

const projectPointToPlane = (point, plane) => {
  const offset = CesiumApi.Cartesian3.subtract(point, plane.origin, new CesiumApi.Cartesian3());
  const distance = CesiumApi.Cartesian3.dot(offset, plane.normal);
  return CesiumApi.Cartesian3.subtract(
    point,
    CesiumApi.Cartesian3.multiplyByScalar(plane.normal, distance, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );
};

const flattenBoundaryToPlane = () => {
  if (!CesiumApi || boundaryCartesians.length < 3) return false;

  const plane = computeBoundaryPlane();
  if (!plane) return false;

  boundaryCartesians = boundaryCartesians.map((point) => projectPointToPlane(point, plane));
  boundaryWaypoints = boundaryCartesians.map(waypointFromCartesian);
  return true;
};

const getAxisFrame = (center) => {
  const frame = CesiumApi.Transforms.eastNorthUpToFixedFrame(center);
  return {
    xAxis: CesiumApi.Cartesian3.normalize(
      CesiumApi.Matrix4.getColumn(frame, 0, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    ),
    yAxis: CesiumApi.Cartesian3.normalize(
      CesiumApi.Matrix4.getColumn(frame, 1, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    ),
    zAxis: CesiumApi.Cartesian3.normalize(
      CesiumApi.Matrix4.getColumn(frame, 2, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    )
  };
};

const getGeometryFrame = () => {
  if (!CesiumApi || boundaryCartesians.length < 3) return null;

  const plane = computeBoundaryPlane();
  if (!plane) return null;

  const normal = orientNormalTowardCamera(plane);
  if (!normal) return null;

  const enu = getAxisFrame(plane.origin);
  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(plane.origin, new CesiumApi.Cartesian3());
  let verticalAxis = CesiumApi.Cartesian3.subtract(
    up,
    CesiumApi.Cartesian3.multiplyByScalar(normal, CesiumApi.Cartesian3.dot(up, normal), new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );

  if (CesiumApi.Cartesian3.magnitudeSquared(verticalAxis) < 1e-8) {
    verticalAxis = CesiumApi.Cartesian3.clone(enu.yAxis, new CesiumApi.Cartesian3());
  }
  CesiumApi.Cartesian3.normalize(verticalAxis, verticalAxis);

  let horizontalAxis = CesiumApi.Cartesian3.cross(verticalAxis, normal, new CesiumApi.Cartesian3());
  if (CesiumApi.Cartesian3.magnitudeSquared(horizontalAxis) < 1e-8) {
    horizontalAxis = CesiumApi.Cartesian3.clone(enu.xAxis, new CesiumApi.Cartesian3());
  }
  CesiumApi.Cartesian3.normalize(horizontalAxis, horizontalAxis);

  return {
    origin: plane.origin,
    normal,
    horizontalAxis,
    verticalAxis,
    depthAxis: CesiumApi.Cartesian3.negate(normal, new CesiumApi.Cartesian3())
  };
};

const addScaled = (origin, axis, value) =>
  CesiumApi.Cartesian3.add(
    origin,
    CesiumApi.Cartesian3.multiplyByScalar(axis, value, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );

const addVectors = (...vectors) =>
  vectors.reduce(
    (acc, vector) => CesiumApi.Cartesian3.add(acc, vector, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3(0, 0, 0)
  );

const cartesianToPlaneMeters = (point, frame) => {
  const vector = CesiumApi.Cartesian3.subtract(point, frame.origin, new CesiumApi.Cartesian3());
  return {
    x: CesiumApi.Cartesian3.dot(vector, frame.horizontalAxis),
    y: CesiumApi.Cartesian3.dot(vector, frame.verticalAxis)
  };
};

const getPointCoordinate = (point, box, axis) => {
  const vector = CesiumApi.Cartesian3.subtract(point, box.center, new CesiumApi.Cartesian3());
  return CesiumApi.Cartesian3.dot(vector, axis);
};

const pointFromBoxCoords = (box, x, y, z) =>
  addVectors(
    box.center,
    CesiumApi.Cartesian3.multiplyByScalar(box.xAxis, x, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(box.yAxis, y, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(box.zAxis, z, new CesiumApi.Cartesian3())
  );

const surfacePointToCartesian = (surface, u, v, offset = 0) => {
  const uPart = CesiumApi.Cartesian3.multiplyByScalar(surface.uAxis, u, new CesiumApi.Cartesian3());
  const vPart = CesiumApi.Cartesian3.multiplyByScalar(surface.vAxis, v, new CesiumApi.Cartesian3());
  const offsetPart = CesiumApi.Cartesian3.multiplyByScalar(surface.normal, offset, new CesiumApi.Cartesian3());
  return addVectors(surface.origin, uPart, vPart, offsetPart);
};

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

const getSurfaceFacingHeading = (dronePosition, surface) => {
  const target = CesiumApi.Cartesian3.subtract(
    dronePosition,
    CesiumApi.Cartesian3.multiplyByScalar(surface.normal, 10, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );

  return getBearingDegrees(waypointFromCartesian(dronePosition), waypointFromCartesian(target));
};

const normalizeOverlapRate = (value, fallbackPercent = 70) => {
  let overlap = Number(value);
  if (!Number.isFinite(overlap)) {
    overlap = fallbackPercent;
  }
  if (overlap <= 1) {
    overlap *= 100;
  }
  return Math.min(Math.max(overlap, 0), 95) / 100;
};

const getGeometryCamera = () => {
  const preset = isClosePlanner.value && routeConfig.value.cameraPreset && routeConfig.value.cameraPreset !== 'auto'
    ? routeConfig.value.cameraPreset : props.missionConfig.aircraftModel;
  return CAMERA_PRESETS[preset] || CAMERA_PRESETS.m30t;
};

const getFovSpacing = (surfaceDistance, direction) => {
  const cameraConfig = getGeometryCamera();
  const overlapKey = direction === 'longitudinal' ? 'longitudinalOverlap' : 'lateralOverlap';
  const overlapRate = normalizeOverlapRate(routeConfig.value[overlapKey], 70);
  const distance = Math.max(Number(surfaceDistance) || 0, 0.1);
  return Math.max(0.1, calculateSpacing(distance, cameraConfig, overlapRate, direction));
};

const getCanonicalAxis = (vector) => {
  const axis = CesiumApi.Cartesian3.clone(vector, new CesiumApi.Cartesian3());
  const values = [axis.x, axis.y, axis.z];
  const dominantIndex = values
    .map((value) => Math.abs(value))
    .reduce((best, value, index, arr) => value > arr[best] ? index : best, 0);

  if (values[dominantIndex] < 0) {
    CesiumApi.Cartesian3.negate(axis, axis);
  }

  return axis;
};

const getDirectionClusters = () => {
  const clusters = [];

  for (let i = 0; i < boundaryCartesians.length; i += 1) {
    for (let j = i + 1; j < boundaryCartesians.length; j += 1) {
      const diff = CesiumApi.Cartesian3.subtract(
        boundaryCartesians[j],
        boundaryCartesians[i],
        new CesiumApi.Cartesian3()
      );
      const length = CesiumApi.Cartesian3.magnitude(diff);
      if (length < 0.2) continue;

      const direction = getCanonicalAxis(
        CesiumApi.Cartesian3.divideByScalar(diff, length, new CesiumApi.Cartesian3())
      );
      const existing = clusters.find((cluster) =>
        Math.abs(CesiumApi.Cartesian3.dot(cluster.axis, direction)) > 0.985
      );

      if (existing) {
        const aligned = CesiumApi.Cartesian3.dot(existing.axis, direction) < 0
          ? CesiumApi.Cartesian3.negate(direction, new CesiumApi.Cartesian3())
          : direction;
        existing.sum = CesiumApi.Cartesian3.add(existing.sum, aligned, new CesiumApi.Cartesian3());
        existing.axis = CesiumApi.Cartesian3.normalize(existing.sum, new CesiumApi.Cartesian3());
        existing.count += 1;
        existing.lengths.push(length);
      } else {
        clusters.push({
          axis: direction,
          sum: CesiumApi.Cartesian3.clone(direction, new CesiumApi.Cartesian3()),
          count: 1,
          lengths: [length]
        });
      }
    }
  }

  return clusters.sort((a, b) => b.count - a.count);
};

const getBoxFromEightPoints = () => {
  if (!CesiumApi || boundaryCartesians.length < BOX_POINT_COUNT) return null;

  const center = getBoundaryCentroid();
  if (!center) return null;

  const clusters = getDirectionClusters();
  const selectedAxes = [];

  clusters.forEach((cluster) => {
    if (selectedAxes.length >= 3) return;
    const perpendicular = selectedAxes.every((axis) =>
      Math.abs(CesiumApi.Cartesian3.dot(axis, cluster.axis)) < 0.18
    );
    if (perpendicular) {
      selectedAxes.push(CesiumApi.Cartesian3.clone(cluster.axis, new CesiumApi.Cartesian3()));
    }
  });

  if (selectedAxes.length < 3) return null;

  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(center, new CesiumApi.Cartesian3());
  let zAxis = selectedAxes.reduce((best, axis) =>
    Math.abs(CesiumApi.Cartesian3.dot(axis, up)) > Math.abs(CesiumApi.Cartesian3.dot(best, up)) ? axis : best
  );
  if (CesiumApi.Cartesian3.dot(zAxis, up) < 0) {
    zAxis = CesiumApi.Cartesian3.negate(zAxis, new CesiumApi.Cartesian3());
  }

  const horizontalAxes = selectedAxes.filter((axis) =>
    Math.abs(CesiumApi.Cartesian3.dot(axis, zAxis)) < 0.95
  );
  if (horizontalAxes.length < 2) return null;
  const toCamera = CesiumApi.Cartesian3.subtract(
    viewerInstance.camera.positionWC,
    center,
    new CesiumApi.Cartesian3()
  );
  let yAxis = horizontalAxes.reduce((best, axis) => {
    const currentScore = Math.abs(CesiumApi.Cartesian3.dot(axis, toCamera));
    const bestScore = Math.abs(CesiumApi.Cartesian3.dot(best, toCamera));
    return currentScore > bestScore ? axis : best;
  });
  if (CesiumApi.Cartesian3.dot(yAxis, toCamera) < 0) {
    yAxis = CesiumApi.Cartesian3.negate(yAxis, new CesiumApi.Cartesian3());
  }

  let xAxis = CesiumApi.Cartesian3.cross(yAxis, zAxis, new CesiumApi.Cartesian3());
  if (CesiumApi.Cartesian3.magnitudeSquared(xAxis) < 1e-8) return null;
  xAxis = CesiumApi.Cartesian3.normalize(xAxis, new CesiumApi.Cartesian3());

  const xValues = boundaryCartesians.map((point) => getPointCoordinate(point, { center }, xAxis));
  const yValues = boundaryCartesians.map((point) => getPointCoordinate(point, { center }, yAxis));
  const zValues = boundaryCartesians.map((point) => getPointCoordinate(point, { center }, zAxis));

  return {
    center,
    xAxis,
    yAxis,
    zAxis,
    minX: Math.min(...xValues),
    maxX: Math.max(...xValues),
    minY: Math.min(...yValues),
    maxY: Math.max(...yValues),
    minZ: Math.min(...zValues),
    maxZ: Math.max(...zValues)
  };
};

const getCloseHeightRange = () => {
  const rawBottom = Number(routeConfig.value.bottomHeight);
  const rawTop = Number(routeConfig.value.topHeight);
  const bottom = Number.isFinite(rawBottom) ? rawBottom : 0;
  const top = Number.isFinite(rawTop) ? rawTop : 20;

  return {
    bottom: Math.min(bottom, top),
    top: Math.max(bottom, top)
  };
};

const getProjectedBaseAxis = (baseCenter, up) => {
  for (let i = 1; i < boundaryCartesians.length; i += 1) {
    const edge = CesiumApi.Cartesian3.subtract(
      boundaryCartesians[i],
      boundaryCartesians[0],
      new CesiumApi.Cartesian3()
    );
    const verticalPart = CesiumApi.Cartesian3.multiplyByScalar(
      up,
      CesiumApi.Cartesian3.dot(edge, up),
      new CesiumApi.Cartesian3()
    );
    const horizontalPart = CesiumApi.Cartesian3.subtract(edge, verticalPart, new CesiumApi.Cartesian3());

    if (CesiumApi.Cartesian3.magnitude(horizontalPart) > 0.2) {
      return CesiumApi.Cartesian3.normalize(horizontalPart, new CesiumApi.Cartesian3());
    }
  }

  const frame = getAxisFrame(baseCenter);
  return frame.xAxis;
};

const getBoxFromCloseBase = () => {
  if (!CesiumApi || boundaryCartesians.length < CLOSE_BASE_POINT_COUNT) return null;

  const baseCenter = getBoundaryCentroid();
  if (!baseCenter) return null;

  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(baseCenter, new CesiumApi.Cartesian3());
  const xAxis = getProjectedBaseAxis(baseCenter, up);
  let yAxis = CesiumApi.Cartesian3.cross(up, xAxis, new CesiumApi.Cartesian3());
  if (CesiumApi.Cartesian3.magnitudeSquared(yAxis) < 1e-8) return null;
  yAxis = CesiumApi.Cartesian3.normalize(yAxis, yAxis);

  const xValues = boundaryCartesians.map((point) => getPointCoordinate(point, { center: baseCenter }, xAxis));
  const yValues = boundaryCartesians.map((point) => getPointCoordinate(point, { center: baseCenter }, yAxis));
  const { bottom, top } = getCloseHeightRange();
  const midHeight = (bottom + top) / 2;

  return {
    center: addScaled(baseCenter, up, midHeight),
    xAxis,
    yAxis,
    zAxis: up,
    minX: Math.min(...xValues),
    maxX: Math.max(...xValues),
    minY: Math.min(...yValues),
    maxY: Math.max(...yValues),
    minZ: bottom - midHeight,
    maxZ: top - midHeight
  };
};

const getActiveBox = () => (
  usesBaseFootprint.value ? getBoxFromCloseBase() : getBoxFromEightPoints()
);

const getTransformAxes = (center, cylinder = null) => {
  const fallbackFrame = getAxisFrame(center);

  if (routeConfig.value.geometryType === 'cylinder') {
    return {
      ...fallbackFrame,
      zAxis: cylinder?.zAxis || fallbackFrame.zAxis
    };
  }

  const box = getActiveBox();
  if (!box) return fallbackFrame;

  return {
    xAxis: CesiumApi.Cartesian3.clone(box.xAxis, new CesiumApi.Cartesian3()),
    yAxis: CesiumApi.Cartesian3.clone(box.yAxis, new CesiumApi.Cartesian3()),
    zAxis: CesiumApi.Cartesian3.clone(box.zAxis, new CesiumApi.Cartesian3())
  };
};

const getExpandedBox = (box, offset) => ({
  ...box,
  minX: box.minX - offset,
  maxX: box.maxX + offset,
  minY: box.minY - offset,
  maxY: box.maxY + offset
});

const getCylinderFromThreePoints = () => {
  if (!CesiumApi || boundaryCartesians.length < CYLINDER_POINT_COUNT) return null;

  const [topCenter, rimPoint, bottomPoint] = boundaryCartesians;
  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(topCenter, new CesiumApi.Cartesian3());
  const topToBottom = CesiumApi.Cartesian3.subtract(bottomPoint, topCenter, new CesiumApi.Cartesian3());
  const signedHeight = CesiumApi.Cartesian3.dot(topToBottom, up);
  const height = Math.abs(signedHeight);
  const radial = CesiumApi.Cartesian3.subtract(rimPoint, topCenter, new CesiumApi.Cartesian3());
  const projectedRadial = CesiumApi.Cartesian3.subtract(
    radial,
    CesiumApi.Cartesian3.multiplyByScalar(
      up,
      CesiumApi.Cartesian3.dot(radial, up),
      new CesiumApi.Cartesian3()
    ),
    new CesiumApi.Cartesian3()
  );
  const baseRadius = CesiumApi.Cartesian3.magnitude(projectedRadial);
  const radiusOffset = Number(routeConfig.value.radiusOffset) || 0;
  const radius = Math.max(0.2, baseRadius + radiusOffset);

  if (height < 0.2 || radius < 0.2) return null;

  const xAxis = CesiumApi.Cartesian3.normalize(projectedRadial, new CesiumApi.Cartesian3());
  let yAxis = CesiumApi.Cartesian3.cross(up, xAxis, new CesiumApi.Cartesian3());
  if (CesiumApi.Cartesian3.magnitudeSquared(yAxis) < 1e-8) return null;
  yAxis = CesiumApi.Cartesian3.normalize(yAxis, yAxis);

  return {
    center: addVectors(
      topCenter,
      CesiumApi.Cartesian3.multiplyByScalar(up, signedHeight / 2, new CesiumApi.Cartesian3())
    ),
    topCenter,
    bottomCenter: addVectors(
      topCenter,
      CesiumApi.Cartesian3.multiplyByScalar(up, signedHeight, new CesiumApi.Cartesian3())
    ),
    xAxis,
    yAxis,
    zAxis: up,
    baseRadius,
    radius,
    height
  };
};

const getOrbitHeading = (cartesian, normal) => {
  const target = CesiumApi.Cartesian3.subtract(
    cartesian,
    CesiumApi.Cartesian3.multiplyByScalar(normal, 10, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );
  return getBearingDegrees(waypointFromCartesian(cartesian), waypointFromCartesian(target));
};

const getOrbitOrientation = (cartesian, normal) => ({
  directionAngle: getOrbitHeading(cartesian, normal),
  gimbalPitch: 0
});

const getTargetFacingOrientation = (dronePosition, targetPosition) => {
  const droneWaypoint = waypointFromCartesian(dronePosition);
  const targetWaypoint = waypointFromCartesian(targetPosition);
  const horizontalDistance = Math.max(0.1, getHorizontalDistanceMeters(droneWaypoint, targetWaypoint));
  const heightDelta = targetWaypoint.height - droneWaypoint.height;

  return {
    directionAngle: getBearingDegrees(droneWaypoint, targetWaypoint),
    gimbalPitch: Math.atan2(heightDelta, horizontalDistance) * 180 / Math.PI
  };
};

const hasClearSightToTarget = async (dronePosition, targetPosition) => {
  const toTarget = CesiumApi.Cartesian3.subtract(targetPosition, dronePosition, new CesiumApi.Cartesian3());
  const targetDistance = CesiumApi.Cartesian3.magnitude(toTarget);
  if (!Number.isFinite(targetDistance) || targetDistance < 0.1) return false;

  const direction = CesiumApi.Cartesian3.divideByScalar(toTarget, targetDistance, new CesiumApi.Cartesian3());
  const firstHit = await pickDetailedModelByRay(new CesiumApi.Ray(dronePosition, direction));
  if (!firstHit) return false;

  const firstHitDistance = CesiumApi.Cartesian3.distance(dronePosition, firstHit);
  return Math.abs(firstHitDistance - targetDistance) <= Math.max(0.15, targetDistance * 0.01);
};

const getPointCartesian = (point) => {
  if (!point) return null;
  if ([point.x, point.y, point.z].every(Number.isFinite)) return point;
  if (CesiumApi.defined(point.cartesian)) return point.cartesian;
  if (typeof point.lng === 'number' && typeof point.lat === 'number') {
    return cartesianFromWaypoint(point);
  }
  return null;
};

const getCloseFlightSafetyRadius = (offset = routeConfig.value.offset) => {
  const distance = Number(offset);
  const baseDistance = Number.isFinite(distance) ? Math.max(distance, 0) : 10;
  return Math.min(
    CLOSE_ROUTE_SAFETY_RADIUS_MAX,
    Math.max(CLOSE_ROUTE_SAFETY_RADIUS_MIN, baseDistance * 0.18)
  );
};

const getSegmentSafetyOffsets = (start, direction, safetyRadius) => {
  if (!Number.isFinite(safetyRadius) || safetyRadius <= 0.01) {
    return [new CesiumApi.Cartesian3(0, 0, 0)];
  }

  const up = normalizeVector(CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(start, new CesiumApi.Cartesian3()));
  let sideAxis = up
    ? CesiumApi.Cartesian3.cross(direction, up, new CesiumApi.Cartesian3())
    : null;

  if (!sideAxis || CesiumApi.Cartesian3.magnitudeSquared(sideAxis) < 1e-8) {
    sideAxis = CesiumApi.Cartesian3.cross(direction, CesiumApi.Cartesian3.UNIT_X, new CesiumApi.Cartesian3());
  }
  if (CesiumApi.Cartesian3.magnitudeSquared(sideAxis) < 1e-8) {
    sideAxis = CesiumApi.Cartesian3.cross(direction, CesiumApi.Cartesian3.UNIT_Y, new CesiumApi.Cartesian3());
  }
  sideAxis = normalizeVector(sideAxis);
  if (!sideAxis) return [new CesiumApi.Cartesian3(0, 0, 0)];

  const liftAxis = normalizeVector(CesiumApi.Cartesian3.cross(sideAxis, direction, new CesiumApi.Cartesian3()));
  if (!liftAxis) return [new CesiumApi.Cartesian3(0, 0, 0)];

  return [
    new CesiumApi.Cartesian3(0, 0, 0),
    CesiumApi.Cartesian3.multiplyByScalar(sideAxis, safetyRadius, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(sideAxis, -safetyRadius, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(liftAxis, safetyRadius, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(liftAxis, -safetyRadius, new CesiumApi.Cartesian3())
  ];
};

const isSingleRaySegmentClear = async (start, end) => {
  const toEnd = CesiumApi.Cartesian3.subtract(end, start, new CesiumApi.Cartesian3());
  const segmentDistance = CesiumApi.Cartesian3.magnitude(toEnd);
  if (!Number.isFinite(segmentDistance)) return false;
  if (segmentDistance < 0.01) return true;

  const direction = CesiumApi.Cartesian3.divideByScalar(toEnd, segmentDistance, new CesiumApi.Cartesian3());
  const startPadding = Math.min(0.02, segmentDistance / 4);
  const endPadding = Math.min(0.02, segmentDistance / 4);
  const checkDistance = segmentDistance - startPadding - endPadding;
  if (checkDistance <= 0.05) return true;

  const rayOrigin = addScaled(start, direction, startPadding);
  const firstHit = await pickDetailedModelByRay(new CesiumApi.Ray(rayOrigin, direction));
  if (!firstHit) return true;

  const firstHitDistance = CesiumApi.Cartesian3.distance(rayOrigin, firstHit);
  return firstHitDistance >= checkDistance - CLOSE_ROUTE_SEGMENT_BLOCK_TOLERANCE;
};

const hasClearFlightSegment = async (startPoint, endPoint, safetyRadius = getCloseFlightSafetyRadius()) => {
  const start = getPointCartesian(startPoint);
  const end = getPointCartesian(endPoint);
  if (!start || !end) return false;

  const toEnd = CesiumApi.Cartesian3.subtract(end, start, new CesiumApi.Cartesian3());
  const segmentDistance = CesiumApi.Cartesian3.magnitude(toEnd);
  if (!Number.isFinite(segmentDistance)) return false;
  if (segmentDistance < 0.01) return true;

  const direction = CesiumApi.Cartesian3.divideByScalar(toEnd, segmentDistance, new CesiumApi.Cartesian3());
  const safetyOffsets = getSegmentSafetyOffsets(start, direction, safetyRadius);

  const coordinates = [start, end].map(p => [p.x, p.y, p.z].map(n => n.toFixed(4)).join(',')).sort();
  const key = coordinates.join(':') + ':' + safetyRadius.toFixed(3);
  if (!flightSegmentCache.has(key)) flightSegmentCache.set(key, Promise.all(safetyOffsets.map((offset) =>
    isSingleRaySegmentClear(
      CesiumApi.Cartesian3.add(start, offset, new CesiumApi.Cartesian3()),
      CesiumApi.Cartesian3.add(end, offset, new CesiumApi.Cartesian3())
    )
  )).then(results => results.every(Boolean)));
  return flightSegmentCache.get(key);
};

const hasPhotoPositionClearance = async position => {
  const transform = CesiumApi.Transforms.eastNorthUpToFixedFrame(position);
  const radius = getCloseFlightSafetyRadius();
  const checks = [];
  for (const index of [0, 1, 2]) {
    const axis = CesiumApi.Matrix4.getColumn(transform, index, new CesiumApi.Cartesian3());
    for (const sign of [-1, 1]) checks.push(isSingleRaySegmentClear(position, addScaled(position, axis, sign * radius)));
  }
  if (!(await Promise.all(checks)).every(Boolean)) return false;
  // A usable photo pose must also have a checked exit. This common transit hub
  // lets the connector join poses without accepting a locally clear dead end.
  const box = getActiveBox();
  if (!box) return false;
  const offset = Number(routeConfig.value.offset);
  const safeZ = box.maxZ + Math.max(CLOSE_ROUTE_CONNECTOR_MIN_CLEARANCE, offset * 2.5, Math.min(offset, 3) * 2);
  const high = createTransitionPointAtBoxZ(position, box, safeZ);
  const hub = createSafeTransitionPoint(pointFromBoxCoords(box, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, safeZ));
  return isSafePointPath([position, high, hub], radius);
};


const getPathHeading = (current, target) => {
  if (!current || !target) return 0;
  return getBearingDegrees(waypointFromCartesian(current), waypointFromCartesian(target));
};

const createOrbitPoint = (box, x, y, z, normal, segmentName, pointSpacing) => {
  const cartesian = pointFromBoxCoords(box, x, y, z);
  const waypoint = waypointFromCartesian(cartesian);
  const orientation = getOrbitOrientation(cartesian, normal);
  return {
    ...waypoint,
    cartesian,
    surfaceKey: 'orbit',
    surfaceName: segmentName,
    speed: props.missionConfig.globalSpeed,
    gimbalPitch: orientation.gimbalPitch,
    directionAngle: orientation.directionAngle,
    photoDistance: pointSpacing
  };
};

const isPointInsideBoxVolume = (point, box, tolerance = 0) => {
  const x = getPointCoordinate(point, box, box.xAxis);
  const y = getPointCoordinate(point, box, box.yAxis);
  const z = getPointCoordinate(point, box, box.zAxis);

  return x >= box.minX - tolerance && x <= box.maxX + tolerance &&
    y >= box.minY - tolerance && y <= box.maxY + tolerance &&
    z >= box.minZ - tolerance && z <= box.maxZ + tolerance;
};


const appendPointIfDistinct = (points, point) => {
  if (!point) return;
  if (points.length === 0) {
    points.push(point);
    return;
  }

  const previous = points[points.length - 1];
  if (CesiumApi.Cartesian3.distance(previous.cartesian, point.cartesian) > 0.01) {
    points.push(point);
  }
};

const createTopSurfacePoint = (box, x, y, z, pointSpacing) => {
  const cartesian = pointFromBoxCoords(box, x, y, z);
  const waypoint = waypointFromCartesian(cartesian);
  return {
    ...waypoint,
    cartesian,
    surfaceKey: 'top',
    surfaceName: '顶面',
    speed: props.missionConfig.globalSpeed,
    gimbalPitch: -90,
    directionAngle: 0,
    photoDistance: pointSpacing
  };
};


const pointFromCylinder = (cylinder, angle, z, radiusOffset = 0) => {
  const radius = cylinder.radius + radiusOffset;
  return addVectors(
    cylinder.center,
    CesiumApi.Cartesian3.multiplyByScalar(cylinder.xAxis, Math.cos(angle) * radius, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(cylinder.yAxis, Math.sin(angle) * radius, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(cylinder.zAxis, z, new CesiumApi.Cartesian3())
  );
};

const getCylinderNormal = (cylinder, angle) =>
  CesiumApi.Cartesian3.normalize(
    addVectors(
      CesiumApi.Cartesian3.multiplyByScalar(cylinder.xAxis, Math.cos(angle), new CesiumApi.Cartesian3()),
      CesiumApi.Cartesian3.multiplyByScalar(cylinder.yAxis, Math.sin(angle), new CesiumApi.Cartesian3())
    ),
    new CesiumApi.Cartesian3()
  );

const createCylinderOrbitPoint = (cylinder, angle, z, offset, pointSpacing) => {
  const cartesian = pointFromCylinder(cylinder, angle, z, offset);
  const waypoint = waypointFromCartesian(cartesian);
  const normal = getCylinderNormal(cylinder, angle);
  const orientation = getOrbitOrientation(cartesian, normal);
  return {
    ...waypoint,
    cartesian,
    surfaceKey: 'cylinder-orbit',
    surfaceName: '圆柱侧面',
    speed: props.missionConfig.globalSpeed,
    gimbalPitch: orientation.gimbalPitch,
    directionAngle: orientation.directionAngle,
    photoDistance: pointSpacing
  };
};

const createTransformHandle = (center, axis, color, axisName, length) => {
  const handlePosition = addScaled(center, axis, length);
  return viewerInstance.entities.add({
    position: handlePosition,
    point: {
      pixelSize: 14,
      color,
      outlineColor: CesiumApi.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    properties: {
      geometryTransformAxis: axisName
    }
  });
};

const createCylinderCenterHandle = (position) => viewerInstance.entities.add({
  position,
  point: {
    pixelSize: 16,
    color: CesiumApi.Color.fromCssColorString('#00d5ff'),
    outlineColor: CesiumApi.Color.WHITE,
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY
  },
  properties: {
    geometryCenterDrag: true
  }
});

const updateTransformGizmo = () => {
  clearTransformGizmo();

  if (!viewerInstance || !CesiumApi || !hasArea.value || activeTransformMode !== 'translate') {
    emitState();
    return;
  }

  const isCylinder = routeConfig.value.geometryType === 'cylinder';
  const cylinder = isCylinder ? getCylinderFromThreePoints() : null;
  const center = isCylinder
    ? (cylinder?.topCenter || boundaryCartesians[0])
    : getBoundaryCentroid();
  if (!center) {
    emitState();
    return;
  }

  const frame = getTransformAxes(center, cylinder);
  const distanceToCamera = CesiumApi.Cartesian3.distance(viewerInstance.camera.positionWC, center);
  const axisLength = Math.max(8, distanceToCamera * 0.12);
  const colors = {
    x: CesiumApi.Color.fromCssColorString('#ff4d4f'),
    y: CesiumApi.Color.fromCssColorString('#52c41a'),
    z: CesiumApi.Color.fromCssColorString('#1677ff')
  };

  const createAxisLine = (axis, color) => viewerInstance.entities.add({
    polyline: {
      positions: [center, addScaled(center, axis, axisLength)],
      width: 4,
      material: color,
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });

  if (isCylinder) {
    const zAxis = cylinder?.zAxis || frame.zAxis;
    gizmoCenterHandleEntity = createCylinderCenterHandle(center);
    gizmoZAxisLineEntity = createAxisLine(zAxis, colors.z);
    gizmoZAxisHandleEntity = createTransformHandle(center, zAxis, colors.z, 'z', axisLength);
    emitState();
    return;
  }

  gizmoXAxisLineEntity = createAxisLine(frame.xAxis, colors.x);
  gizmoYAxisLineEntity = createAxisLine(frame.yAxis, colors.y);
  gizmoZAxisLineEntity = createAxisLine(frame.zAxis, colors.z);

  gizmoXAxisHandleEntity = createTransformHandle(center, frame.xAxis, colors.x, 'x', axisLength);
  gizmoYAxisHandleEntity = createTransformHandle(center, frame.yAxis, colors.y, 'y', axisLength);
  gizmoZAxisHandleEntity = createTransformHandle(center, frame.zAxis, colors.z, 'z', axisLength);
  emitState();
};

const getPickedEntity = (windowPosition) => {
  if (!viewerInstance || !CesiumApi || !windowPosition) return null;

  const picked = viewerInstance.scene.pick(windowPosition);
  if (!CesiumApi.defined(picked)) return null;
  return picked.id || picked.primitive || null;
};

const getTranslationHandle = (windowPosition) => {
  const entity = getPickedEntity(windowPosition);
  const isCenterDrag = entity?.properties?.geometryCenterDrag?.getValue?.();
  if (isCenterDrag && routeConfig.value.geometryType === 'cylinder' && boundaryCartesians.length > 0) {
    const topCenter = boundaryCartesians[0];
    const planeNormal = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(
      topCenter,
      new CesiumApi.Cartesian3()
    );
    return {
      axis: 'xy',
      axisVector: null,
      plane: {
        origin: topCenter,
        normal: planeNormal
      }
    };
  }

  const axis = entity?.properties?.geometryTransformAxis?.getValue?.();
  if (!axis) return null;
  if (routeConfig.value.geometryType === 'cylinder' && axis !== 'z') return null;

  const cylinder = routeConfig.value.geometryType === 'cylinder' ? getCylinderFromThreePoints() : null;
  const center = routeConfig.value.geometryType === 'cylinder'
    ? (cylinder?.topCenter || boundaryCartesians[0])
    : getBoundaryCentroid();
  if (!center) return null;

  const frame = getTransformAxes(center, cylinder);
  return {
    axis,
    axisVector: frame[`${axis}Axis`]
  };
};

const getMovementPlane = (center, axisVector) => {
  const cameraVector = normalizeVector(
    CesiumApi.Cartesian3.subtract(viewerInstance.camera.positionWC, center, new CesiumApi.Cartesian3())
  );
  if (!cameraVector) return null;

  const cameraCrossAxis = CesiumApi.Cartesian3.cross(cameraVector, axisVector, new CesiumApi.Cartesian3());
  let planeNormal = CesiumApi.Cartesian3.cross(axisVector, cameraCrossAxis, new CesiumApi.Cartesian3());

  if (CesiumApi.Cartesian3.magnitudeSquared(planeNormal) < 1e-8) {
    planeNormal = CesiumApi.Cartesian3.cross(axisVector, CesiumApi.Cartesian3.UNIT_Z, new CesiumApi.Cartesian3());
  }
  if (CesiumApi.Cartesian3.magnitudeSquared(planeNormal) < 1e-8) {
    planeNormal = CesiumApi.Cartesian3.cross(axisVector, CesiumApi.Cartesian3.UNIT_X, new CesiumApi.Cartesian3());
  }

  planeNormal = normalizeVector(planeNormal);
  return planeNormal ? { origin: center, normal: planeNormal } : null;
};

const intersectRayWithPlane = (ray, plane) => {
  if (!ray || !plane) return null;

  const denominator = CesiumApi.Cartesian3.dot(ray.direction, plane.normal);
  if (Math.abs(denominator) < 1e-6) return null;

  const diff = CesiumApi.Cartesian3.subtract(plane.origin, ray.origin, new CesiumApi.Cartesian3());
  const t = CesiumApi.Cartesian3.dot(diff, plane.normal) / denominator;
  if (!Number.isFinite(t) || t < 0) return null;

  return addVectors(
    ray.origin,
    CesiumApi.Cartesian3.multiplyByScalar(ray.direction, t, new CesiumApi.Cartesian3())
  );
};

const startTranslationDrag = (movement) => {
  if (activeTransformMode !== 'translate' || !hasArea.value) return;

  const handle = getTranslationHandle(movement.position);
  if (!handle) return;

  const center = handle.axis === 'xy' ? handle.plane?.origin : getBoundaryCentroid();
  const plane = handle.plane || getMovementPlane(center, handle.axisVector);
  const ray = viewerInstance.camera.getPickRay(movement.position);
  const startPoint = intersectRayWithPlane(ray, plane);
  if (!plane || !startPoint) return;

  activeTransformAxis = handle.axis;
  transformDragAxisVector = handle.axisVector;
  transformDragPlane = plane;
  transformDragStartPoint = startPoint;
  transformDragStartBoundary = boundaryCartesians.map((point) =>
    CesiumApi.Cartesian3.clone(point, new CesiumApi.Cartesian3())
  );
  transformDragging = true;
  suppressNextClick = false;
  viewerInstance.scene.screenSpaceCameraController.enableInputs = false;
};

const handleTranslationDragMove = (movement) => {
  if (!transformDragging || !transformDragPlane) return;

  const ray = viewerInstance.camera.getPickRay(movement.endPosition);
  const currentPoint = intersectRayWithPlane(ray, transformDragPlane);
  if (!currentPoint) return;

  const dragVector = CesiumApi.Cartesian3.subtract(
    currentPoint,
    transformDragStartPoint,
    new CesiumApi.Cartesian3()
  );
  let offsetVector = dragVector;
  if (activeTransformAxis !== 'xy') {
    if (!transformDragAxisVector) return;
    const axisDistance = CesiumApi.Cartesian3.dot(dragVector, transformDragAxisVector);
    offsetVector = CesiumApi.Cartesian3.multiplyByScalar(
      transformDragAxisVector,
      axisDistance,
      new CesiumApi.Cartesian3()
    );
  }

  boundaryCartesians = transformDragStartBoundary.map((point) =>
    CesiumApi.Cartesian3.add(point, offsetVector, new CesiumApi.Cartesian3())
  );
  boundaryWaypoints = boundaryCartesians.map(waypointFromCartesian);
  clearRouteOnly(true);
  drawBoundary();
  updateTransformGizmo();
  emitBoundaryState();
  setStatus('测区已平移，请重新点击生成航线。');
  suppressNextClick = true;
};

const stopTransformDrag = () => {
  if (!transformDragging) return;

  transformDragging = false;
  activeTransformAxis = null;
  transformDragAxisVector = null;
  transformDragPlane = null;
  transformDragStartPoint = null;
  transformDragStartBoundary = [];

  if (viewerInstance) {
    viewerInstance.scene.screenSpaceCameraController.enableInputs = true;
  }
};

const buildEdgeCoveringRows = (minValue, maxValue, spacing) => {
  const start = Number(minValue);
  const end = Number(maxValue);
  const rowSpacing = Math.max(0.1, Number(spacing) || 0.1);
  const length = end - start;

  if (!Number.isFinite(length) || length <= 0) {
    return [start];
  }

  if (length <= rowSpacing) {
    return [start, end].filter((value, index, values) =>
      index === 0 || Math.abs(value - values[index - 1]) > 0.01
    );
  }

  const rows = [start];
  for (let value = start + rowSpacing; value < end - 0.01; value += rowSpacing) {
    rows.push(value);
  }
  rows.push(end);
  return rows;
};

const generateCylinderOrbitRoute = (cylinder, lateralSpacing, longitudinalSpacing, offset) => {
  const rowSpacing = Math.max(0.1, Number(lateralSpacing) || 0.1);
  const pointSpacing = Math.max(0.1, Number(longitudinalSpacing) || 0.1);
  const halfHeight = cylinder.height / 2;
  const rows = buildEdgeCoveringRows(-halfHeight, halfHeight, rowSpacing);

  const steps = Math.max(12, Math.ceil((2 * Math.PI * (cylinder.radius + offset)) / pointSpacing));
  const points = [];
  rows.forEach((z) => {
    for (let step = 0; step <= steps; step += 1) {
      const angle = step / steps * Math.PI * 2;
      appendPointIfDistinct(points, createCylinderOrbitPoint(cylinder, angle, z, offset, pointSpacing));
    }
  });

  return {
    points,
    ringCount: rows.length
  };
};

const createCylinderTopPoint = (cylinder, x, y, z, pointSpacing) => {
  const cartesian = addVectors(
    cylinder.center,
    CesiumApi.Cartesian3.multiplyByScalar(cylinder.xAxis, x, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(cylinder.yAxis, y, new CesiumApi.Cartesian3()),
    CesiumApi.Cartesian3.multiplyByScalar(cylinder.zAxis, z, new CesiumApi.Cartesian3())
  );
  const waypoint = waypointFromCartesian(cartesian);
  return {
    ...waypoint,
    cartesian,
    surfaceKey: 'cylinder-top',
    surfaceName: '顶面',
    speed: props.missionConfig.globalSpeed,
    gimbalPitch: -90,
    directionAngle: 0,
    photoDistance: pointSpacing
  };
};

const generateCylinderTopRoute = (cylinder, lateralSpacing, longitudinalSpacing, offset, topOffset = 20) => {
  const rowSpacing = Math.max(0.1, Number(lateralSpacing) || 0.1);
  const pointSpacing = Math.max(0.1, Number(longitudinalSpacing) || 0.1);
  const radius = cylinder.radius + offset;
  const z = cylinder.height / 2 + topOffset;
  const rows = [];

  if (radius * 2 <= rowSpacing) {
    rows.push(0);
  } else {
    for (let y = radius - rowSpacing / 2; y >= -radius + rowSpacing / 2; y -= rowSpacing) {
      rows.push(y);
    }
  }
  if (rows.length === 0) rows.push(0);

  const points = [];
  rows.forEach((y, rowIndex) => {
    const maxX = Math.sqrt(Math.max(radius * radius - y * y, 0));
    const leftToRight = rowIndex % 2 === 0;
    const startX = leftToRight ? -maxX : maxX;
    const endX = leftToRight ? maxX : -maxX;
    const steps = Math.max(1, Math.ceil((maxX * 2) / pointSpacing));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      appendPointIfDistinct(points, createCylinderTopPoint(
        cylinder,
        startX + (endX - startX) * t,
        y,
        z,
        pointSpacing
      ));
    }
  });

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[index + 1] || points[index - 1];
    current.directionAngle = next ? getPathHeading(current.cartesian, next.cartesian) : 0;
  }

  return {
    points,
    rowCount: rows.length
  };
};

const appendOrbitSegment = (points, box, segment, pointSpacing) => {
  const length = Math.hypot(segment.endX - segment.startX, segment.endY - segment.startY);
  const steps = Math.max(1, Math.ceil(length / pointSpacing));

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    appendPointIfDistinct(points, createOrbitPoint(
      box,
      segment.startX + (segment.endX - segment.startX) * t,
      segment.startY + (segment.endY - segment.startY) * t,
      segment.z,
      segment.normal,
      segment.name,
      pointSpacing
    ));
  }
};






const getPointBoxCoords = (point, box) => {
  const cartesian = getPointCartesian(point);
  if (!cartesian || !box) return null;

  return {
    x: getPointCoordinate(cartesian, box, box.xAxis),
    y: getPointCoordinate(cartesian, box, box.yAxis),
    z: getPointCoordinate(cartesian, box, box.zAxis)
  };
};

const createSafeTransitionPoint = (cartesian, referencePoint = null) => {
  const waypoint = waypointFromCartesian(cartesian);
  return {
    ...waypoint,
    cartesian,
    surfaceKey: 'safe-transition',
    surfaceName: '安全过渡',
    speed: props.missionConfig.globalTransitionalSpeed || props.missionConfig.globalSpeed,
    gimbalPitch: typeof referencePoint?.gimbalPitch === 'number' ? referencePoint.gimbalPitch : 0,
    directionAngle: typeof referencePoint?.directionAngle === 'number' ? referencePoint.directionAngle : 0,
    photoDistance: 0,
    skipAction: true,
    isTransition: true
  };
};

const createTransitionPointAtBoxZ = (point, box, z) => {
  const coords = getPointBoxCoords(point, box);
  if (!coords) return null;
  return createSafeTransitionPoint(pointFromBoxCoords(box, coords.x, coords.y, z), point);
};

const getBoxHorizontalOutwardAxis = (point, box) => {
  const coords = getPointBoxCoords(point, box);
  if (!coords) return null;

  const midX = (box.minX + box.maxX) / 2;
  const midY = (box.minY + box.maxY) / 2;
  const xSign = coords.x >= midX ? 1 : -1;
  const ySign = coords.y >= midY ? 1 : -1;
  const outsideX = coords.x > box.maxX || coords.x < box.minX;
  const outsideY = coords.y > box.maxY || coords.y < box.minY;

  let outward;
  if (outsideX && !outsideY) {
    outward = CesiumApi.Cartesian3.multiplyByScalar(box.xAxis, xSign, new CesiumApi.Cartesian3());
  } else if (outsideY && !outsideX) {
    outward = CesiumApi.Cartesian3.multiplyByScalar(box.yAxis, ySign, new CesiumApi.Cartesian3());
  } else {
    outward = addVectors(
      CesiumApi.Cartesian3.multiplyByScalar(box.xAxis, xSign, new CesiumApi.Cartesian3()),
      CesiumApi.Cartesian3.multiplyByScalar(box.yAxis, ySign, new CesiumApi.Cartesian3())
    );
  }

  return normalizeVector(outward);
};

const createOutwardTransitionPoint = (point, box, distance) => {
  const cartesian = getPointCartesian(point);
  const outward = getBoxHorizontalOutwardAxis(point, box);
  if (!cartesian || !outward) return null;
  return createSafeTransitionPoint(addScaled(cartesian, outward, distance), point);
};

const isSafePointPath = async (points, safetyRadius) => {
  for (let index = 1; index < points.length; index += 1) {
    if (!(await hasClearFlightSegment(points[index - 1], points[index], safetyRadius))) {
      return false;
    }
  }

  return true;
};


const createSafeConnectorPoints = async (startPoint, endPoint, box, offset, pointSpacing) => {
  const safetyRadius = getCloseFlightSafetyRadius(offset);
  if (await hasClearFlightSegment(startPoint, endPoint, safetyRadius)) {
    return [];
  }

  const safeZ = box.maxZ + Math.max(
    CLOSE_ROUTE_CONNECTOR_MIN_CLEARANCE,
    offset * 2.5,
    pointSpacing * 2
  );
  const outwardDistance = Math.max(offset * 1.5, pointSpacing * 2, 12);
  const startHigh = createTransitionPointAtBoxZ(startPoint, box, safeZ);
  const endHigh = createTransitionPointAtBoxZ(endPoint, box, safeZ);
  const startOut = createOutwardTransitionPoint(startPoint, box, outwardDistance);
  const endOut = createOutwardTransitionPoint(endPoint, box, outwardDistance);
  const startOutHigh = startOut ? createTransitionPointAtBoxZ(startOut, box, safeZ) : null;
  const endOutHigh = endOut ? createTransitionPointAtBoxZ(endOut, box, safeZ) : null;
  const candidates = [];

  // Try a short path outside the selected footprint before climbing above it.
  const startCoords = getPointBoxCoords(startPoint, box);
  const endCoords = getPointBoxCoords(endPoint, box);
  const travelZ = Math.max(startCoords.z, endCoords.z);
  const margin = Math.max(offset, safetyRadius * 2);
  const corners = [
    [box.minX - margin, box.minY - margin], [box.maxX + margin, box.minY - margin],
    [box.maxX + margin, box.maxY + margin], [box.minX - margin, box.maxY + margin]
  ].map(([x, y]) => createSafeTransitionPoint(pointFromBoxCoords(box, x, y, travelZ)));
  const nearest = point => corners.reduce((best, corner, index) =>
    CesiumApi.Cartesian3.distance(getPointCartesian(point), corner.cartesian) <
    CesiumApi.Cartesian3.distance(getPointCartesian(point), corners[best].cartesian) ? index : best, 0);
  for (const direction of [1, -1]) {
    const path = [];
    let index = nearest(startPoint);
    const last = nearest(endPoint);
    for (let step = 0; step < 4; step++) {
      path.push(corners[index]);
      if (index === last) break;
      index = (index + direction + 4) % 4;
    }
    candidates.push(path);
  }

  if (startHigh && endHigh) {
    candidates.push([startHigh, endHigh]);
    const hub = createSafeTransitionPoint(pointFromBoxCoords(box, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, safeZ));
    candidates.push([startHigh, hub, endHigh]);
  }
  if (startOut && startOutHigh && endOutHigh && endOut) {
    candidates.push([startOut, startOutHigh, endOutHigh, endOut]);
  }
  if (startHigh && startOutHigh && endOutHigh && endHigh) {
    candidates.push([startHigh, startOutHigh, endOutHigh, endHigh]);
  }

  const pathLength = path => [startPoint, ...path, endPoint].reduce((total, point, index, points) =>
    index ? total + CesiumApi.Cartesian3.distance(getPointCartesian(points[index - 1]), getPointCartesian(point)) : 0, 0);
  candidates.sort((a, b) => pathLength(a) - pathLength(b));
  for (const connectorPoints of candidates) {
    if (await isSafePointPath([startPoint, ...connectorPoints, endPoint], safetyRadius)) {
      return connectorPoints;
    }
  }

  return null;
};

const updateTransitionHeadings = (points) => {
  points.forEach((point, index) => {
    if (!point?.isTransition) return;

    const current = getPointCartesian(point);
    const target = getPointCartesian(points[index + 1]) || getPointCartesian(points[index - 1]);
    if (current && target) {
      point.directionAngle = getPathHeading(current, target);
    }
  });
};



const generateOrbitRoute = (box, lateralSpacing, longitudinalSpacing) => {
  const rowSpacing = Math.max(0.1, Number(lateralSpacing) || 0.1);
  const pointSpacing = Math.max(0.1, Number(longitudinalSpacing) || 0.1);
  const rows = buildEdgeCoveringRows(box.minZ, box.maxZ, rowSpacing);

  const negXAxis = CesiumApi.Cartesian3.negate(box.xAxis, new CesiumApi.Cartesian3());
  const negYAxis = CesiumApi.Cartesian3.negate(box.yAxis, new CesiumApi.Cartesian3());
  const points = [];
  const routeSegments = [];
  rows.forEach((z) => {
    const segments = [
      {
        name: '正面',
        startX: box.minX,
        startY: box.maxY,
        endX: box.maxX,
        endY: box.maxY,
        normal: box.yAxis,
        z
      },
      {
        name: '右侧',
        startX: box.maxX,
        startY: box.maxY,
        endX: box.maxX,
        endY: box.minY,
        normal: box.xAxis,
        z
      },
      {
        name: '背面',
        startX: box.maxX,
        startY: box.minY,
        endX: box.minX,
        endY: box.minY,
        normal: negYAxis,
        z
      },
      {
        name: '左侧',
        startX: box.minX,
        startY: box.minY,
        endX: box.minX,
        endY: box.maxY,
        normal: negXAxis,
        z
      }
    ];

    segments.forEach((segment) => {
      appendOrbitSegment(points, box, segment, pointSpacing);
    });
  });

  return {
    points,
    ringCount: rows.length
  };
};




const generateTopSurfaceRoute = (box, lateralSpacing, longitudinalSpacing, topOffset = 20) => {
  const rowSpacing = Math.max(0.1, Number(lateralSpacing) || 0.1);
  const pointSpacing = Math.max(0.1, Number(longitudinalSpacing) || 0.1);
  const expandedBox = getExpandedBox(box, Math.max(0, Number(routeConfig.value.offset) || 0));
  const width = box.maxX - box.minX;
  const depth = expandedBox.maxY - expandedBox.minY;
  const z = box.maxZ + topOffset;
  const rows = [];

  if (depth <= rowSpacing) {
    rows.push((expandedBox.minY + expandedBox.maxY) / 2);
  } else {
    for (let y = expandedBox.maxY - rowSpacing / 2; y >= expandedBox.minY + rowSpacing / 2; y -= rowSpacing) {
      rows.push(y);
    }
  }

  if (rows.length === 0) {
    rows.push((expandedBox.minY + expandedBox.maxY) / 2);
  }

  const points = [];

  rows.forEach((y, rowIndex) => {
    const leftToRight = rowIndex % 2 === 0;
    const startX = leftToRight ? expandedBox.minX : expandedBox.maxX;
    const endX = leftToRight ? expandedBox.maxX : expandedBox.minX;
    const steps = Math.max(1, Math.ceil((expandedBox.maxX - expandedBox.minX) / pointSpacing));

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      appendPointIfDistinct(
        points,
        createTopSurfacePoint(
          expandedBox,
          startX + (endX - startX) * t,
          y,
          z,
          pointSpacing
        )
      );
    }
  });

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[index + 1] || points[index - 1];
    current.directionAngle = next ? getPathHeading(current.cartesian, next.cartesian) : 0;
  }

  return {
    points,
    rowCount: rows.length
  };
};

const toPublicWaypoint = (point, index, lateralOverlapPercent, longitudinalOverlapPercent) => {
  const { cartesian, ...waypoint } = point;
  return {
    ...waypoint,
    index,
    lateralOverlap: lateralOverlapPercent,
    longitudinalOverlap: longitudinalOverlapPercent
  };
};

const drawGeometryBox = () => {
  boxEdgeEntities.forEach(clearEntity);
  surfaceEntities.forEach(clearEntity);
  boxEdgeEntities = [];
  surfaceEntities = [];

  const sourceBox = getActiveBox();
  if (!viewerInstance || !CesiumApi || !sourceBox) return;

  // The blue box represents the actual selected object, so it should stay on
  // the original eight-point geometry. Route expansion is handled separately.
  const box = sourceBox;
  const corner = (x, y, z) => pointFromBoxCoords(box, x, y, z);
  const faces = [
    [
      corner(box.minX, box.maxY, box.minZ),
      corner(box.maxX, box.maxY, box.minZ),
      corner(box.maxX, box.maxY, box.maxZ),
      corner(box.minX, box.maxY, box.maxZ)
    ],
    [
      corner(box.maxX, box.maxY, box.minZ),
      corner(box.maxX, box.minY, box.minZ),
      corner(box.maxX, box.minY, box.maxZ),
      corner(box.maxX, box.maxY, box.maxZ)
    ],
    [
      corner(box.maxX, box.minY, box.minZ),
      corner(box.minX, box.minY, box.minZ),
      corner(box.minX, box.minY, box.maxZ),
      corner(box.maxX, box.minY, box.maxZ)
    ],
    [
      corner(box.minX, box.minY, box.minZ),
      corner(box.minX, box.maxY, box.minZ),
      corner(box.minX, box.maxY, box.maxZ),
      corner(box.minX, box.minY, box.maxZ)
    ]
  ];

  faces.forEach((corners) => {
    surfaceEntities.push(viewerInstance.entities.add({
      polygon: {
        hierarchy: new CesiumApi.PolygonHierarchy(corners),
        material: CesiumApi.Color.fromCssColorString('#2c8cff').withAlpha(0.16),
        perPositionHeight: true
      }
    }));
  });

  faces.forEach((corners) => {
    boxEdgeEntities.push(viewerInstance.entities.add({
      polyline: {
        positions: [corners[0], corners[1], corners[2], corners[3], corners[0]],
        width: 2,
        material: CesiumApi.Color.fromCssColorString('#4da3ff'),
        arcType: CesiumApi.ArcType.NONE,
        clampToGround: false
      }
    }));
  });
};

const drawGeometryCylinder = () => {
  boxEdgeEntities.forEach(clearEntity);
  surfaceEntities.forEach(clearEntity);
  boxEdgeEntities = [];
  surfaceEntities = [];

  const cylinder = getCylinderFromThreePoints();
  if (!viewerInstance || !CesiumApi || !cylinder) return;

  const segments = 72;
  const top = [];
  const bottom = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = i / segments * Math.PI * 2;
    top.push(pointFromCylinder(cylinder, angle, cylinder.height / 2, 0));
    bottom.push(pointFromCylinder(cylinder, angle, -cylinder.height / 2, 0));
  }

  [top, bottom].forEach((positions) => {
    boxEdgeEntities.push(viewerInstance.entities.add({
      polyline: {
        positions,
        width: 2,
        material: CesiumApi.Color.fromCssColorString('#4da3ff'),
        arcType: CesiumApi.ArcType.NONE,
        clampToGround: false
      }
    }));
  });

  [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach((angle) => {
    boxEdgeEntities.push(viewerInstance.entities.add({
      polyline: {
        positions: [
          pointFromCylinder(cylinder, angle, -cylinder.height / 2, 0),
          pointFromCylinder(cylinder, angle, cylinder.height / 2, 0)
        ],
        width: 2,
        material: CesiumApi.Color.fromCssColorString('#4da3ff'),
        arcType: CesiumApi.ArcType.NONE,
        clampToGround: false
      }
    }));
  });
};

const drawBoundary = () => {
  if (!viewerInstance || !CesiumApi) return;

  clearVisuals();

  pointEntities = boundaryCartesians.map((position, index) =>
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
      },
      properties: {
        geometryCenterDrag: routeConfig.value.geometryType === 'cylinder' && index === 0
      }
    })
  );

  const requiredPointCount = getRequiredPointCount();

  if (boundaryCartesians.length >= 2 && boundaryCartesians.length < requiredPointCount) {
    const linePositions = [...boundaryCartesians];

    outlineEntity = viewerInstance.entities.add({
      polyline: {
        positions: linePositions,
        width: 3,
        material: CesiumApi.Color.fromCssColorString('#ffd447'),
        arcType: CesiumApi.ArcType.NONE,
        clampToGround: false
      }
    });
  }

  if (boundaryCartesians.length >= requiredPointCount) {
    if (routeConfig.value.geometryType === 'cylinder') {
      drawGeometryCylinder();
    } else {
      drawGeometryBox();
    }
  }
};

const drawRoute = () => {
  clearEntity(routeEntity);
  routeEntities.forEach(clearEntity);
  clearRecognizedSurfaceVisuals();
  routeEntity = null;
  routeEntities = [];

  if (!viewerInstance || !CesiumApi) return;

  const targetPoints = isClosePlanner.value
    ? generatedSurfaceTargetCartesians.filter((point) => CesiumApi.defined(point))
    : generatedWaypoints
        .map((waypoint) => waypoint.targetCartesian)
        .filter((point) => CesiumApi.defined(point));

  if (isClosePlanner.value && targetPoints.length > 0) {
    const markerStride = Math.max(1, Math.ceil(closeSurfaceTargets.length / CLOSE_SURFACE_MARKER_LIMIT));
    closeSurfaceTargets.forEach((target, index) => {
      if (index % markerStride !== 0) return;

      recognizedSurfaceEntities.push(viewerInstance.entities.add({
        position: target.position,
        point: {
          pixelSize: 7,
          color: (target.scheduled ? CesiumApi.Color.LIME : CesiumApi.Color.RED).withAlpha(0.95),
          outlineColor: CesiumApi.Color.WHITE,
          outlineWidth: 1,
          disableDepthTestDistance: 0
        }
      }));
    });
  }

  if (generatedWaypoints.length < 2) return;

  if (isClosePlanner.value && generatedRouteSegments.length > 0) {
    routeEntities = closeRouteLegs(generatedWaypoints)
      .map((leg) => viewerInstance.entities.add({
        polyline: {
          positions: leg.points.map((waypoint) => waypoint.cartesian || cartesianFromWaypoint(waypoint)),
          width: 4,
          material: leg.transition ? new CesiumApi.PolylineDashMaterialProperty({ color: CesiumApi.Color.ORANGE }) : CesiumApi.Color.fromCssColorString('#55ff78'),
          arcType: CesiumApi.ArcType.NONE,
          clampToGround: false
        }
      }));
    routeEntity = routeEntities[0] || null;
    return;
  }

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
    boundaryPoints: boundaryWaypoints,
    boundaryGroups: boundaryWaypoints.length >= getRequiredPointCount() ? [boundaryWaypoints] : [],
    routeCount: 0
  });
};

const onCanvasClick = (movement) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }

  if (activeTransformMode !== 'none') {
    return;
  }

  if (!drawing.value || !modelReady.value) return;

  const requiredPointCount = getRequiredPointCount();

  if (boundaryCartesians.length >= requiredPointCount) {
    if (usesBaseFootprint.value) {
      setStatus('已选择底面，可以设置扫描高度并生成航线。');
      return;
    }

    setStatus(
      routeConfig.value.geometryType === 'cylinder'
        ? '已选择 3 个点，可以生成圆柱体航线。'
        : '已经选择 8 个角点，可以生成几何体航线。'
    );
    return;
  }

  const cartesian = getPickCartesian(movement.position);
  if (!cartesian) {
    setStatus('没有拾取到模型表面，请靠近 ruansan 模型再点击。');
    return;
  }

  boundaryCartesians.push(cartesian);
  boundaryWaypoints.push(waypointFromCartesian(cartesian));

  hasArea.value = boundaryWaypoints.length >= requiredPointCount;
  clearRouteOnly(false);
  drawBoundary();
  emitBoundaryState();

  if (usesBaseFootprint.value) {
    setStatus(
      hasArea.value
        ? '已选择底面，可以设置扫描高度并生成航线。'
        : `已选择 ${boundaryWaypoints.length} / ${requiredPointCount} 个底面点。`
    );
    return;
  }

  setStatus(
    hasArea.value
      ? (routeConfig.value.geometryType === 'cylinder'
        ? '已选择 3 个点，可以生成圆柱体航线。'
        : '已选择 8 个角点，可以生成几何体航线。')
      : `已选择 ${boundaryWaypoints.length} / ${requiredPointCount} 个点。`
  );
  return;

  setStatus(
    hasArea.value
      ? '已选择 8 个角点，可以生成几何体航线。'
      : `已选择 ${boundaryWaypoints.length} / 8 个角点。`
  );
};

const setupClickHandler = () => {
  if (!viewerInstance || !CesiumApi) return;

  if (clickHandler) {
    destroyCesiumObject(clickHandler);
  }

  clickHandler = new CesiumApi.ScreenSpaceEventHandler(viewerInstance.scene.canvas);
  clickHandler.setInputAction(onCanvasClick, CesiumApi.ScreenSpaceEventType.LEFT_CLICK);
  clickHandler.setInputAction(startTranslationDrag, CesiumApi.ScreenSpaceEventType.LEFT_DOWN);
  clickHandler.setInputAction(handleTranslationDragMove, CesiumApi.ScreenSpaceEventType.MOUSE_MOVE);
  clickHandler.setInputAction(stopTransformDrag, CesiumApi.ScreenSpaceEventType.LEFT_UP);
};

function fitCamera() {
  if (!viewerInstance) return;

  if (routeEntity || boxEdgeEntities.length > 0 || boundaryEntity) {
    viewerInstance.zoomTo(routeEntity || boxEdgeEntities[0] || boundaryEntity);
  } else if (tileset) {
    viewerInstance.zoomTo(tileset);
  }
}

function beginDraw() {
  if (usesBaseFootprint.value) {
    if (!modelReady.value) {
      setStatus('模型还没有加载完成。');
      return;
    }

    clearPlanning(true);
    drawing.value = true;
    activeTransformMode = 'none';
    updateTransformGizmo();
    setStatus('请在模型上依次点击底面 4 个角点。');
    return;
  }

  if (routeConfig.value.geometryType === 'cylinder') {
    if (!modelReady.value) {
      setStatus('模型还没有加载完成。');
      return;
    }

    clearPlanning(true);
    drawing.value = true;
    activeTransformMode = 'none';
    updateTransformGizmo();
    setStatus('请在 ruansan 模型上依次点击圆柱体顶面中心、顶面圆周上一点、底面任意一点。');
    return;
  }

  if (routeConfig.value.geometryType !== 'box') {
    setStatus('当前仅支持长方体，请先选择长方体。');
    return;
  }

  if (!modelReady.value) {
    setStatus('模型还没有加载完成。');
    return;
  }

  clearPlanning(true);
  drawing.value = true;
  activeTransformMode = 'none';
  updateTransformGizmo();
  setStatus('请在 ruansan 模型上依次点击长方体 8 个角点。');
}

function selectTransformMode(mode = 'translate') {
  if (!hasArea.value) {
    setStatus('请先完成几何体选区，再进行移动。');
    return;
  }

  drawing.value = false;
  activeTransformMode = activeTransformMode === mode ? 'none' : mode;
  clearRouteOnly(true);
  updateTransformGizmo();
  const translateStatus = routeConfig.value.geometryType === 'cylinder'
    ? '已进入移动模式，拖拽第一个圆心点可水平移动，拖拽 Z 轴可上下移动。'
    : '已进入移动模式，拖拽 XYZ 坐标轴可平移测区。';
  setStatus(
    activeTransformMode === 'translate'
      ? translateStatus
      : '已退出移动模式。'
  );
}

function prepareCoveragePreview() {
  if (isClosePlanner.value || generatedWaypoints.length < 2) return;
  const revision = ++previewRevision;
  const settings = routeConfig.value;
  const cylinder = settings.geometryType === 'cylinder' ? getCylinderFromThreePoints() : null;
  const box = cylinder ? { ...cylinder, minX: -cylinder.radius, maxX: cylinder.radius, minY: -cylinder.radius, maxY: cylinder.radius, minZ: -cylinder.height / 2, maxZ: cylinder.height / 2 } : getActiveBox();
  if (!box) return;
  try {
    const targets = sampleGeometryCoverageSurface(box);
    const dimensions = [box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ];
    const cameraConfig = getGeometryCamera();
    const route = generatedWaypoints.map(wp => ({ ...wp, position: cartesianFromWaypoint(wp) }));
    coveragePreview = createGeometryCoveragePreview({
      Cesium: CesiumApi, viewer: viewerInstance, route, targets, camera: cameraConfig, geometry: box,
      qualityPolicy: { sideDistance: Math.max(0.1, Number(settings.offset) || 20), topDistance: 20 },
      maxDistance: Math.max(...dimensions, Number(settings.offset), 20) * 3 + 20,
      cameraLabel: CAMERA_PRESETS[props.missionConfig.aircraftModel] ? cameraConfig.name : cameraConfig.name + '（参考参数）',
      onState: state => {
        if (revision !== previewRevision || isViewerUnmounted) return;
        previewState.value = state;
        emitState();
      }
    });
    coveragePreview.setSpeed(previewSpeed);
    coveragePreview.play();
  } catch (error) {
    if (revision === previewRevision && !isViewerUnmounted) {
      coveragePreview?.dispose(); coveragePreview = null;
      previewState.value = { phase: 'error', error: error.message }; emitState();
    }
  }
}

function previewCommand(command) {
  const type = typeof command === 'string' ? command : command.type;
  if (type === 'preview-speed') {
    previewSpeed = Number(command.value) || 20; coveragePreview?.setSpeed(previewSpeed); return;
  }
  if (type === 'preview-play') {
    if (coveragePreview) coveragePreview.play();
    else if (previewState.value.phase !== 'preparing') prepareCoveragePreview();
  } else if (type === 'preview-pause') coveragePreview?.pause();
  else if (type === 'preview-reset') coveragePreview?.reset();
  else if (type === 'preview-frustum') coveragePreview?.toggleFrustum();
  else if (type === 'preview-coverage') coveragePreview?.toggleCoverage();
}

async function buildClosePhotographyRoute() {
  if (generating.value || !modelReady.value) return;
  const box = getActiveBox();
  if (!box || boundaryWaypoints.length < CLOSE_BASE_POINT_COUNT) {
    setStatus('请先选择 4 个底面角点，并设置扫描高度。'); return;
  }
  if ([box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ].some(size => size < 0.2)) {
    setStatus('扫描范围太小，请检查底面和高度。'); return;
  }
  clearRouteOnly(true);
  const revision = ++closePlanningRevision;
  generating.value = true;
  setPlanningVisualsVisible(false);
  const checkCancelled = () => {
    if (isViewerUnmounted || revision !== closePlanningRevision) throw new Error('规划已取消');
  };
  const range = Number(routeConfig.value.offset);
  const cameraConfig = getGeometryCamera();
  try {
    const result = await planClosePhotography({
      box, camera: cameraConfig, range,
      lateralOverlap: Number(routeConfig.value.lateralOverlap),
      longitudinalOverlap: Number(routeConfig.value.longitudinalOverlap),
      faces: routeConfig.value.scanFaces,
      raycast: async (origin, direction) => {
        checkCancelled();
        const hit = await pickDetailedModelByRay(new CesiumApi.Ray(origin, direction));
        checkCancelled(); return hit;
      },
      isVisible: hasClearSightToTarget,
      isClear: hasClearFlightSegment,
      isPositionClear: hasPhotoPositionClearance,
      connect: (start, end) => createSafeConnectorPoints(start, end, box, range, Math.min(range, 3)),
      makeWaypoint: (position, target, attributes) => ({
        ...waypointFromCartesian(position), ...attributes,
        ...getTargetFacingOrientation(position, target),
        cartesian: position, targetCartesian: target, speed: props.missionConfig.globalSpeed,
        coordinateSystem: 'WGS84'
      }),
      onProgress: message => { checkCancelled(); setStatus(message); },
      yieldControl: waitForBrowserFrame, checkCancelled
    });
    checkCancelled();
    updateTransitionHeadings(result.points);
    const lateral = Math.round(normalizeOverlapRate(routeConfig.value.lateralOverlap, 80) * 100);
    const longitudinal = Math.round(normalizeOverlapRate(routeConfig.value.longitudinalOverlap, 70) * 100);
    generatedWaypoints = result.points.map((point, index) => toPublicWaypoint(point, index, lateral, longitudinal));
    generatedRouteSegments = [generatedWaypoints];
    closeSurfaceTargets = result.targets;
    generatedSurfaceTargetCartesians = result.targets.map(target => target.position);
    closeDiagnostics.value = { ...result.diagnostics, cameraLabel: cameraConfig.name,
      wallRowSpacing: result.spacing.wallRows, wallPointSpacing: result.spacing.wallPoints };
    routeSummary.surfaceCount = (routeConfig.value.scanFaces || ['front', 'right', 'back', 'left', 'top']).length;
    routeSummary.scanLineCount = result.scanLineCount;
    routeSummary.waypointCount = generatedWaypoints.length;
    drawBoundary(); drawRoute();
    emit('update-route', { waypoints: generatedWaypoints, routeSegments: generatedRouteSegments,
      boundaryPoints: boundaryWaypoints, boundaryGroups: [boundaryWaypoints], routeCount: result.scanLineCount });
    const d = result.diagnostics;
    setStatus(`规划完成：${d.scheduled} 个拍照点，${d.connectorPointCount} 个不拍照过渡点。\n已探测表面中 ${d.uncovered} 点仍待补拍；${d.missing} 条采样射线未命中选定范围内模型。`);
  } catch (error) {
    if (revision === closePlanningRevision && !isViewerUnmounted) {
      closePlanningRevision++;
      generating.value = false;
      setPlanningVisualsVisible(true);
      generatedWaypoints = []; generatedRouteSegments = [];
      emitEmptyRoute(); setStatus(error?.message || '贴近摄影规划失败');
    }
  } finally {
    if (revision === closePlanningRevision && !isViewerUnmounted) {
      generating.value = false; setPlanningVisualsVisible(true); emitState();
    }
    if (!generating.value) { detailedRayCache.clear(); flightSegmentCache.clear(); }
  }
}

async function buildRoute(showStatus = true) {
  if (isClosePlanner.value) return buildClosePhotographyRoute(showStatus);
  clearCoveragePreview();
  if (routeConfig.value.geometryType === 'cylinder') {
    if (boundaryWaypoints.length < CYLINDER_POINT_COUNT) {
      setStatus('需要选择 3 个点才能生成圆柱体航线。');
      return;
    }

    const offset = Math.max(0, Number(routeConfig.value.offset) || 20);
    const lateralSpacing = getFovSpacing(offset, 'lateral');
    const longitudinalSpacing = getFovSpacing(offset, 'longitudinal');
    const cylinder = getCylinderFromThreePoints();

    if (!cylinder) {
      setStatus('无法从 3 个点确定有效圆柱体，请重新选择。');
      return;
    }

    const orbitRoute = generateCylinderOrbitRoute(cylinder, lateralSpacing, longitudinalSpacing, offset);
    const topRoute = generateCylinderTopRoute(cylinder, lateralSpacing, longitudinalSpacing, offset, 20);
    const lateralOverlapPercent = Math.round(normalizeOverlapRate(routeConfig.value.lateralOverlap, 80) * 100);
    const longitudinalOverlapPercent = Math.round(normalizeOverlapRate(routeConfig.value.longitudinalOverlap, 80) * 100);
    const fullRoute = [...orbitRoute.points];
    topRoute.points.forEach((point) => appendPointIfDistinct(fullRoute, point));
    const route = fullRoute.map((point, index) =>
      toPublicWaypoint(point, index, lateralOverlapPercent, longitudinalOverlapPercent)
    );

    if (route.length === 0) {
      setStatus('当前参数下没有生成有效圆柱体航点，请检查半径、高度或重叠率。');
      return;
    }

    generatedWaypoints = route;
    drawing.value = false;
    activeTransformMode = 'none';
    routeSummary.surfaceCount = 2;
    routeSummary.scanLineCount = orbitRoute.ringCount + topRoute.rowCount;
    routeSummary.waypointCount = route.length;
    drawBoundary();
    updateTransformGizmo();
    drawRoute();

    emit('update-route', {
      waypoints: route,
      boundaryPoints: boundaryWaypoints,
      boundaryGroups: boundaryWaypoints.length >= CYLINDER_POINT_COUNT ? [boundaryWaypoints] : [],
      routeCount: orbitRoute.ringCount + topRoute.rowCount
    });

    if (showStatus) {
      setStatus(`圆柱体航线已生成。侧面环绕 ${orbitRoute.ringCount} 圈，顶面扫描 ${topRoute.rowCount} 条，离侧面 ${offset}m，顶面上抬 20m，旁向间距 ${lateralSpacing.toFixed(2)}m，航向间距 ${longitudinalSpacing.toFixed(2)}m，航点 ${route.length} 个。`);
    } else {
      emitState();
    }
    return;
  }

  if (routeConfig.value.geometryType !== 'box') {
    setStatus('当前仅支持长方体几何体航线生成。');
    return;
  }

  const requiredPointCount = getRequiredPointCount();
  if (boundaryWaypoints.length < requiredPointCount) {
    setStatus('需要选择 8 个角点才能生成几何体航线。');
    return;
  }

  const offset = Math.max(0, Number(routeConfig.value.offset) || 20);
  const lateralSpacing = getFovSpacing(offset, 'lateral');
  const longitudinalSpacing = getFovSpacing(offset, 'longitudinal');
  const sourceBox = getActiveBox();

  if (!sourceBox) {
    setStatus('无法从 8 个角点确定有效长方体，请重新选择。');
    return;
  }

  const width = sourceBox.maxX - sourceBox.minX;
  const depth = sourceBox.maxY - sourceBox.minY;
  const height = sourceBox.maxZ - sourceBox.minZ;
  if (width < 0.2 || depth < 0.2 || height < 0.2) {
    setStatus('长方体尺寸太小，无法生成环绕航线。');
    return;
  }

  let orbitRoute;
  let topRoute = { points: [], routeSegments: [], surfacePoints: [], rowCount: 0 };
  const orbitBox = getExpandedBox(sourceBox, offset);
  orbitRoute = generateOrbitRoute(orbitBox, lateralSpacing, longitudinalSpacing);
  topRoute = generateTopSurfaceRoute(sourceBox, lateralSpacing, longitudinalSpacing, 20);

  const lateralOverlapPercent = Math.round(normalizeOverlapRate(routeConfig.value.lateralOverlap, 80) * 100);
  const longitudinalOverlapPercent = Math.round(normalizeOverlapRate(routeConfig.value.longitudinalOverlap, 80) * 100);
  const fullRoute = [...orbitRoute.points];
  topRoute.points.forEach((point) => appendPointIfDistinct(fullRoute, point));
  const route = fullRoute.map((point, index) =>
    toPublicWaypoint(point, index, lateralOverlapPercent, longitudinalOverlapPercent)
  );

  if (route.length === 0) {
    setStatus('当前参数下没有生成有效航点，请检查几何体尺寸或重叠率。');
    return;
  }

  generatedWaypoints = route;
  generatedRouteSegments = [];
  generatedSurfaceTargetCartesians = [];
  drawing.value = false;
  activeTransformMode = 'none';
  routeSummary.surfaceCount = 5;
  routeSummary.scanLineCount = orbitRoute.ringCount + topRoute.rowCount;
  routeSummary.waypointCount = route.length;
  drawBoundary();
  updateTransformGizmo();
  drawRoute();

  emit('update-route', {
    waypoints: route,
    routeSegments: generatedRouteSegments,
    boundaryPoints: boundaryWaypoints,
    boundaryGroups: boundaryWaypoints.length >= getRequiredPointCount() ? [boundaryWaypoints] : [],
    routeCount: orbitRoute.ringCount + topRoute.rowCount
  });

  if (showStatus) {
    setStatus(`几何体航线已生成。侧面环绕 ${orbitRoute.ringCount} 圈，顶面扫描 ${topRoute.rowCount} 条，离侧面 ${offset}m，顶面上抬 20m，旁向间距 ${lateralSpacing.toFixed(2)}m，航向间距 ${longitudinalSpacing.toFixed(2)}m，航点 ${route.length} 个。`);
  } else {
    emitState();
  }
}

const onViewerReady = ({ Cesium, viewer }) => {
  isViewerUnmounted = false;
  CesiumApi = Cesium;
  viewerInstance = viewer;

  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.pickTranslucentDepth = false;
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
  () => JSON.stringify(routeConfig.value),
  (next, previous) => {
    if (previous && JSON.parse(next).geometryType !== JSON.parse(previous).geometryType) {
      clearPlanning(true);
      setStatus(getReadyStatus());
      return;
    }
    if (hasArea.value) {
      clearRouteOnly(true);
      drawBoundary();
      updateTransformGizmo();
      setStatus('几何体参数已更新，请重新点击生成航线。');
    } else {
      setStatus(modelReady.value ? getReadyStatus() : '正在加载 ruansan 三维模型...');
    }
  },
  { deep: true }
);

onBeforeUnmount(() => {
  isViewerUnmounted = true;
  loadingToken += 1;

  if (clickHandler) {
    destroyCesiumObject(clickHandler);
    clickHandler = null;
  }

  clearVisuals();
  removeTileset();
  viewerInstance = null;
  CesiumApi = null;
});

defineExpose({
  fitCamera,
  beginDraw,
  buildRoute,
  clearPlanning,
  selectTransformMode,
  previewCommand
});
</script>

<style scoped>
.geometry-tileset-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: #070b12;
}

.geometry-cesium {
  width: 100%;
  height: 100%;
}

.coverage-overlay { position: absolute; top: 14px; left: 14px; pointer-events: none; padding: 12px 16px; border-radius: 10px; background: rgba(15, 23, 42, .86); color: white; font-size: 13px; line-height: 1.8; box-shadow: 0 3px 12px #0003; }
.coverage-legend { font-size: 12px; color: #d1d5db; }
.unseen-dot { color: #ff6262; } .seen-dot { color: #42ef98; margin-left: 8px; } .frustum-dot { color: #fbbf24; margin-left: 8px; }
</style>
