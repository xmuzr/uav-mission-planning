<template>
  <div class="slope-tileset-viewer">
    <vc-viewer
      class="slope-cesium"
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
const EARTH_RADIUS = 6378137;

const props = defineProps({
  missionConfig: {
    type: Object,
    required: true
  },
  plannerMode: {
    type: String,
    default: 'slope'
  }
});

const emit = defineEmits(['update-route', 'update:missionConfig', 'state-change']);

const routeSummary = reactive({
  scanLineCount: 0,
  waypointCount: 0
});

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

const modelReady = ref(false);
const hasArea = ref(false);
const wireframe = ref(false);
const gridVisible = ref(true);
const autoRotate = ref(false);
const drawing = ref(false);
const statusText = ref('正在加载 ruansan 三维模型...');

const isClosePlanner = computed(() => props.plannerMode === 'close');

const routeConfig = computed(() => {
  if (isClosePlanner.value) {
    const closeRoute = props.missionConfig.closeRoute || {};
    const closeDistance = Number(closeRoute.closeDistance ?? closeRoute.offset);
    return {
      lateralOverlap: 80,
      longitudinalOverlap: 70,
      closeDistance: 5,
      offset: 5,
      modelUrl: DEFAULT_TILESET_URL,
      ...closeRoute,
      offset: Number.isFinite(closeDistance) ? closeDistance : 5
    };
  }

  return {
    lateralOverlap: 80,
    longitudinalOverlap: 80,
    offset: 20,
    reverseSide: false,
    modelUrl: DEFAULT_TILESET_URL,
    ...(props.missionConfig.slopeRoute || {})
  };
});

const modelUrl = computed(() => routeConfig.value.modelUrl || DEFAULT_TILESET_URL);

let CesiumApi = null;
let viewerInstance = null;
let tileset = null;
let clickHandler = null;
let rotateTick = null;
let loadingToken = 0;
let boundaryEntity = null;
let outlineEntity = null;
let routeEntity = null;
let gizmoCenterEntity = null;
let gizmoXAxisLineEntity = null;
let gizmoYAxisLineEntity = null;
let gizmoZAxisLineEntity = null;
let gizmoXAxisHandleEntity = null;
let gizmoYAxisHandleEntity = null;
let gizmoZAxisHandleEntity = null;
let gizmoXAxisRotateEntity = null;
let gizmoYAxisRotateEntity = null;
let gizmoZAxisRotateEntity = null;
let gizmoXAxisRotateHandleEntity = null;
let gizmoYAxisRotateHandleEntity = null;
let gizmoZAxisRotateHandleEntity = null;
let pointEntities = [];
let boundaryCartesians = [];
let boundaryWaypoints = [];
let generatedWaypoints = [];
let routeNormalSign = null;
let activeTransformMode = 'none';
let activeTransformAxis = null;
let transformDragAxisVector = null;
let transformDragging = false;
let transformDragPlane = null;
let transformDragStartPoint = null;
let transformDragStartBoundary = [];
let transformDragReferenceVector = null;
let suppressNextClick = false;
let lastPickPosition = null;

const emitState = () => {
  emit('state-change', {
    modelReady: modelReady.value,
    hasArea: hasArea.value,
    transformMode: activeTransformMode,
    wireframe: wireframe.value,
    gridVisible: gridVisible.value,
    autoRotate: autoRotate.value,
    statusText: statusText.value,
    routeSummary: {
      scanLineCount: routeSummary.scanLineCount,
      waypointCount: routeSummary.waypointCount
    }
  });
};

const setStatus = (message) => {
  statusText.value = message;
  emitState();
};

const emitEmptyRoute = () => {
  emit('update-route', {
    waypoints: [],
    boundaryPoints: [],
    routeCount: 0
  });
};

const clearEntity = (entity) => {
  if (viewerInstance && entity) {
    viewerInstance.entities.remove(entity);
  }
};

const clearVisuals = () => {
  clearEntity(boundaryEntity);
  clearEntity(outlineEntity);
  clearEntity(routeEntity);
  clearEntity(gizmoCenterEntity);
  clearEntity(gizmoXAxisLineEntity);
  clearEntity(gizmoYAxisLineEntity);
  clearEntity(gizmoZAxisLineEntity);
  clearEntity(gizmoXAxisHandleEntity);
  clearEntity(gizmoYAxisHandleEntity);
  clearEntity(gizmoZAxisHandleEntity);
  pointEntities.forEach(clearEntity);
  boundaryEntity = null;
  outlineEntity = null;
  routeEntity = null;
  gizmoCenterEntity = null;
  gizmoXAxisLineEntity = null;
  gizmoYAxisLineEntity = null;
  gizmoZAxisLineEntity = null;
  gizmoXAxisHandleEntity = null;
  gizmoYAxisHandleEntity = null;
  gizmoZAxisHandleEntity = null;
  pointEntities = [];
};

const clearRouteOnly = (emitEmpty = true) => {
  clearEntity(routeEntity);
  routeEntity = null;
  generatedWaypoints = [];
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;

  if (emitEmpty) {
    emitEmptyRoute();
  }
};

const clearTransformGizmo = () => {
  clearEntity(gizmoCenterEntity);
  clearEntity(gizmoXAxisLineEntity);
  clearEntity(gizmoYAxisLineEntity);
  clearEntity(gizmoZAxisLineEntity);
  clearEntity(gizmoXAxisHandleEntity);
  clearEntity(gizmoYAxisHandleEntity);
  clearEntity(gizmoZAxisHandleEntity);
  clearEntity(gizmoXAxisRotateEntity);
  clearEntity(gizmoYAxisRotateEntity);
  clearEntity(gizmoZAxisRotateEntity);
  clearEntity(gizmoXAxisRotateHandleEntity);
  clearEntity(gizmoYAxisRotateHandleEntity);
  clearEntity(gizmoZAxisRotateHandleEntity);
  gizmoCenterEntity = null;
  gizmoXAxisLineEntity = null;
  gizmoYAxisLineEntity = null;
  gizmoZAxisLineEntity = null;
  gizmoXAxisHandleEntity = null;
  gizmoYAxisHandleEntity = null;
  gizmoZAxisHandleEntity = null;
  gizmoXAxisRotateEntity = null;
  gizmoYAxisRotateEntity = null;
  gizmoZAxisRotateEntity = null;
  gizmoXAxisRotateHandleEntity = null;
  gizmoYAxisRotateHandleEntity = null;
  gizmoZAxisRotateHandleEntity = null;
};

function clearPlanning(emitEmpty = false) {
  clearVisuals();
  clearTransformGizmo();
  boundaryCartesians = [];
  boundaryWaypoints = [];
  generatedWaypoints = [];
  routeNormalSign = null;
  drawing.value = false;
  hasArea.value = false;
  activeTransformMode = 'none';
  activeTransformAxis = null;
  transformDragAxisVector = null;
  transformDragging = false;
  transformDragPlane = null;
  transformDragStartPoint = null;
  transformDragStartBoundary = [];
  transformDragReferenceVector = null;
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;

  if (emitEmpty) {
    emitEmptyRoute();
  }

  setStatus(modelReady.value ? 'ruansan 模型已就绪。' : '正在加载 ruansan 三维模型...');
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
      console.warn('pickFromRay failed, falling back to depth picking', error);
    }
  }

  const position = hit?.position || hit?.cartesian || hit?.object?.position || hit;
  if (CesiumApi.defined(position)) {
    return position;
  }

  const globePosition = scene.globe?.pick(ray, scene);
  if (CesiumApi.defined(globePosition)) {
    return globePosition;
  }

  return null;
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
    setStatus('ruansan 模型已加载，可以绘制测区。');
  } catch (error) {
    console.error('Failed to load slope tileset', error);
    modelReady.value = false;
    setStatus(`模型加载失败: ${error?.message || error}`);
  }
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
      }
    })
  );

  if (boundaryCartesians.length >= 2) {
    const linePositions = [...boundaryCartesians];
    if (boundaryCartesians.length >= 3) {
      linePositions.push(boundaryCartesians[0]);
    }

    outlineEntity = viewerInstance.entities.add({
      polyline: {
        positions: linePositions,
        width: 3,
        material: CesiumApi.Color.fromCssColorString('#ffd447'),
        clampToGround: false
      }
    });
  }

  if (boundaryCartesians.length >= 3) {
    boundaryEntity = viewerInstance.entities.add({
      polygon: {
        hierarchy: new CesiumApi.PolygonHierarchy(boundaryCartesians),
        material: CesiumApi.Color.fromCssColorString('#2c8cff').withAlpha(0.24),
        perPositionHeight: true
      }
    });
  }

  if (activeTransformMode !== 'none' && hasArea.value) {
    updateTransformGizmo();
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

const normalizePlaneNormal = (normal) => {
  if (!CesiumApi || !normal) return null;
  const length = CesiumApi.Cartesian3.magnitude(normal);
  if (length < 1e-8) return null;
  return CesiumApi.Cartesian3.divideByScalar(normal, length, new CesiumApi.Cartesian3());
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

  const unitNormal = normalizePlaneNormal(normal);
  if (!unitNormal) return null;

  return {
    origin: centroid,
    normal: unitNormal
  };
};

const projectPointToPlane = (point, plane) => {
  if (!CesiumApi || !point || !plane) return point;

  const offset = CesiumApi.Cartesian3.subtract(
    point,
    plane.origin,
    new CesiumApi.Cartesian3()
  );
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

const getAxisFrame = (center) => {
  if (!CesiumApi || !center) return null;
  const frame = CesiumApi.Transforms.eastNorthUpToFixedFrame(center);
  return {
    frame,
    origin: CesiumApi.Matrix4.getTranslation(frame, new CesiumApi.Cartesian3()),
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

const buildPlaneFrame = (origin, normal) => {
  if (!CesiumApi || !origin || !normal) return null;

  const unitNormal = normalizePlaneNormal(normal);
  if (!unitNormal) return null;

  const enu = getAxisFrame(origin);
  if (!enu) return null;

  const up = CesiumApi.Ellipsoid.WGS84.geodeticSurfaceNormal(
    origin,
    new CesiumApi.Cartesian3()
  );
  let verticalAxis = CesiumApi.Cartesian3.subtract(
    up,
    CesiumApi.Cartesian3.multiplyByScalar(
      unitNormal,
      CesiumApi.Cartesian3.dot(up, unitNormal),
      new CesiumApi.Cartesian3()
    ),
    new CesiumApi.Cartesian3()
  );

  if (CesiumApi.Cartesian3.magnitudeSquared(verticalAxis) < 1e-8) {
    verticalAxis = CesiumApi.Cartesian3.clone(enu.yAxis, new CesiumApi.Cartesian3());
  }
  CesiumApi.Cartesian3.normalize(verticalAxis, verticalAxis);

  let horizontalAxis = CesiumApi.Cartesian3.cross(
    verticalAxis,
    unitNormal,
    new CesiumApi.Cartesian3()
  );
  if (CesiumApi.Cartesian3.magnitudeSquared(horizontalAxis) < 1e-8) {
    horizontalAxis = CesiumApi.Cartesian3.clone(enu.xAxis, new CesiumApi.Cartesian3());
  }
  CesiumApi.Cartesian3.normalize(horizontalAxis, horizontalAxis);

  verticalAxis = CesiumApi.Cartesian3.cross(
    unitNormal,
    horizontalAxis,
    new CesiumApi.Cartesian3()
  );
  CesiumApi.Cartesian3.normalize(verticalAxis, verticalAxis);

  return {
    origin,
    normal: unitNormal,
    horizontalAxis,
    verticalAxis,
    xAxis: horizontalAxis,
    yAxis: verticalAxis,
    zAxis: unitNormal
  };
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

const getSlopePlaneFrame = () => {
  if (!CesiumApi || boundaryCartesians.length < 3) return null;

  const plane = computeBoundaryPlane();
  if (!plane) return null;

  // Choose the initial side once per area. Moving the camera must not change
  // the meaning of the reverse button on subsequent generations.
  if (routeNormalSign === null) {
    const facingNormal = orientNormalTowardCamera(plane);
    routeNormalSign = CesiumApi.Cartesian3.dot(facingNormal, plane.normal) < 0 ? -1 : 1;
  }
  const normal = CesiumApi.Cartesian3.multiplyByScalar(
    plane.normal, routeNormalSign, new CesiumApi.Cartesian3()
  );
  const frame = buildPlaneFrame(plane.origin, normal);
  if (frame && routeConfig.value.reverseSide) {
    // Preserve the scan axes and order, flipping only the offset and the
    // direction the camera faces toward the selected surface.
    CesiumApi.Cartesian3.negate(frame.normal, frame.normal);
  }
  return frame;
};

// Transform gizmos should stay aligned to the wall itself, not the current camera.
const getTransformPlaneFrame = () => {
  if (!CesiumApi || boundaryCartesians.length < 3) return null;

  const plane = computeBoundaryPlane();
  if (!plane) return null;

  return buildPlaneFrame(plane.origin, plane.normal);
};

const getTransformAxisVector = (frame, axisName) => {
  if (!frame) return null;

  if (axisName === 'x') return frame.xAxis;
  if (axisName === 'y') return frame.yAxis;
  return frame.zAxis;
};

const cartesianToPlaneMeters = (point, frame) => {
  const vector = CesiumApi.Cartesian3.subtract(
    point,
    frame.origin,
    new CesiumApi.Cartesian3()
  );

  return {
    x: CesiumApi.Cartesian3.dot(vector, frame.horizontalAxis),
    y: CesiumApi.Cartesian3.dot(vector, frame.verticalAxis)
  };
};

const planeMetersToCartesian = (point, frame, wallDistance = 0) => {
  const horizontal = CesiumApi.Cartesian3.multiplyByScalar(
    frame.horizontalAxis,
    point.x,
    new CesiumApi.Cartesian3()
  );
  const vertical = CesiumApi.Cartesian3.multiplyByScalar(
    frame.verticalAxis,
    point.y,
    new CesiumApi.Cartesian3()
  );
  const distance = CesiumApi.Cartesian3.multiplyByScalar(
    frame.normal,
    wallDistance,
    new CesiumApi.Cartesian3()
  );

  return CesiumApi.Cartesian3.add(
    frame.origin,
    CesiumApi.Cartesian3.add(
      horizontal,
      CesiumApi.Cartesian3.add(vertical, distance, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    ),
    new CesiumApi.Cartesian3()
  );
};

const planeMetersToPseudoGeo = (point) => ({
  lng: point.x / EARTH_RADIUS * 180 / Math.PI,
  lat: point.y / EARTH_RADIUS * 180 / Math.PI,
  height: 0
});

const pseudoGeoToPlaneMeters = (point) => ({
  x: point.lng * Math.PI / 180 * EARTH_RADIUS,
  y: point.lat * Math.PI / 180 * EARTH_RADIUS
});

const clampGimbalPitch = (angle) => {
  const min = isClosePlanner.value ? -10 : -90;
  const max = isClosePlanner.value ? 20 : 30;
  return Math.min(Math.max(angle, min), max);
};

const getWallFacingOrientation = (dronePosition, frame) => {
  const wallTarget = CesiumApi.Cartesian3.subtract(
    dronePosition,
    CesiumApi.Cartesian3.multiplyByScalar(frame.normal, 10, new CesiumApi.Cartesian3()),
    new CesiumApi.Cartesian3()
  );

  const localFrame = getAxisFrame(dronePosition);
  if (!localFrame) {
    return {
      directionAngle: 0,
      gimbalPitch: 0
    };
  }

  const directionVector = CesiumApi.Cartesian3.subtract(
    wallTarget,
    dronePosition,
    new CesiumApi.Cartesian3()
  );
  const east = CesiumApi.Cartesian3.dot(directionVector, localFrame.xAxis);
  const north = CesiumApi.Cartesian3.dot(directionVector, localFrame.yAxis);
  const up = CesiumApi.Cartesian3.dot(directionVector, localFrame.zAxis);
  const horizontalDistance = Math.hypot(east, north);

  return {
    directionAngle: horizontalDistance > 1e-6
      ? getBearingDegrees(
        waypointFromCartesian(dronePosition),
        waypointFromCartesian(wallTarget)
      )
      : 0,
    gimbalPitch: clampGimbalPitch(
      Math.atan2(up, Math.max(horizontalDistance, 1e-6)) * 180 / Math.PI
    )
  };
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

const getSlopeCamera = () => {
  return CAMERA_PRESETS[props.missionConfig.aircraftModel] || CAMERA_PRESETS.m30t;
};

const getFovSpacing = (wallDistance, direction) => {
  const camera = getSlopeCamera();
  const overlapKey = direction === 'longitudinal' ? 'longitudinalOverlap' : 'lateralOverlap';
  const fallback = isClosePlanner.value
    ? (direction === 'longitudinal' ? 70 : 80)
    : 80;
  const overlapRate = normalizeOverlapRate(routeConfig.value[overlapKey], fallback);
  const distance = Math.max(Number(wallDistance) || 0, 0.1);
  return Math.max(0.1, calculateSpacing(distance, camera, overlapRate, direction));
};

const densifyPseudoRouteByDistance = (route, pointDistance) => {
  if (!Array.isArray(route) || route.length < 2 || pointDistance <= 0) {
    return route;
  }

  const densified = [];
  for (let i = 0; i + 1 < route.length; i += 2) {
    const start = pseudoGeoToPlaneMeters(route[i]);
    const end = pseudoGeoToPlaneMeters(route[i + 1]);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(length / pointDistance));

    for (let step = 0; step <= steps; step += 1) {
      if (i > 0 && step === 0) {
        continue;
      }
      const t = step / steps;
      densified.push(planeMetersToPseudoGeo({
        x: start.x + dx * t,
        y: start.y + dy * t
      }));
    }
  }

  return densified;
};

const generateStraightPlaneRoute = (planeBoundary, lateralSpacing, longitudinalSpacing) => {
  if (!Array.isArray(planeBoundary) || planeBoundary.length < 3) {
    return { points: [], routeCount: 0 };
  }

  const xs = planeBoundary.map((point) => point.x);
  const ys = planeBoundary.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;

  if (width < 0.2 || height < 0.2) {
    return { points: [], routeCount: 0 };
  }

  const rowSpacing = Math.max(0.1, Number(lateralSpacing) || 0.1);
  const pointSpacing = Math.max(0.1, Number(longitudinalSpacing) || 0.1);
  const yValues = [];

  if (height <= rowSpacing) {
    yValues.push((minY + maxY) / 2);
  } else {
    for (let y = maxY - rowSpacing / 2; y >= minY + rowSpacing / 2; y -= rowSpacing) {
      yValues.push(y);
    }
  }

  if (yValues.length === 0) {
    yValues.push((minY + maxY) / 2);
  }

  const points = [];
  yValues.forEach((y, rowIndex) => {
    const leftToRight = rowIndex % 2 === 0;
    const startX = leftToRight ? minX : maxX;
    const endX = leftToRight ? maxX : minX;
    const steps = Math.max(1, Math.ceil(width / pointSpacing));

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      points.push({
        x: startX + (endX - startX) * t,
        y
      });
    }
  });

  return {
    points,
    routeCount: yValues.length
  };
};

const buildRingPositions = (center, axisA, axisB, radius, segments = 96) => {
  const positions = [];

  for (let i = 0; i <= segments; i += 1) {
    const angle = i / segments * Math.PI * 2;
    const offsetA = CesiumApi.Cartesian3.multiplyByScalar(
      axisA,
      Math.cos(angle) * radius,
      new CesiumApi.Cartesian3()
    );
    const offsetB = CesiumApi.Cartesian3.multiplyByScalar(
      axisB,
      Math.sin(angle) * radius,
      new CesiumApi.Cartesian3()
    );

    positions.push(
      CesiumApi.Cartesian3.add(
        center,
        CesiumApi.Cartesian3.add(offsetA, offsetB, new CesiumApi.Cartesian3()),
        new CesiumApi.Cartesian3()
      )
    );
  }

  return positions;
};

const createTransformHandle = (position, label, color, size = 14) => viewerInstance.entities.add({
  position,
  point: {
    pixelSize: size,
    color: CesiumApi.Color.fromCssColorString(color),
    outlineColor: CesiumApi.Color.BLACK,
    outlineWidth: 2,
    disableDepthTestDistance: Number.POSITIVE_INFINITY
  },
  label: {
    text: label,
    font: '13px sans-serif',
    fillColor: CesiumApi.Color.fromCssColorString(color),
    outlineColor: CesiumApi.Color.BLACK,
    outlineWidth: 2,
    pixelOffset: new CesiumApi.Cartesian2(14, -14),
    disableDepthTestDistance: Number.POSITIVE_INFINITY
  }
});

const createTranslationGizmo = (center, frame, axisLength) => {
  const makeEnd = (axis, length) =>
    CesiumApi.Cartesian3.add(
      center,
      CesiumApi.Cartesian3.multiplyByScalar(axis, length, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    );

  gizmoCenterEntity = viewerInstance.entities.add({
    position: center,
    point: {
      pixelSize: 10,
      color: CesiumApi.Color.WHITE,
      outlineColor: CesiumApi.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: {
      text: 'O',
      font: '12px sans-serif',
      fillColor: CesiumApi.Color.WHITE,
      outlineColor: CesiumApi.Color.BLACK,
      outlineWidth: 2,
      pixelOffset: new CesiumApi.Cartesian2(12, -12),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  });

  gizmoXAxisLineEntity = viewerInstance.entities.add({
    polyline: {
      positions: [center, makeEnd(frame.xAxis, axisLength)],
      width: 3,
      material: CesiumApi.Color.fromCssColorString('#ff4d4f'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });
  gizmoYAxisLineEntity = viewerInstance.entities.add({
    polyline: {
      positions: [center, makeEnd(frame.yAxis, axisLength)],
      width: 3,
      material: CesiumApi.Color.fromCssColorString('#3ddc84'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });
  gizmoZAxisLineEntity = viewerInstance.entities.add({
    polyline: {
      positions: [center, makeEnd(frame.zAxis, axisLength)],
      width: 3,
      material: CesiumApi.Color.fromCssColorString('#4da3ff'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });

  gizmoXAxisHandleEntity = createTransformHandle(makeEnd(frame.xAxis, axisLength), 'X', '#ff4d4f');
  gizmoYAxisHandleEntity = createTransformHandle(makeEnd(frame.yAxis, axisLength), 'Y', '#3ddc84');
  gizmoZAxisHandleEntity = createTransformHandle(makeEnd(frame.zAxis, axisLength), 'Z', '#4da3ff');
};

const createRotationGizmo = (center, frame, axisLength) => {
  const radius = Math.max(axisLength * 0.82, 10);

  gizmoXAxisRotateEntity = viewerInstance.entities.add({
    polyline: {
      positions: buildRingPositions(center, frame.yAxis, frame.zAxis, radius),
      width: 4,
      material: CesiumApi.Color.fromCssColorString('#ff4d4f'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });
  gizmoYAxisRotateEntity = viewerInstance.entities.add({
    polyline: {
      positions: buildRingPositions(center, frame.xAxis, frame.zAxis, radius),
      width: 4,
      material: CesiumApi.Color.fromCssColorString('#3ddc84'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });
  gizmoZAxisRotateEntity = viewerInstance.entities.add({
    polyline: {
      positions: buildRingPositions(center, frame.xAxis, frame.yAxis, radius),
      width: 4,
      material: CesiumApi.Color.fromCssColorString('#4da3ff'),
      arcType: CesiumApi.ArcType.NONE,
      clampToGround: false
    }
  });

  gizmoXAxisRotateHandleEntity = createTransformHandle(
    CesiumApi.Cartesian3.add(
      center,
      CesiumApi.Cartesian3.multiplyByScalar(frame.yAxis, radius, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    ),
    'X',
    '#ff4d4f',
    12
  );
  gizmoYAxisRotateHandleEntity = createTransformHandle(
    CesiumApi.Cartesian3.add(
      center,
      CesiumApi.Cartesian3.multiplyByScalar(frame.zAxis, radius, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    ),
    'Y',
    '#3ddc84',
    12
  );
  gizmoZAxisRotateHandleEntity = createTransformHandle(
    CesiumApi.Cartesian3.add(
      center,
      CesiumApi.Cartesian3.multiplyByScalar(frame.xAxis, radius, new CesiumApi.Cartesian3()),
      new CesiumApi.Cartesian3()
    ),
    'Z',
    '#4da3ff',
    12
  );
};

const updateTransformGizmo = () => {
  if (!viewerInstance || !CesiumApi) return;

  clearTransformGizmo();

  if (!hasArea.value || activeTransformMode === 'none') return;

  const center = getBoundaryCentroid();
  const frame = getTransformPlaneFrame();
  if (!center || !frame) return;

  const axisLength = Math.max(12, Math.min(32, Math.sqrt(boundaryCartesians.length) * 12));

  if (activeTransformMode === 'translate') {
    createTranslationGizmo(center, frame, axisLength);
  } else if (activeTransformMode === 'rotate') {
    createRotationGizmo(center, frame, axisLength);
  }
};

const emitBoundaryState = () => {
  if (!boundaryWaypoints.length) {
    emitEmptyRoute();
    return;
  }

  emit('update-route', {
    waypoints: [],
    boundaryPoints: boundaryWaypoints,
    routeCount: 0
  });
};

const applyBoundaryTranslation = (deltaVector) => {
  if (!CesiumApi || !deltaVector || boundaryCartesians.length === 0) return;

  boundaryCartesians = transformDragStartBoundary.map((point) =>
    CesiumApi.Cartesian3.add(point, deltaVector, new CesiumApi.Cartesian3())
  );
  flattenBoundaryToPlane();
  boundaryWaypoints = boundaryCartesians.map(waypointFromCartesian);
  generatedWaypoints = [];
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;
  hasArea.value = boundaryWaypoints.length >= 3;
  clearRouteOnly(true);
  drawBoundary();
  updateTransformGizmo();
  emitBoundaryState();
};

const rotateCartesianAroundAxis = (point, origin, axis, angle) => {
  const offset = CesiumApi.Cartesian3.subtract(point, origin, new CesiumApi.Cartesian3());
  const quaternion = CesiumApi.Quaternion.fromAxisAngle(axis, angle, new CesiumApi.Quaternion());
  const rotationMatrix = CesiumApi.Matrix3.fromQuaternion(quaternion, new CesiumApi.Matrix3());
  const rotatedOffset = CesiumApi.Matrix3.multiplyByVector(rotationMatrix, offset, new CesiumApi.Cartesian3());
  return CesiumApi.Cartesian3.add(origin, rotatedOffset, new CesiumApi.Cartesian3());
};

const applyBoundaryRotation = (angle) => {
  if (!CesiumApi || !transformDragAxisVector || !transformDragStartPoint || boundaryCartesians.length === 0) return;

  boundaryCartesians = transformDragStartBoundary.map((point) =>
    rotateCartesianAroundAxis(point, transformDragStartPoint, transformDragAxisVector, angle)
  );
  boundaryWaypoints = boundaryCartesians.map(waypointFromCartesian);
  generatedWaypoints = [];
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;
  hasArea.value = boundaryWaypoints.length >= 3;
  clearRouteOnly(true);
  drawBoundary();
  updateTransformGizmo();
  emitBoundaryState();
};

const getPlaneIntersection = (windowPosition, plane) => {
  if (!viewerInstance || !CesiumApi || !windowPosition || !plane) return null;

  const ray = viewerInstance.camera.getPickRay(windowPosition);
  if (!ray) return null;

  return CesiumApi.IntersectionTests.rayPlane(ray, plane, new CesiumApi.Cartesian3());
};

const getMovementPlane = (axisVector) => {
  if (!CesiumApi || !viewerInstance || !axisVector || !transformDragStartPoint) return null;

  const cameraDirection = CesiumApi.Cartesian3.normalize(
    viewerInstance.camera.directionWC,
    new CesiumApi.Cartesian3()
  );
  let normal = CesiumApi.Cartesian3.cross(axisVector, cameraDirection, new CesiumApi.Cartesian3());
  if (CesiumApi.Cartesian3.magnitudeSquared(normal) < 1e-8) {
    normal = CesiumApi.Cartesian3.cross(axisVector, viewerInstance.camera.upWC, new CesiumApi.Cartesian3());
  }
  if (CesiumApi.Cartesian3.magnitudeSquared(normal) < 1e-8) {
    return null;
  }
  CesiumApi.Cartesian3.normalize(normal, normal);
  return CesiumApi.Plane.fromPointNormal(transformDragStartPoint, normal);
};

const getPickedEntity = (position) => {
  if (!viewerInstance || !CesiumApi || !position) return null;
  const picked = viewerInstance.scene.pick(position);
  if (!CesiumApi.defined(picked) || !picked.id) return null;
  return picked.id;
};

const getTranslationHandle = (position) => {
  const entity = getPickedEntity(position);
  if (!entity) return null;
  if (entity === gizmoXAxisHandleEntity) return 'x';
  if (entity === gizmoYAxisHandleEntity) return 'y';
  if (entity === gizmoZAxisHandleEntity) return 'z';
  return null;
};

const getRotationHandle = (position) => {
  const entity = getPickedEntity(position);
  if (!entity) return null;
  if (entity === gizmoXAxisRotateEntity || entity === gizmoXAxisRotateHandleEntity) return 'x';
  if (entity === gizmoYAxisRotateEntity || entity === gizmoYAxisRotateHandleEntity) return 'y';
  if (entity === gizmoZAxisRotateEntity || entity === gizmoZAxisRotateHandleEntity) return 'z';
  return null;
};

const startTranslationDrag = (axisName) => {
  if (!CesiumApi || !boundaryCartesians.length) return;

  const center = getBoundaryCentroid();
  const frame = getTransformPlaneFrame();
  if (!center || !frame) return;

  activeTransformAxis = axisName;
  transformDragging = true;
  transformDragStartPoint = CesiumApi.Cartesian3.clone(center, new CesiumApi.Cartesian3());
  transformDragStartBoundary = boundaryCartesians.map((point) =>
    CesiumApi.Cartesian3.clone(point, new CesiumApi.Cartesian3())
  );

  const axisVector = getTransformAxisVector(frame, axisName);
  transformDragAxisVector = CesiumApi.Cartesian3.clone(axisVector, new CesiumApi.Cartesian3());
  transformDragPlane = getMovementPlane(axisVector);
  viewerInstance.scene.screenSpaceCameraController.enableRotate = false;
  viewerInstance.scene.screenSpaceCameraController.enableTranslate = false;
  viewerInstance.scene.screenSpaceCameraController.enableZoom = false;
  viewerInstance.scene.screenSpaceCameraController.enableTilt = false;
  clearRouteOnly(true);
  setStatus(`已进入 ${axisName.toUpperCase()} 轴移动模式，拖动手柄调整测区位置。`);
};

const startRotationDrag = (axisName, windowPosition) => {
  if (!CesiumApi || !boundaryCartesians.length) return;

  const center = getBoundaryCentroid();
  const frame = getTransformPlaneFrame();
  if (!center || !frame) return;

  const axisVector = getTransformAxisVector(frame, axisName);
  const rotationPlane = CesiumApi.Plane.fromPointNormal(center, axisVector);
  const intersection = getPlaneIntersection(windowPosition, rotationPlane);
  const referenceVector = intersection
    ? normalizePlaneNormal(
      CesiumApi.Cartesian3.subtract(intersection, center, new CesiumApi.Cartesian3())
    )
    : null;

  if (!referenceVector) {
    setStatus('未能捕获旋转控制环，请重试。');
    return;
  }

  activeTransformAxis = axisName;
  transformDragging = true;
  transformDragStartPoint = CesiumApi.Cartesian3.clone(center, new CesiumApi.Cartesian3());
  transformDragStartBoundary = boundaryCartesians.map((point) =>
    CesiumApi.Cartesian3.clone(point, new CesiumApi.Cartesian3())
  );
  transformDragAxisVector = CesiumApi.Cartesian3.clone(axisVector, new CesiumApi.Cartesian3());
  transformDragPlane = rotationPlane;
  transformDragReferenceVector = referenceVector;
  viewerInstance.scene.screenSpaceCameraController.enableRotate = false;
  viewerInstance.scene.screenSpaceCameraController.enableTranslate = false;
  viewerInstance.scene.screenSpaceCameraController.enableZoom = false;
  viewerInstance.scene.screenSpaceCameraController.enableTilt = false;
  clearRouteOnly(true);
  setStatus(`已进入 ${axisName.toUpperCase()} 轴旋转模式，拖拽控制环旋转测区。`);
};

const stopTransformDrag = () => {
  if (!transformDragging) return;

  const completedMode = activeTransformMode;
  transformDragging = false;
  activeTransformAxis = null;
  transformDragAxisVector = null;
  transformDragPlane = null;
  transformDragStartPoint = null;
  transformDragStartBoundary = [];
  transformDragReferenceVector = null;
  suppressNextClick = false;
  if (viewerInstance) {
    viewerInstance.scene.screenSpaceCameraController.enableRotate = true;
    viewerInstance.scene.screenSpaceCameraController.enableTranslate = true;
    viewerInstance.scene.screenSpaceCameraController.enableZoom = true;
    viewerInstance.scene.screenSpaceCameraController.enableTilt = true;
  }
  setStatus(
    completedMode === 'rotate'
      ? '测区已旋转完成，可以继续调整参数或直接生成航线。'
      : '测区已移动完成，可以继续调整参数或直接生成航线。'
  );
};

const handleTranslationDragMove = (movement) => {
  if (!transformDragging || !activeTransformAxis || !transformDragPlane || !viewerInstance || !CesiumApi) return;

  lastPickPosition = movement.endPosition;
  const intersection = getPlaneIntersection(movement.endPosition, transformDragPlane);
  if (!intersection) return;

  const delta = CesiumApi.Cartesian3.subtract(
    intersection,
    transformDragStartPoint,
    new CesiumApi.Cartesian3()
  );
  const axisVector = transformDragAxisVector;
  if (!axisVector) return;
  const magnitude = CesiumApi.Cartesian3.dot(delta, axisVector);
  const translation = CesiumApi.Cartesian3.multiplyByScalar(
    axisVector,
    magnitude,
    new CesiumApi.Cartesian3()
  );

  applyBoundaryTranslation(translation);
};

const handleRotationDragMove = (movement) => {
  if (!transformDragging || !transformDragPlane || !transformDragReferenceVector || !transformDragAxisVector) return;

  lastPickPosition = movement.endPosition;
  const intersection = getPlaneIntersection(movement.endPosition, transformDragPlane);
  if (!intersection) return;

  const currentVector = normalizePlaneNormal(
    CesiumApi.Cartesian3.subtract(intersection, transformDragStartPoint, new CesiumApi.Cartesian3())
  );
  if (!currentVector) return;

  const cross = CesiumApi.Cartesian3.cross(
    transformDragReferenceVector,
    currentVector,
    new CesiumApi.Cartesian3()
  );
  const dot = Math.min(
    Math.max(CesiumApi.Cartesian3.dot(transformDragReferenceVector, currentVector), -1),
    1
  );
  const signedAngle = Math.atan2(
    CesiumApi.Cartesian3.dot(transformDragAxisVector, cross),
    dot
  );

  applyBoundaryRotation(signedAngle);
};

const handleTransformDragMove = (movement) => {
  if (activeTransformMode === 'rotate') {
    handleRotationDragMove(movement);
    return;
  }

  handleTranslationDragMove(movement);
};

const onCanvasClick = (movement) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }

  if (transformDragging) {
    return;
  }

  if (!drawing.value || !modelReady.value) return;

  const cartesian = getPickCartesian(movement.position);
  if (!cartesian) {
    setStatus('没有拾取到模型表面，请靠近 ruansan 模型再点击。');
    return;
  }

  boundaryCartesians.push(cartesian);
  boundaryWaypoints.push(waypointFromCartesian(cartesian));
  if (boundaryCartesians.length >= 3) {
    flattenBoundaryToPlane();
    boundaryWaypoints = boundaryCartesians.map(waypointFromCartesian);
  }
  hasArea.value = boundaryWaypoints.length >= 3;
  drawBoundary();

  setStatus(
    hasArea.value
      ? `已选择 ${boundaryWaypoints.length} 个测区点，可以生成航线。`
      : `已选择 ${boundaryWaypoints.length} 个测区点。`
  );
};

const setupClickHandler = () => {
  if (!viewerInstance || !CesiumApi) return;

  if (clickHandler) {
    clickHandler.destroy();
  }

  clickHandler = new CesiumApi.ScreenSpaceEventHandler(viewerInstance.scene.canvas);
  clickHandler.setInputAction(onCanvasClick, CesiumApi.ScreenSpaceEventType.LEFT_CLICK);
  clickHandler.setInputAction((movement) => {
    if (!hasArea.value || transformDragging) return;

    if (activeTransformMode === 'translate') {
      const axis = getTranslationHandle(movement.position);
      if (!axis) return;
      suppressNextClick = true;
      startTranslationDrag(axis);
      return;
    }

    if (activeTransformMode === 'rotate') {
      const axis = getRotationHandle(movement.position);
      if (!axis) return;
      suppressNextClick = true;
      startRotationDrag(axis, movement.position);
    }
  }, CesiumApi.ScreenSpaceEventType.LEFT_DOWN);
  clickHandler.setInputAction((movement) => {
    if (!transformDragging) return;
    handleTransformDragMove(movement);
  }, CesiumApi.ScreenSpaceEventType.MOUSE_MOVE);
  clickHandler.setInputAction(() => {
    if (!transformDragging) return;
    stopTransformDrag();
  }, CesiumApi.ScreenSpaceEventType.LEFT_UP);
};

function fitCamera() {
  if (!viewerInstance) return;

  if (tileset) {
    viewerInstance.zoomTo(tileset);
  } else if (boundaryEntity || routeEntity) {
    viewerInstance.zoomTo(routeEntity || boundaryEntity);
  }
}

function beginDraw() {
  if (!modelReady.value) {
    setStatus('模型还没有加载完成。');
    return;
  }

  clearPlanning(true);
  drawing.value = true;
  setStatus('请在 ruansan 模型上点击测区边界点，至少 3 个点。');
}

function selectTransformMode(mode = 'translate') {
  if (!hasArea.value) {
    setStatus('请先完成测区绘制。');
    return;
  }

  if (!['translate', 'rotate'].includes(mode)) {
    return;
  }

  if (transformDragging) {
    stopTransformDrag();
  }

  drawing.value = false;
  activeTransformMode = mode;
  updateTransformGizmo();
  setStatus(
    mode === 'rotate'
      ? '已切换到旋转模式，拖拽控制环旋转测区。'
      : '已切换到平移模式，拖拽 X/Y/Z 坐标轴平移测区。'
  );
}

const buildLocalFrame = () => {
  const avgLng = boundaryWaypoints.reduce((sum, point) => sum + point.lng, 0) / boundaryWaypoints.length;
  const avgLat = boundaryWaypoints.reduce((sum, point) => sum + point.lat, 0) / boundaryWaypoints.length;
  const avgHeight = boundaryWaypoints.reduce((sum, point) => sum + point.height, 0) / boundaryWaypoints.length;
  const latRad = avgLat * Math.PI / 180;
  const metersPerLng = EARTH_RADIUS * Math.cos(latRad) * Math.PI / 180;
  const metersPerLat = EARTH_RADIUS * Math.PI / 180;
  const scale = Math.max(0.0001, Number(routeConfig.value.scale) || 1);

  return {
    originLng: avgLng,
    originLat: avgLat,
    height: avgHeight,
    toLocal: (point) => ({
      x: ((point.lng - avgLng) * metersPerLng) / scale,
      y: ((point.lat - avgLat) * metersPerLat) / scale,
      height: point.height
    }),
    toWaypoint: (point) => ({
      lng: avgLng + (point.x * scale) / metersPerLng,
      lat: avgLat + (point.y * scale) / metersPerLat,
      height: avgHeight,
      speed: props.missionConfig.globalSpeed,
      action: 'none'
    })
  };
};

const intersectScanLine = (polygon, across, along, distance) => {
  const intersections = [];
  const epsilon = 1e-7;

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const da = a.x * across.x + a.y * across.y - distance;
    const db = b.x * across.x + b.y * across.y - distance;

    if (Math.abs(da) < epsilon && Math.abs(db) < epsilon) {
      continue;
    }

    if (Math.abs(da) < epsilon) {
      intersections.push({
        x: a.x,
        y: a.y,
        t: a.x * along.x + a.y * along.y
      });
      continue;
    }

    if (da * db > 0) {
      continue;
    }

    const ratio = da / (da - db);
    if (ratio < -epsilon || ratio > 1 + epsilon) {
      continue;
    }

    const x = a.x + (b.x - a.x) * ratio;
    const y = a.y + (b.y - a.y) * ratio;
    intersections.push({
      x,
      y,
      t: x * along.x + y * along.y
    });
  }

  return intersections
    .sort((a, b) => a.t - b.t)
    .filter((point, index, arr) => {
      if (index === 0) return true;
      return Math.abs(point.t - arr[index - 1].t) > 0.05;
    });
};

function buildRouteLegacy(showStatus = true) {
  if (boundaryWaypoints.length < 3) {
    setStatus('至少需要 3 个测区点才能生成航线。');
    return;
  }

  const frame = buildLocalFrame();
  const polygon = boundaryWaypoints.map(frame.toLocal);
  const spacing = Math.max(0.1, Number(routeConfig.value.spacing) || 0.8);
  const offset = Math.max(0, Number(routeConfig.value.offset) || 0);
  const heading = ((Number(routeConfig.value.heading) || 0) % 180) * Math.PI / 180;
  const along = {
    x: Math.sin(heading),
    y: Math.cos(heading)
  };
  const across = {
    x: Math.cos(heading),
    y: -Math.sin(heading)
  };

  const distances = polygon.map((point) => point.x * across.x + point.y * across.y);
  const minDistance = Math.min(...distances);
  const maxDistance = Math.max(...distances);
  const startDistance = Math.ceil((minDistance + offset) / spacing) * spacing;
  const endDistance = maxDistance - offset;

  if (startDistance > endDistance) {
    setStatus('测区留白距离太大，当前区域内无法生成航线。');
    return;
  }

  const route = [];
  let routeCount = 0;

  for (let distance = startDistance; distance <= endDistance + spacing * 0.5; distance += spacing) {
    const intersections = intersectScanLine(polygon, across, along, distance);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const pair = [intersections[i], intersections[i + 1]];
      if (routeCount % 2 === 1) {
        pair.reverse();
      }

      route.push(frame.toWaypoint(pair[0]));
      route.push(frame.toWaypoint(pair[1]));
      routeCount += 1;
    }
  }

  drawing.value = false;
  activeTransformMode = 'none';
  clearTransformGizmo();
  generatedWaypoints = route;
  routeSummary.scanLineCount = routeCount;
  routeSummary.waypointCount = route.length;
  drawRoute();

  emit('update-route', {
    waypoints: route,
    boundaryPoints: boundaryWaypoints,
    routeCount
  });

  if (showStatus) {
    setStatus(`航线已生成。扫描线 ${routeCount} 条，航点 ${route.length} 个。`);
  } else {
    emitState();
  }
}

function buildRoute(showStatus = true) {
  if (boundaryWaypoints.length < 3) {
    setStatus('至少需要 3 个测区点才能生成航线。');
    return;
  }

  const wallDistance = Math.max(0, Number(routeConfig.value.offset ?? 20));
  const lateralSpacing = getFovSpacing(wallDistance, 'lateral');
  const longitudinalSpacing = getFovSpacing(wallDistance, 'longitudinal');
  const frame = getSlopePlaneFrame();

  if (!frame) {
    setStatus('测区平面无效，请重新绘制立面测区。');
    return;
  }

  const planeBoundary = boundaryCartesians.map((point) => cartesianToPlaneMeters(point, frame));
  const planeRoute = generateStraightPlaneRoute(planeBoundary, lateralSpacing, longitudinalSpacing);

  if (!Array.isArray(planeRoute.points) || planeRoute.points.length === 0) {
    setStatus('测区范围太小，当前参数下无法生成规则直线航线。');
    return;
  }

  const routeCount = planeRoute.routeCount;
  const lateralOverlapPercent = Math.round(normalizeOverlapRate(routeConfig.value.lateralOverlap, 80) * 100);
  const longitudinalOverlapPercent = Math.round(normalizeOverlapRate(routeConfig.value.longitudinalOverlap, 80) * 100);

  const route = planeRoute.points.map((planePoint, index) => {
    const dronePosition = planeMetersToCartesian(planePoint, frame, wallDistance);
    const waypoint = waypointFromCartesian(dronePosition);
    const orientation = getWallFacingOrientation(dronePosition, frame);

    return {
      ...waypoint,
      speed: props.missionConfig.globalSpeed,
      index,
      gimbalPitch: orientation.gimbalPitch,
      directionAngle: orientation.directionAngle,
      photoDistance: longitudinalSpacing,
      lateralOverlap: lateralOverlapPercent,
      longitudinalOverlap: longitudinalOverlapPercent
    };
  });

  drawing.value = false;
  activeTransformMode = 'none';
  clearTransformGizmo();
  generatedWaypoints = route;
  routeSummary.scanLineCount = routeCount;
  routeSummary.waypointCount = route.length;
  drawRoute();

  emit('update-route', {
    waypoints: route,
    boundaryPoints: boundaryWaypoints,
    routeCount
  });

  if (showStatus) {
    const sideText = routeConfig.value.reverseSide ? '当前为反向侧。' : '当前为初始侧。';
    setStatus(`航线已生成。${sideText}离立面 ${wallDistance}m，旁向间距 ${lateralSpacing.toFixed(2)}m，航向间距 ${longitudinalSpacing.toFixed(2)}m，航点 ${route.length} 个。`);
  } else {
    emitState();
  }
}

const toggleWireframe = () => {
  wireframe.value = !wireframe.value;

  if (tileset) {
    if ('debugWireframe' in tileset) {
      tileset.debugWireframe = wireframe.value;
    } else {
      tileset.debugShowBoundingVolume = wireframe.value;
    }
  }

  setStatus(wireframe.value ? '已显示模型调试线框。' : '已隐藏模型调试线框。');
};

const toggleGrid = () => {
  gridVisible.value = !gridVisible.value;
  if (viewerInstance) {
    viewerInstance.scene.globe.show = gridVisible.value;
  }
  setStatus(gridVisible.value ? '已显示地球底图。' : '已隐藏地球底图。');
};

const stopAutoRotate = () => {
  if (viewerInstance && rotateTick) {
    viewerInstance.clock.onTick.removeEventListener(rotateTick);
  }
  rotateTick = null;
};

const toggleAutoRotate = () => {
  autoRotate.value = !autoRotate.value;

  if (autoRotate.value && viewerInstance && CesiumApi) {
    rotateTick = () => {
      if (!autoRotate.value || !viewerInstance) return;
      viewerInstance.camera.rotate(CesiumApi.Cartesian3.UNIT_Z, -0.00025);
    };
    viewerInstance.clock.onTick.addEventListener(rotateTick);
  } else {
    stopAutoRotate();
  }

  setStatus(autoRotate.value ? '已开启自动旋转。' : '已关闭自动旋转。');
};

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
  () => [routeConfig.value.lateralOverlap, routeConfig.value.longitudinalOverlap, routeConfig.value.offset, routeConfig.value.reverseSide],
  (settings, previousSettings) => {
    if (generatedWaypoints.length > 0) {
      if (Boolean(settings[3]) !== Boolean(previousSettings[3])) {
        buildRoute(true);
      } else {
        clearRouteOnly(true);
        setStatus('测区参数已更新，请重新点击生成航线。');
      }
    }
  }
);

onBeforeUnmount(() => {
  stopAutoRotate();
  stopTransformDrag();

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
  selectTransformMode,
  buildRoute,
  clearPlanning
});
</script>

<style scoped>
.slope-tileset-viewer {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: #070b12;
}

.slope-cesium {
  width: 100%;
  height: 100%;
}
</style>
