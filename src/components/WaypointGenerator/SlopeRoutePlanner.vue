<template>
  <div class="slope-planner">
    <div ref="viewportRef" class="slope-viewport"></div>

    <div v-if="false" class="slope-panel">
      <div class="panel-title">斜面航线</div>
      <div class="actions">
        <button type="button" @click="fitCamera" :disabled="!modelReady">居中</button>
        <button type="button" @click="beginDraw" :disabled="!modelReady">绘制测区</button>
        <button type="button" @click="selectArea('translate')" :disabled="!hasArea">移动</button>
        <button type="button" @click="selectArea('rotate')" :disabled="!hasArea">旋转</button>
        <button type="button" @click="buildRoute(true)" :disabled="!hasArea">生成航线</button>
        <button type="button" class="secondary" @click="clearPlanning(true)" :disabled="!hasArea">清除</button>
      </div>

      <div class="inputs">
        <label>
          航线间距 m
          <input v-model.number="ui.spacing" type="number" min="0.1" step="0.1" @change="onRouteSettingsChange" />
        </label>
        <label>
          离面距离 m
          <input v-model.number="ui.offset" type="number" step="0.1" @change="onRouteSettingsChange" />
        </label>
      </div>

      <div class="inputs">
        <label>
          原点经度
          <input v-model.number="ui.originLng" type="number" step="0.000001" @change="onGeoSettingsChange" />
        </label>
        <label>
          原点纬度
          <input v-model.number="ui.originLat" type="number" step="0.000001" @change="onGeoSettingsChange" />
        </label>
      </div>

      <div class="inputs">
        <label>
          原点高度 m
          <input v-model.number="ui.originHeight" type="number" step="0.1" @change="onGeoSettingsChange" />
        </label>
        <label>
          模型朝向 deg
          <input v-model.number="ui.heading" type="number" step="1" @change="onGeoSettingsChange" />
        </label>
        <label>
          比例
          <input v-model.number="ui.scale" type="number" min="0.0001" step="0.01" @change="onGeoSettingsChange" />
        </label>
      </div>

      <div class="actions compact">
        <button type="button" class="secondary" @click="toggleWireframe" :disabled="!modelReady">
          {{ ui.wireframe ? '隐藏线框' : '显示线框' }}
        </button>
        <button type="button" class="secondary" @click="toggleGrid">
          {{ ui.gridVisible ? '隐藏网格' : '显示网格' }}
        </button>
        <button type="button" class="secondary" @click="toggleAutoRotate">
          {{ ui.autoRotate ? '停止旋转' : '自动旋转' }}
        </button>
      </div>

      <div class="status">{{ statusText }}</div>
      <div v-if="routeSummary.waypointCount > 0" class="summary">
        扫描线 {{ routeSummary.scanLineCount }} 条 / 航点 {{ routeSummary.waypointCount }} 个
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import {
  calculatePlaneNormal,
  DEFAULT_SLOPE_GEOREFERENCE,
  buildSlopeRoute,
  getSlopeAngleDegrees,
  modelPointsToWaypoints,
  normalizeSlopeGeoReference
} from '../../utils/slopeRouteGenerator';

const props = defineProps({
  missionConfig: {
    type: Object,
    required: true
  },
  modelUrl: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['update-route', 'update:missionConfig', 'state-change']);

const DEFAULT_MODEL_URL = '/models/ruansan/tileset.json';

const viewportRef = ref(null);
const statusText = ref('正在初始化 3D 斜面规划器...');
const modelReady = ref(false);
const hasArea = ref(false);

const ui = reactive({
  spacing: props.missionConfig.slopeRoute?.spacing ?? 0.8,
  offset: props.missionConfig.slopeRoute?.offset ?? 0.4,
  reverseSide: Boolean(props.missionConfig.slopeRoute?.reverseSide),
  modelUrl: props.missionConfig.slopeRoute?.modelUrl || props.modelUrl || DEFAULT_MODEL_URL,
  ...normalizeSlopeGeoReference(props.missionConfig.slopeRoute || DEFAULT_SLOPE_GEOREFERENCE),
  wireframe: false,
  gridVisible: true,
  autoRotate: false
});

const routeSummary = reactive({
  scanLineCount: 0,
  waypointCount: 0
});

let scene;
let camera;
let renderer;
let controls;
let transformControls;
let resizeObserver;
let animationFrame = 0;
let model;
let grid;
let axes;
let currentModelUrl = '';

const bbox = new THREE.Box3();
const size = new THREE.Vector3();
const center = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const worldUp = new THREE.Vector3(0, 1, 0);

const modelMaterial = new THREE.MeshStandardMaterial({
  color: 0xd8dde8,
  roughness: 0.68,
  metalness: 0.05,
  side: THREE.DoubleSide
});

const areaMaterial = new THREE.MeshStandardMaterial({
  color: 0x2c8cff,
  transparent: true,
  opacity: 0.28,
  roughness: 0.7,
  metalness: 0.0,
  side: THREE.DoubleSide,
  depthWrite: false
});

const baselineMaterial = new THREE.LineBasicMaterial({ color: 0xf4c542 });
const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x8fd6ff });
const routeMaterial = new THREE.LineBasicMaterial({ color: 0x5cff79 });
const previewMaterial = new THREE.LineDashedMaterial({
  color: 0xf4c542,
  dashSize: 0.12,
  gapSize: 0.08
});
const handleMaterial = new THREE.MeshStandardMaterial({
  color: 0xffd447,
  emissive: 0x332400,
  roughness: 0.45
});

const planning = {
  mode: 'view',
  baseStart: undefined,
  baseEnd: undefined,
  normal: undefined,
  xAxis: undefined,
  yAxis: undefined,
  length: 0,
  areaGroup: undefined,
  transformProxy: undefined,
  activeTransformMode: 'translate',
  areaMesh: undefined,
  baselineLine: undefined,
  outlineLine: undefined,
  routeLine: undefined,
  previewLine: undefined,
  startMarker: undefined,
  handles: [],
  corners: [],
  routeLocalPoints: [],
  dragHandleIndex: -1,
  routeCount: 0,
  shiftDown: false
};

const proxyLocalPosition = new THREE.Vector3();
const proxyWorldPosition = new THREE.Vector3();
const proxyLastPosition = new THREE.Vector3();
const proxyLastQuaternion = new THREE.Quaternion();
const proxyDeltaPosition = new THREE.Vector3();
const proxyDeltaQuaternion = new THREE.Quaternion();
const proxyInverseQuaternion = new THREE.Quaternion();
let syncingProxy = false;

const emitState = () => {
  emit('state-change', {
    modelReady: modelReady.value,
    hasArea: hasArea.value,
    transformMode: planning.activeTransformMode,
    wireframe: ui.wireframe,
    gridVisible: ui.gridVisible,
    autoRotate: ui.autoRotate,
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

const toPlainPoint = (point) => ({ x: point.x, y: point.y, z: point.z });

const toVector3 = (point) => new THREE.Vector3(point.x, point.y, point.z);

const emitConfig = () => {
  emit('update:missionConfig', {
    ...props.missionConfig,
    slopeRoute: {
      ...props.missionConfig.slopeRoute,
      spacing: Number(ui.spacing) || 0.8,
      offset: Number(ui.offset) || 0,
      reverseSide: ui.reverseSide,
      originLng: Number(ui.originLng),
      originLat: Number(ui.originLat),
      originHeight: Number(ui.originHeight),
      heading: Number(ui.heading) || 0,
      scale: Number(ui.scale) || 1,
      modelUrl: ui.modelUrl || DEFAULT_MODEL_URL
    }
  });
};

const clearEmittedRoute = () => {
  emit('update-route', {
    waypoints: [],
    boundaryPoints: [],
    routeCount: 0
  });
};

const getPointer = (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
};

const pickModel = (event) => {
  if (!model) return undefined;
  getPointer(event);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(model, true)[0];
};

const pickArea = (event) => {
  if (!planning.areaMesh) return undefined;
  getPointer(event);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(planning.areaMesh, true)[0];
};

const pickHandle = (event) => {
  if (!planning.handles.length) return undefined;
  getPointer(event);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(planning.handles, false)[0];
};

const getHitNormal = (hit) => {
  if (!hit || !hit.face) return new THREE.Vector3(0, 1, 0);
  return hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
};

const makeLine = (points, material) => {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(geometry, material);
  if (line.computeLineDistances) line.computeLineDistances();
  return line;
};

const updateLine = (line, points) => {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points);
  if (line.computeLineDistances) line.computeLineDistances();
};

const createMarker = (position, color, radius) => {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshStandardMaterial({ color })
  );
  marker.position.copy(position);
  scene.add(marker);
  return marker;
};

const removeObject = (object) => {
  if (!object) return;
  if (object.parent) object.parent.remove(object);

  object.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
  });
};

function clearPlanning(emitEmpty = false) {
  if (transformControls) {
    transformControls.detach();
    transformControls.visible = false;
  }

  removeObject(planning.areaGroup);
  removeObject(planning.transformProxy);
  removeObject(planning.previewLine);
  removeObject(planning.startMarker);

  planning.mode = 'view';
  planning.baseStart = undefined;
  planning.baseEnd = undefined;
  planning.normal = undefined;
  planning.xAxis = undefined;
  planning.yAxis = undefined;
  planning.length = 0;
  planning.areaGroup = undefined;
  planning.transformProxy = undefined;
  planning.activeTransformMode = 'translate';
  planning.areaMesh = undefined;
  planning.baselineLine = undefined;
  planning.outlineLine = undefined;
  planning.routeLine = undefined;
  planning.previewLine = undefined;
  planning.startMarker = undefined;
  planning.handles = [];
  planning.corners = [];
  planning.routeLocalPoints = [];
  planning.dragHandleIndex = -1;
  planning.routeCount = 0;
  hasArea.value = false;
  routeSummary.scanLineCount = 0;
  routeSummary.waypointCount = 0;

  if (controls) controls.enabled = true;
  if (emitEmpty) clearEmittedRoute();
  emitState();
}

function fitCamera() {
  if (!model || !viewportRef.value) return;

  bbox.setFromObject(model);
  bbox.getSize(size);
  bbox.getCenter(center);

  const maxSize = Math.max(size.x, size.y, size.z);
  const distance = Math.max(maxSize * 1.8, 4);

  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 1000;
  camera.updateProjectionMatrix();

  camera.position.set(
    center.x + distance * 0.85,
    center.y + distance * 0.65,
    center.z + distance * 0.85
  );
  controls.target.copy(center);
  controls.update();
}

const summarizeObject = (object) => {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;

  object.traverse((child) => {
    if (!child.isMesh) return;

    meshes += 1;
    const geometry = child.geometry;
    const position = geometry.attributes.position;
    vertices += position ? position.count : 0;

    if (geometry.index) {
      triangles += Math.floor(geometry.index.count / 3);
    } else if (position) {
      triangles += Math.floor(position.count / 3);
    }
  });

  return { meshes, vertices, triangles };
};

const prepareObject = (object) => {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.material = modelMaterial;
    child.geometry.computeVertexNormals();
  });

  bbox.setFromObject(object);
  bbox.getCenter(center);
  object.position.sub(center);

  bbox.setFromObject(object);
  bbox.getSize(size);
  bbox.getCenter(center);
};

const ensurePreviewLine = () => {
  if (!planning.previewLine) {
    planning.previewLine = makeLine([new THREE.Vector3(), new THREE.Vector3()], previewMaterial);
    scene.add(planning.previewLine);
  }
};

const defineMeasurementBasis = () => {
  const rawX = planning.baseEnd.clone().sub(planning.baseStart);
  rawX.addScaledVector(planning.normal, -rawX.dot(planning.normal));

  if (rawX.length() < 0.001) return false;

  planning.length = rawX.length();
  planning.xAxis = rawX.normalize();
  planning.baseEnd = planning.baseStart.clone().addScaledVector(planning.xAxis, planning.length);
  planning.yAxis = new THREE.Vector3().crossVectors(planning.normal, planning.xAxis).normalize();
  return true;
};

const getProxyLocalPosition = () => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  planning.corners.forEach((corner) => {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y);
    maxY = Math.max(maxY, corner.y);
  });

  const spanX = Math.max(maxX - minX, 0.1);
  const spanY = Math.max(maxY - minY, 0.1);
  const margin = Math.max(Math.max(spanX, spanY) * 0.16, 0.45);
  const sideY = Math.abs(maxY) >= Math.abs(minY) ? maxY + margin : minY - margin;

  proxyLocalPosition.set((minX + maxX) * 0.5, sideY, margin * 0.35);
  return proxyLocalPosition;
};

function syncTransformProxy(updateLast = true) {
  if (!planning.areaGroup || !planning.transformProxy || planning.corners.length !== 4) return;

  syncingProxy = true;
  planning.areaGroup.updateMatrixWorld(true);
  planning.areaGroup.localToWorld(proxyWorldPosition.copy(getProxyLocalPosition()));
  planning.transformProxy.position.copy(proxyWorldPosition);
  planning.areaGroup.getWorldQuaternion(planning.transformProxy.quaternion);
  planning.transformProxy.updateMatrixWorld(true);

  if (updateLast) {
    proxyLastPosition.copy(planning.transformProxy.position);
    proxyLastQuaternion.copy(planning.transformProxy.quaternion);
  }

  syncingProxy = false;
}

function applyProxyTransform() {
  if (syncingProxy || !planning.areaGroup || !planning.transformProxy) return;

  if (planning.activeTransformMode === 'rotate') {
    proxyInverseQuaternion.copy(proxyLastQuaternion).invert();
    proxyDeltaQuaternion.copy(planning.transformProxy.quaternion).multiply(proxyInverseQuaternion);

    if (
      Math.abs(proxyDeltaQuaternion.x) > 0.000001 ||
      Math.abs(proxyDeltaQuaternion.y) > 0.000001 ||
      Math.abs(proxyDeltaQuaternion.z) > 0.000001 ||
      Math.abs(proxyDeltaQuaternion.w - 1) > 0.000001
    ) {
      planning.areaGroup.quaternion.premultiply(proxyDeltaQuaternion).normalize();
      syncTransformProxy(true);
      emitCurrentRoute();
    }
    return;
  }

  proxyDeltaPosition.copy(planning.transformProxy.position).sub(proxyLastPosition);
  if (proxyDeltaPosition.lengthSq() > 0.000000001) {
    planning.areaGroup.position.add(proxyDeltaPosition);
    proxyLastPosition.copy(planning.transformProxy.position);
    emitCurrentRoute();
  }
}

const createAreaGroup = () => {
  const matrix = new THREE.Matrix4().makeBasis(planning.xAxis, planning.yAxis, planning.normal);
  const areaGroup = new THREE.Group();
  areaGroup.position.copy(planning.baseStart);
  areaGroup.quaternion.setFromRotationMatrix(matrix);

  const transformProxy = new THREE.Object3D();
  transformProxy.name = 'measurement-transform-proxy';
  scene.add(transformProxy);

  const areaGeometry = new THREE.BufferGeometry();
  areaGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  areaGeometry.setIndex([0, 1, 2, 0, 2, 3]);

  const areaMesh = new THREE.Mesh(areaGeometry, areaMaterial);
  areaMesh.name = 'measurement-area';
  areaGroup.add(areaMesh);

  const baselineLine = makeLine([new THREE.Vector3(), new THREE.Vector3(planning.length, 0, 0)], baselineMaterial);
  areaGroup.add(baselineLine);

  const outlineLine = makeLine([], outlineMaterial);
  areaGroup.add(outlineLine);

  const handles = [];
  for (let i = 0; i < 4; i += 1) {
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), handleMaterial);
    handle.name = `area-handle-${i}`;
    handle.userData.handleIndex = i;
    areaGroup.add(handle);
    handles.push(handle);
  }

  planning.areaGroup = areaGroup;
  planning.transformProxy = transformProxy;
  planning.areaMesh = areaMesh;
  planning.baselineLine = baselineLine;
  planning.outlineLine = outlineLine;
  planning.handles = handles;
  scene.add(areaGroup);
};

function updateAreaGeometry() {
  const position = planning.areaMesh.geometry.attributes.position;
  planning.corners.forEach((corner, index) => {
    position.setXYZ(index, corner.x, corner.y, corner.z);
  });
  position.needsUpdate = true;
  planning.areaMesh.geometry.computeVertexNormals();
  planning.areaMesh.geometry.computeBoundingSphere();

  updateLine(planning.outlineLine, [
    planning.corners[0],
    planning.corners[1],
    planning.corners[2],
    planning.corners[3],
    planning.corners[0]
  ]);
  updateLine(planning.baselineLine, [planning.corners[0], planning.corners[1]]);

  planning.handles.forEach((handle, index) => {
    handle.position.copy(planning.corners[index]);
  });

  if (planning.routeLine) buildRoute(false);
  syncTransformProxy(!transformControls.dragging);
}

const updateAreaFromWidth = (width) => {
  if (!planning.areaGroup) createAreaGroup();

  planning.corners = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(planning.length, 0, 0),
    new THREE.Vector3(planning.length, width, 0),
    new THREE.Vector3(0, width, 0)
  ];
  hasArea.value = true;
  updateAreaGeometry();
};

const updateAreaFromHit = (hit) => {
  if (!hit || !planning.baseStart || !planning.yAxis) return;

  const delta = hit.point.clone().sub(planning.baseStart);
  let width = delta.dot(planning.yAxis);
  if (Math.abs(width) < 0.08) {
    width = width < 0 ? -0.08 : 0.08;
  }
  updateAreaFromWidth(width);

  if (planning.shiftDown) {
    const angle = getSlopeAngleDegrees(toPlainPoint(planning.normal), toPlainPoint(worldUp));
    setStatus(`当前斜面角度 ${angle.toFixed(1)} deg`);
  }
};

function selectArea(mode = 'translate') {
  if (!planning.areaGroup) return;

  syncTransformProxy(true);
  planning.activeTransformMode = mode;
  transformControls.attach(planning.transformProxy);
  transformControls.setMode(mode);
  transformControls.visible = true;
  controls.enabled = true;
  setStatus(mode === 'rotate' ? '正在旋转测区' : '正在移动测区');
}

const localPointToWorldPlain = (point) => {
  const vector = toVector3(point);
  planning.areaGroup.localToWorld(vector);
  return toPlainPoint(vector);
};

function emitCurrentRoute() {
  if (!planning.areaGroup || !planning.routeLocalPoints.length) return;

  planning.areaGroup.updateMatrixWorld(true);
  const routeWorldPoints = planning.routeLocalPoints.map(localPointToWorldPlain);
  const boundaryWorldPoints = planning.corners.map(corner => localPointToWorldPlain(toPlainPoint(corner)));
  const surfaceNormal = calculatePlaneNormal(boundaryWorldPoints);
  if (surfaceNormal && ui.reverseSide) {
    surfaceNormal.x *= -1;
    surfaceNormal.y *= -1;
    surfaceNormal.z *= -1;
  }

  const waypoints = modelPointsToWaypoints(routeWorldPoints, ui, props.missionConfig, surfaceNormal);
  const boundaryPoints = modelPointsToWaypoints(boundaryWorldPoints, ui, props.missionConfig, surfaceNormal);

  emit('update-route', {
    waypoints,
    boundaryPoints,
    routeCount: planning.routeCount
  });
}

function buildRoute(showStatus = true) {
  if (!planning.areaGroup || planning.corners.length !== 4) return;

  if (planning.routeLine) {
    planning.areaGroup.remove(planning.routeLine);
    planning.routeLine.geometry.dispose();
    planning.routeLine = undefined;
  }

  const result = buildSlopeRoute(planning.corners.map(toPlainPoint), {
    spacing: ui.spacing,
    offset: ui.reverseSide ? -ui.offset : ui.offset
  });

  if (!result.routePoints.length) return;

  planning.routeLocalPoints = result.routePoints;
  planning.routeCount = result.scanLineCount;
  planning.routeLine = makeLine(result.routePoints.map(toVector3), routeMaterial);
  planning.areaGroup.add(planning.routeLine);
  routeSummary.scanLineCount = result.scanLineCount;
  routeSummary.waypointCount = result.routePoints.length;

  emitConfig();
  emitCurrentRoute();
  emitState();

  if (showStatus) {
    setStatus(`航线已生成。${ui.reverseSide ? '当前为反向侧。' : '当前为初始侧。'}间距 ${result.spacing}m，离面 ${Math.abs(result.offset)}m`);
  }
}

function updateDraggedHandle(event) {
  if (planning.dragHandleIndex < 0 || !planning.areaGroup) return;

  getPointer(event);
  raycaster.setFromCamera(pointer, camera);

  const localNormal = new THREE.Vector3(0, 0, 1);
  const normal = localNormal.transformDirection(planning.areaGroup.matrixWorld).normalize();
  const origin = planning.areaGroup.localToWorld(new THREE.Vector3(0, 0, 0));
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
  const hitPoint = new THREE.Vector3();

  if (!raycaster.ray.intersectPlane(plane, hitPoint)) return;

  const localPoint = planning.areaGroup.worldToLocal(hitPoint);
  localPoint.z = 0;
  planning.corners[planning.dragHandleIndex].copy(localPoint);
  updateAreaGeometry();
  setStatus('正在调整测区形状');
}

function beginDraw() {
  clearPlanning(true);
  planning.mode = 'drawBase';
  controls.enabled = false;
  controls.autoRotate = false;
  ui.autoRotate = false;
  setStatus('选择基准线起点');
}

const onPointerDown = (event) => {
  if (event.button !== 0 || !model) return;

  if (planning.mode === 'drawBase') {
    const hit = pickModel(event);
    if (!hit) {
      setStatus('没有点到模型');
      return;
    }

    if (!planning.baseStart) {
      planning.baseStart = hit.point.clone();
      planning.normal = getHitNormal(hit);
      planning.startMarker = createMarker(planning.baseStart, 0xffd447, 0.08);
      setStatus('选择基准线终点');
      return;
    }

    planning.baseEnd = hit.point.clone();
    planning.normal = getHitNormal(hit);
    if (!defineMeasurementBasis()) {
      setStatus('基准线太短，请重新绘制');
      clearPlanning(true);
      return;
    }

    removeObject(planning.previewLine);
    planning.previewLine = undefined;
    planning.mode = 'drawArea';
    setStatus('拖动鼠标确定测区宽度');
    return;
  }

  if (planning.mode === 'drawArea') {
    const hit = pickModel(event);
    if (hit) updateAreaFromHit(hit);

    if (!planning.areaGroup) {
      setStatus('测区宽度无效');
      return;
    }

    removeObject(planning.startMarker);
    planning.startMarker = undefined;
    planning.mode = 'view';
    controls.enabled = true;
    selectArea('translate');
    setStatus('测区已生成');
    return;
  }

  const handleHit = pickHandle(event);
  if (handleHit) {
    planning.dragHandleIndex = handleHit.object.userData.handleIndex;
    controls.enabled = false;
    transformControls.enabled = false;
    setStatus('正在调整测区形状');
    return;
  }

  if (pickArea(event)) {
    selectArea(transformControls.getMode ? transformControls.getMode() : 'translate');
  }
};

const onPointerMove = (event) => {
  if (planning.dragHandleIndex >= 0) {
    updateDraggedHandle(event);
    return;
  }

  if (planning.mode === 'drawBase' && planning.baseStart) {
    const hit = pickModel(event);
    if (!hit) return;

    ensurePreviewLine();
    updateLine(planning.previewLine, [planning.baseStart, hit.point]);

    if (planning.shiftDown) {
      const angle = getSlopeAngleDegrees(toPlainPoint(getHitNormal(hit)), toPlainPoint(worldUp));
      setStatus(`当前斜面角度 ${angle.toFixed(1)} deg`);
    }
    return;
  }

  if (planning.mode === 'drawArea') {
    const hit = pickModel(event);
    if (hit) updateAreaFromHit(hit);
  }
};

const onPointerUp = () => {
  if (planning.dragHandleIndex >= 0) {
    planning.dragHandleIndex = -1;
    controls.enabled = true;
    transformControls.enabled = true;
    if (planning.routeLine) buildRoute(false);
    setStatus('测区调整完成');
  }
};

const onKeyDown = (event) => {
  if (event.key === 'Shift') planning.shiftDown = true;
};

const onKeyUp = (event) => {
  if (event.key === 'Shift') planning.shiftDown = false;
};

const onRouteSettingsChange = () => {
  emitConfig();
  if (planning.routeLine) buildRoute(false);
};

const onGeoSettingsChange = () => {
  emitConfig();
  if (planning.routeLine) emitCurrentRoute();
};

const toggleWireframe = () => {
  ui.wireframe = !ui.wireframe;
  modelMaterial.wireframe = ui.wireframe;
  emitState();
};

const toggleGrid = () => {
  ui.gridVisible = !ui.gridVisible;
  if (grid) grid.visible = ui.gridVisible;
  if (axes) axes.visible = ui.gridVisible;
  emitState();
};

const toggleAutoRotate = () => {
  ui.autoRotate = !ui.autoRotate;
  if (controls) controls.autoRotate = ui.autoRotate;
  emitState();
};

const resizeRenderer = () => {
  if (!viewportRef.value || !renderer || !camera) return;

  const width = Math.max(viewportRef.value.clientWidth, 1);
  const height = Math.max(viewportRef.value.clientHeight, 1);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
};

const createFallbackModel = () => {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(8, 0.25, 4);
  const mesh = new THREE.Mesh(geometry, modelMaterial);
  mesh.rotation.z = -0.42;
  group.add(mesh);
  return group;
};

const loadModel = () => {
  setStatus('正在加载斜面模型...');
  const loader = new OBJLoader();

  loader.load(
    props.modelUrl,
    (object) => {
      model = object;
      prepareObject(model);
      scene.add(model);
      fitCamera();
      modelReady.value = true;

      const summary = summarizeObject(model);
      setStatus(`模型已加载。网格 ${summary.meshes} 个 / 顶点 ${summary.vertices.toLocaleString()} 个`);
    },
    undefined,
    () => {
      model = createFallbackModel();
      prepareObject(model);
      scene.add(model);
      fitCamera();
      modelReady.value = true;
      setStatus('示例模型加载失败，已使用临时斜面');
    }
  );
};

const getConfiguredModelUrl = () => props.missionConfig.slopeRoute?.modelUrl || props.modelUrl || DEFAULT_MODEL_URL;

const handleConfiguredModelLoaded = (object) => {
  removeObject(model);
  clearPlanning(true);
  model = object;
  prepareObject(model);
  scene.add(model);
  fitCamera();
  modelReady.value = true;

  const summary = summarizeObject(model);
  setStatus(`模型已加载。网格 ${summary.meshes} 个 / 顶点 ${summary.vertices.toLocaleString()} 个`);
};

const handleConfiguredModelLoadFailed = () => {
  removeObject(model);
  clearPlanning(true);
  model = createFallbackModel();
  prepareObject(model);
  scene.add(model);
  fitCamera();
  modelReady.value = true;
  setStatus('模型加载失败，已使用临时斜面');
};

const loadConfiguredModel = () => {
  const modelUrl = getConfiguredModelUrl();
  if (!modelUrl || modelUrl === currentModelUrl) return;

  currentModelUrl = modelUrl;
  modelReady.value = false;
  setStatus(`正在加载模型: ${modelUrl}`);

  const lowerUrl = modelUrl.split('?')[0].toLowerCase();
  if (lowerUrl.endsWith('.glb') || lowerUrl.endsWith('.gltf')) {
    const loader = new GLTFLoader();
    loader.load(
      modelUrl,
      (gltf) => handleConfiguredModelLoaded(gltf.scene),
      undefined,
      handleConfiguredModelLoadFailed
    );
    return;
  }

  const loader = new OBJLoader();
  loader.load(
    modelUrl,
    handleConfiguredModelLoaded,
    undefined,
    handleConfiguredModelLoadFailed
  );
};

const animate = () => {
  controls.update();
  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(animate);
};

onMounted(async () => {
  await nextTick();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10151c);

  camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewportRef.value.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.2;

  transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setSpace('local');
  transformControls.setMode('translate');
  transformControls.visible = false;
  scene.add(transformControls);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x263447, 2.2));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(5, 8, 6);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xaec8ff, 1.2);
  fillLight.position.set(-5, 4, -6);
  scene.add(fillLight);

  grid = new THREE.GridHelper(20, 20, 0x637083, 0x2c3542);
  scene.add(grid);

  axes = new THREE.AxesHelper(3);
  scene.add(axes);

  transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
    syncTransformProxy(true);
  });

  transformControls.addEventListener('objectChange', () => {
    applyProxyTransform();
  });

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(viewportRef.value);
  resizeRenderer();
  loadConfiguredModel();
  animate();
  emitConfig();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();

  renderer?.domElement?.removeEventListener('pointerdown', onPointerDown);
  renderer?.domElement?.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);

  clearPlanning(false);
  removeObject(model);
  controls?.dispose();
  transformControls?.dispose();
  renderer?.dispose();

  if (renderer?.domElement?.parentElement) {
    renderer.domElement.parentElement.removeChild(renderer.domElement);
  }
});

const applySlopeConfig = (config = {}) => {
  const normalized = normalizeSlopeGeoReference(config);
  ui.spacing = config.spacing ?? 0.8;
  ui.offset = config.offset ?? 0.4;
  ui.reverseSide = Boolean(config.reverseSide);
  ui.modelUrl = config.modelUrl || DEFAULT_MODEL_URL;
  ui.originLng = normalized.originLng;
  ui.originLat = normalized.originLat;
  ui.originHeight = normalized.originHeight;
  ui.heading = normalized.heading;
  ui.scale = normalized.scale;
};

defineExpose({
  fitCamera,
  beginDraw,
  selectArea,
  buildRoute,
  clearPlanning,
  toggleWireframe,
  toggleGrid,
  toggleAutoRotate
});

watch(
  () => props.missionConfig.slopeRoute,
  (config = {}) => {
    const spacingChanged = Number(config.spacing ?? 0.8) !== Number(ui.spacing);
    const offsetChanged = Number(config.offset ?? 0.4) !== Number(ui.offset);
    const sideChanged = Boolean(config.reverseSide) !== ui.reverseSide;

    const modelChanged = (config.modelUrl || DEFAULT_MODEL_URL) !== currentModelUrl;
    applySlopeConfig(config);

    if (modelChanged) {
      loadConfiguredModel();
    } else if (planning.routeLine && (spacingChanged || offsetChanged || sideChanged)) {
      buildRoute(sideChanged);
    } else if (planning.routeLine) {
      emitCurrentRoute();
    }

    emitState();
  },
  { deep: true }
);

watch(
  () => props.missionConfig.globalSpeed,
  () => {
    if (planning.routeLine) emitCurrentRoute();
  }
);
</script>

<style scoped>
.slope-planner {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #10151c;
}

.slope-viewport {
  position: absolute;
  inset: 0;
}

.slope-viewport :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.slope-panel {
  position: absolute;
  left: 14px;
  top: 14px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(520px, calc(100vw - 470px));
  min-width: 360px;
  padding: 12px;
  color: #eef3f8;
  background: rgba(18, 22, 28, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(10px);
}

.panel-title {
  font-size: 14px;
  font-weight: 700;
}

.actions,
.inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.actions.compact button {
  flex: 1 1 95px;
}

label {
  display: flex;
  flex: 1 1 110px;
  flex-direction: column;
  gap: 4px;
  color: #aeb8c5;
  font-size: 12px;
}

input {
  height: 30px;
  box-sizing: border-box;
  padding: 0 8px;
  color: #eef3f8;
  background: #202936;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  outline: none;
}

button {
  height: 32px;
  padding: 0 12px;
  color: #10151c;
  background: #f4c542;
  border: 0;
  border-radius: 6px;
  font-weight: 700;
  cursor: pointer;
}

button.secondary {
  color: #eef3f8;
  background: #2e3947;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.status {
  min-height: 36px;
  color: #dce6f2;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-line;
}

.summary {
  color: #aeb8c5;
  font-size: 12px;
}

@media (max-width: 900px) {
  .slope-panel {
    width: calc(100vw - 28px);
    min-width: 0;
  }
}
</style>
