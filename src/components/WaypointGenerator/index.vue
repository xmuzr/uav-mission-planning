<template>
  <div class="w-screen h-screen overflow-hidden font-sans bg-[#f5f7fa]">
    <div class="flex h-full w-full">
      <!-- 左侧面板：航线库或控制面板 - 固定宽度 -->
      <div class="h-full shrink-0 transition-all duration-300 border-r border-gray-200 bg-white z-10"
        :style="{ width: currentView === 'library' ? '320px' : '420px' }">
        <!-- View 1: Mission Library -->
        <MissionLibrary v-if="currentView === 'library'" :missions="missions" @create="showCreateModal = true"
          @select="selectMission" @edit="selectMission" @delete="deleteMission" class="h-full" />

        <!-- View 2: Mission Editor (ControlPanel) -->
        <ControlPanel v-else :missionConfig="missionConfig" :waypoints="waypoints" :mission-stats="missionStats"
          :route-stats="routeStats"
          :slope-state="slopePlannerState"
          :geometry-state="geometryPlannerState"
          :close-state="closePlannerState"
          @update:missionConfig="onMissionConfigUpdate" @update:waypoints="waypoints = $event"
          @remove-waypoint="removeWaypoint" @clear-waypoints="clearWaypoints" @reverse-waypoints="reverseWaypoints"
          @generate="handleGenerateKMZ" @generate-polygon="handleGeneratePolygonRoute"
          @slope-command="handleSlopeCommand"
          @geometry-command="handleGeometryCommand"
          @close-command="handleCloseCommand"
          @import-kmz="handleImportKMZ" @create-mission="showCreateModal = true"
          @back="currentView = 'library'" @save="saveCurrentMission" class="h-full" />
      </div>

      <!-- 右侧地图区域 - 自动填充剩余空间 -->
      <div class="flex-1 h-full relative min-w-0 bg-gray-100">
        <GeometryTilesetViewer
          v-if="missionConfig.routeType === 'geometry'"
          ref="geometryPlannerRef"
          :mission-config="missionConfig"
          @update-route="handleGeometryRouteUpdate"
          @state-change="geometryPlannerState = $event"
          class="h-full w-full absolute inset-0"
        />
        <GeometryTilesetViewer
          v-else-if="missionConfig.routeType === 'close' && isCloseFineStage"
          ref="closePlannerRef"
          :mission-config="missionConfig"
          planner-mode="close"
          @update-route="handleCloseRouteUpdate"
          @state-change="closePlannerState = $event"
          class="h-full w-full absolute inset-0"
        />
        <SlopeTilesetViewer
          v-else-if="missionConfig.routeType === 'slope' && slopeModelIsTileset"
          ref="slopePlannerRef"
          :mission-config="missionConfig"
          @update:missionConfig="onMissionConfigUpdate"
          @update-route="handleSlopeRouteUpdate"
          @state-change="slopePlannerState = $event"
          class="h-full w-full absolute inset-0"
        />
        <SlopeRoutePlanner
          v-else-if="missionConfig.routeType === 'slope'"
          ref="slopePlannerRef"
          :mission-config="missionConfig"
          @update:missionConfig="onMissionConfigUpdate"
          @update-route="handleSlopeRouteUpdate"
          @state-change="slopePlannerState = $event"
          class="h-full w-full absolute inset-0"
        />
<MapViewer v-else :waypoints="waypoints" :boundary-points="displayBoundaryPoints" :boundary-groups="displayBoundaryGroups" :route-type="effectiveRouteType" :is-closed-loop="missionConfig.isClosedLoop"
          :is-patrol-mode="effectiveRouteType === 'mapping' || effectiveRouteType === 'patrol' || effectiveRouteType === 'oblique' || effectiveRouteType === 'strip'"
          :scan-path="visibleScanPath" :scan-routes="visibleScanRoutes" @map-click="onMapClick" class="h-full w-full absolute inset-0" />
      </div>
    </div>

    <!-- 创建航线模态框 -->
    <CreateMissionModal :visible="showCreateModal" @cancel="showCreateModal = false" @confirm="onMissionCreated" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { getPolygonArea } from '../../utils/geoUtils';
import { generateKMZ } from '../../utils/kmzGenerator';
import { parseKMZ } from '../../utils/kmzParser';
import { calculateRouteStats, CAMERA_PRESETS, generateObliquePolygonRoutes, generatePolygonRoute } from '../../utils/polygonRouteGenerator';
import { generateScanPath } from '../../utils/routePlanner';
import { generateStripRoute } from '../../utils/stripRouteGenerator';
import ControlPanel from './ControlPanelV2.vue';
import CreateMissionModal from './CreateMissionModal.vue';
import GeometryTilesetViewer from './GeometryTilesetViewer.vue';
import MapViewer from './MapViewer.vue';
import MissionLibrary from './MissionLibrary.vue';
import SlopeTilesetViewer from './SlopeTilesetViewer.vue';
import SlopeRoutePlanner from './SlopeRoutePlanner.vue';

const DEFAULT_SLOPE_MODEL_URL = '/models/ruansan/tileset.json';

const waypoints = ref([]);
const missions = ref([]);
const currentView = ref('library');
const showCreateModal = ref(false);

const defaultMissionConfig = {
  missionName: '未命名航线',
  routeType: 'waypoint',
  aircraftSeries: 'm30',
  aircraftModel: 'm30t',
  droneEnumValue: 67,
  payloadEnumValue: 53,
  flyToWaylineMode: 'safely',
  finishAction: 'goHome',
  exitOnRCLost: 'executeLostAction',
  executeRCLostAction: 'goBack',
  takeOffSecurityHeight: 20,
  globalSpeed: 5,
  globalHeight: 50,
  globalTransitionalSpeed: 5,
  globalYawMode: 'path',
  isClosedLoop: false,
  isReverse: false,
  globalAction: 'none',
  gimbalPitch: -90,
  hoverTime: 0,
  photoInterval: 2,
  shootPhoto: false,
  recordVideo: false,
  executeHeightMode: 'realTimeFollowSurface',
  climbMode: 'vertical',
  caliFlightEnable: false,
  scanSetting: {
    overlap: 20,
    angle: 0,
    margin: 0
  },
  slopeRoute: {
    lateralOverlap: 80,
    longitudinalOverlap: 80,
    offset: 20,
    modelUrl: DEFAULT_SLOPE_MODEL_URL
  },
  geometryRoute: {
    geometryType: 'box',
    radiusOffset: 0,
    lateralOverlap: 80,
    longitudinalOverlap: 80,
    offset: 20,
    modelUrl: DEFAULT_SLOPE_MODEL_URL
  },
  closeRoute: {
    workflowStage: 'rough',
    roughRouteType: 'mapping',
    closeDistance: 10,
    bottomHeight: 0,
    topHeight: 20,
    lateralOverlap: 80,
    longitudinalOverlap: 70,
    modelUrl: DEFAULT_SLOPE_MODEL_URL
  }
};

const getRouteTypeDefaults = (routeType) => {
  if (routeType === 'close') {
    return {
      globalSpeed: 7,
      globalTransitionalSpeed: 7,
      globalAction: 'takePhoto',
      executeHeightMode: 'relativeToStartPoint',
      globalHeight: 80,
      gimbalPitch: -90,
      closeRoute: {
        workflowStage: 'rough',
        roughRouteType: 'mapping',
        closeDistance: 10,
        bottomHeight: 0,
        topHeight: 20,
        lateralOverlap: 80,
        longitudinalOverlap: 70,
        modelUrl: DEFAULT_SLOPE_MODEL_URL
      }
    };
  }

  return {};
};

const buildMissionConfig = (config = {}) => {
  config = { ...config, geometryRoute: { ...(config.geometryRoute || {}) } };
  // Older saved experimental entries now open in the regular geometry editor.
  delete config.geometryPlanner;
  delete config.geometryRoute.planner;
  const routeType = config.routeType || defaultMissionConfig.routeType;
  const routeDefaults = getRouteTypeDefaults(routeType);

  return {
    ...defaultMissionConfig,
    ...routeDefaults,
    ...config,
    slopeRoute: {
      ...defaultMissionConfig.slopeRoute,
      ...(routeDefaults.slopeRoute || {}),
      ...(config.slopeRoute || {})
    },
    geometryRoute: {
      ...defaultMissionConfig.geometryRoute,
      ...(routeDefaults.geometryRoute || {}),
      ...(config.geometryRoute || {})
    },
    closeRoute: {
      ...defaultMissionConfig.closeRoute,
      ...(routeDefaults.closeRoute || {}),
      ...(config.closeRoute || {})
    }
  };
};

const missionConfig = ref(buildMissionConfig());
const scanPath = ref([]);
const scanRoutes = ref([]);
const scanBoundaryPoints = ref([]);
const scanBoundaryGroups = ref([]);
const routeStats = ref(null);
const generatedRouteTypes = ['mapping', 'patrol', 'oblique', 'strip', 'slope', 'geometry', 'close'];
const slopePlannerRef = ref(null);
const geometryPlannerRef = ref(null);
const closePlannerRef = ref(null);
const slopePlannerState = ref({
  modelReady: false,
  hasArea: false,
  transformMode: 'none',
  statusText: '',
  routeSummary: {
    scanLineCount: 0,
    waypointCount: 0
  }
});
const geometryPlannerState = ref({
  modelReady: false,
  hasArea: false,
  transformMode: 'none',
  statusText: '',
  baseRadius: null,
  currentRadius: null,
  routeSummary: {
    surfaceCount: 0,
    scanLineCount: 0,
    waypointCount: 0
  }
});
const closePlannerState = ref({
  modelReady: false,
  hasArea: false,
  transformMode: 'none',
  statusText: '',
  routeSummary: {
    scanLineCount: 0,
    waypointCount: 0
  }
});

const slopeModelUrl = computed(() => missionConfig.value.slopeRoute?.modelUrl || DEFAULT_SLOPE_MODEL_URL);
const slopeModelIsTileset = computed(() => /(^|\/)tileset\.json(\?|$)/i.test(slopeModelUrl.value));
const isCloseFineStage = computed(() => missionConfig.value.routeType === 'close' && missionConfig.value.closeRoute?.workflowStage === 'fine');
const isCloseRoughStage = computed(() => missionConfig.value.routeType === 'close' && missionConfig.value.closeRoute?.workflowStage !== 'fine');
const closeRoughRouteType = computed(() => missionConfig.value.closeRoute?.roughRouteType === 'oblique' ? 'oblique' : 'mapping');
const effectiveRouteType = computed(() => isCloseRoughStage.value ? closeRoughRouteType.value : missionConfig.value.routeType);
const isSurfacePlannerMode = computed(() => {
  return missionConfig.value.routeType === 'slope'
    || missionConfig.value.routeType === 'geometry'
    || isCloseFineStage.value;
});

onMounted(() => {
  const saved = localStorage.getItem('missions');
  if (saved) {
    try {
      missions.value = JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load missions', e);
    }
  }
});

const saveMissionsToStorage = () => {
  localStorage.setItem('missions', JSON.stringify(missions.value));
};

const onMapClick = (coords) => {
  waypoints.value.push({
    lat: coords.lat,
    lng: coords.lng,
    height: missionConfig.value.globalHeight,
    speed: missionConfig.value.globalSpeed
  });
};

const handleSlopeRouteUpdate = (payload = {}) => {
  const routeWaypoints = Array.isArray(payload.waypoints) ? payload.waypoints : [];
  const boundaryPoints = Array.isArray(payload.boundaryPoints) ? payload.boundaryPoints : [];

  waypoints.value = boundaryPoints;
  scanPath.value = routeWaypoints;
  scanRoutes.value = [];
  scanBoundaryPoints.value = boundaryPoints;
  scanBoundaryGroups.value = boundaryPoints.length >= 3 ? [boundaryPoints] : [];
  routeStats.value = routeWaypoints.length > 0 ? calculateRouteStats(routeWaypoints) : null;
};

const handleGeometryRouteUpdate = (payload = {}) => {
  const routeWaypoints = Array.isArray(payload.waypoints) ? payload.waypoints : [];
  const boundaryPoints = Array.isArray(payload.boundaryPoints) ? payload.boundaryPoints : [];
  const boundaryGroups = Array.isArray(payload.boundaryGroups) ? payload.boundaryGroups : [];

  waypoints.value = boundaryPoints;
  scanPath.value = routeWaypoints;
  scanRoutes.value = [];
  scanBoundaryPoints.value = boundaryPoints;
  scanBoundaryGroups.value = boundaryGroups.length > 0
    ? boundaryGroups
    : (boundaryPoints.length >= 3 ? [boundaryPoints] : []);
  routeStats.value = routeWaypoints.length > 0 ? calculateRouteStats(routeWaypoints) : null;
};

const handleCloseRouteUpdate = (payload = {}) => {
  const routeWaypoints = Array.isArray(payload.waypoints) ? payload.waypoints : [];
  const routeSegments = Array.isArray(payload.routeSegments) ? payload.routeSegments : [];
  const boundaryPoints = Array.isArray(payload.boundaryPoints) ? payload.boundaryPoints : [];
  const boundaryGroups = Array.isArray(payload.boundaryGroups) ? payload.boundaryGroups : [];

  waypoints.value = boundaryPoints;
  scanPath.value = routeWaypoints;
  scanRoutes.value = routeSegments.map((segment, index) => ({
    directionIndex: index,
    waypoints: segment,
    color: '#55ff78'
  }));
  scanBoundaryPoints.value = boundaryPoints;
  scanBoundaryGroups.value = boundaryGroups.length > 0
    ? boundaryGroups
    : (boundaryPoints.length >= 3 ? [boundaryPoints] : []);
  routeStats.value = routeWaypoints.length > 0 ? calculateRouteStats(routeWaypoints) : null;
};

const handleSlopeCommand = (command) => {
  const planner = slopePlannerRef.value;
  if (!planner) return;

  const commandMap = {
    fit: () => planner.fitCamera(),
    draw: () => planner.beginDraw(),
    translate: () => (planner.selectTransformMode ? planner.selectTransformMode('translate') : planner.selectArea?.('translate')),
    rotate: () => (planner.selectTransformMode ? planner.selectTransformMode('rotate') : planner.selectArea?.('rotate')),
    generate: () => planner.buildRoute(true),
    clear: () => planner.clearPlanning(true)
  };

  commandMap[command]?.();
};

const handleGeometryCommand = (command) => {
  const planner = geometryPlannerRef.value;
  if (!planner) return;
  if ((typeof command === 'string' ? command : command.type)?.startsWith('preview-')) {
    planner.previewCommand?.(command);
    return;
  }

  const commandMap = {
    fit: () => planner.fitCamera(),
    draw: () => planner.beginDraw(),
    translate: () => (planner.selectTransformMode ? planner.selectTransformMode('translate') : planner.selectArea?.('translate')),
    generate: () => planner.buildRoute(true),
    clear: () => planner.clearPlanning(true)
  };

  commandMap[command]?.();
};

const handleCloseCommand = (command) => {
  const planner = closePlannerRef.value;
  if (!planner) return;

  const commandMap = {
    fit: () => planner.fitCamera(),
    draw: () => planner.beginDraw(),
    translate: () => (planner.selectTransformMode ? planner.selectTransformMode('translate') : planner.selectArea?.('translate')),
    rotate: () => (planner.selectTransformMode ? planner.selectTransformMode('rotate') : planner.selectArea?.('rotate')),
    generate: () => planner.buildRoute(true),
    clear: () => planner.clearPlanning(true)
  };

  commandMap[command]?.();
};

const onMissionCreated = (config) => {
  missionConfig.value = buildMissionConfig(config);
  waypoints.value = [];
  scanPath.value = [];
  scanRoutes.value = [];
  scanBoundaryPoints.value = [];
  scanBoundaryGroups.value = [];
  showCreateModal.value = false;
  currentView.value = 'editor';
};

const selectMission = (id) => {
  const mission = missions.value.find(m => m.id === id);
  if (mission) {
    missionConfig.value = buildMissionConfig(mission.config);
    waypoints.value = [...mission.waypoints];
    scanRoutes.value = [];
    scanBoundaryPoints.value = [];
    scanBoundaryGroups.value = [];
    currentView.value = 'editor';
  }
};

const deleteMission = (id) => {
  if (confirm('确定要删除该航线吗？')) {
    missions.value = missions.value.filter(m => m.id !== id);
    saveMissionsToStorage();
  }
};

const onMissionConfigUpdate = (newConfig) => {
  missionConfig.value = newConfig;
};

const removeWaypoint = (index) => {
  waypoints.value.splice(index, 1);
};

const clearWaypoints = () => {
  waypoints.value = [];
  scanPath.value = [];
  scanRoutes.value = [];
  scanBoundaryPoints.value = [];
  scanBoundaryGroups.value = [];
  routeStats.value = null;
};

const reverseWaypoints = () => {
  waypoints.value.reverse();
};

const handleGenerateKMZ = async () => {
  try {
    if (isSurfacePlannerMode.value && scanPath.value.length === 0) {
      alert('请先在 3D 视图中生成航线');
      return;
    }

    const pointsToUse = (generatedRouteTypes.includes(missionConfig.value.routeType) || isCloseRoughStage.value)
      ? scanPath.value
      : waypoints.value;

    const boundaryPoints = (effectiveRouteType.value === 'strip' || isSurfacePlannerMode.value)
      ? (scanBoundaryGroups.value[0] || scanBoundaryPoints.value)
      : waypoints.value;
    const exportMissionConfig = isCloseRoughStage.value
      ? buildMissionConfig({
          ...missionConfig.value,
          routeType: effectiveRouteType.value
        })
      : missionConfig.value;
    const kmzBlob = await generateKMZ(exportMissionConfig, pointsToUse, boundaryPoints);
    const url = URL.createObjectURL(kmzBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${missionConfig.value.missionName}.kmz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Generate KMZ failed', e);
    alert('生成 KMZ 失败: ' + e.message);
  }
};

const handleImportKMZ = async (file) => {
  try {
    const result = await parseKMZ(file);
    missionConfig.value = buildMissionConfig({ ...missionConfig.value, ...result.config });
    waypoints.value = result.waypoints;
    scanRoutes.value = [];
    scanBoundaryPoints.value = [];
    scanBoundaryGroups.value = [];
  } catch (e) {
    console.error('Import KMZ failed', e);
    alert('导入 KMZ 失败: ' + e.message);
  }
};

const saveCurrentMission = () => {
  const mission = {
    id: Date.now(),
    name: missionConfig.value.missionName,
    config: { ...missionConfig.value },
    waypoints: [...waypoints.value],
    updatedAt: Date.now()
  };

  missions.value.push(mission);
  saveMissionsToStorage();
};

// 核心生成函数（静默生成，不显示提示）
const generatePolygonRouteInternal = (showAlert = false) => {
  const isStripRoute = effectiveRouteType.value === 'strip';
  const minimumPoints = isStripRoute ? 2 : 3;
  if (waypoints.value.length < minimumPoints) {
    if (showAlert) {
      alert(isStripRoute ? '至少需要 2 个中心线点才能生成带状航线' : '至少需要 3 个边界点才能生成面状航线');
    }
    scanPath.value = [];
    scanRoutes.value = [];
    scanBoundaryPoints.value = [];
    scanBoundaryGroups.value = [];
    routeStats.value = null;
    return false;
  }
  
  try {
    const polygonConfig = missionConfig.value.polygonRoute || {};
    const routeTypeForGeneration = effectiveRouteType.value;
    
    // 准备生成选项
    const options = {
      height: missionConfig.value.globalHeight || 50,
      speed: missionConfig.value.globalSpeed || 5,
      angle: polygonConfig.angle || 0,
      margin: polygonConfig.margin || 0,
      optimizePath: polygonConfig.optimizePath !== false,
      obliquePitches: polygonConfig.obliquePitches || {}
    };
    
    // 判断间距计算方式
    if (polygonConfig.spacingMode === 'auto') {
      // 自动模式：使用相机参数
      options.useCamera = true;
      options.overlapRate = polygonConfig.overlapLateral || 0.7;
      
      if (polygonConfig.cameraPreset === 'custom') {
        options.camera = polygonConfig.customCamera;
      } else if (CAMERA_PRESETS[polygonConfig.cameraPreset]) {
        options.camera = CAMERA_PRESETS[polygonConfig.cameraPreset];
      } else {
        // 默认相机
        options.camera = CAMERA_PRESETS.m30t;
      }
    } else {
      // 手动模式：使用固定间距
      options.spacing = polygonConfig.spacing || 30;
    }
    
    console.log('生成选项:', options);
    
    let generatedPath = [];
    let generatedRoutes = [];
    let generatedBoundaryPoints = [...waypoints.value];
    let generatedBoundaryGroups = [];

    // 生成航线（面状 / 倾斜）
    if (routeTypeForGeneration === 'oblique') {
      const obliqueResult = generateObliquePolygonRoutes(waypoints.value, options);
      generatedPath = obliqueResult.waypoints;
      generatedRoutes = obliqueResult.routes;
    } else if (routeTypeForGeneration === 'strip') {
      const stripResult = generateStripRoute(waypoints.value, {
        ...options,
        leftOffset: polygonConfig.stripExpandLeft ?? 30,
        rightOffset: polygonConfig.stripExpandRight ?? 30
      });
      generatedBoundaryPoints = stripResult.boundaryPoints;
      generatedBoundaryGroups = generatedBoundaryPoints.length >= 3 ? [generatedBoundaryPoints] : [];
      generatedPath = stripResult.waypoints;
      generatedRoutes = generatedPath.length > 0
        ? [{
            name: '带状连续航线',
            color: '#f1c40f',
            directionIndex: 0,
            waypoints: generatedPath
          }]
        : [];
    } else {
      generatedPath = generatePolygonRoute(waypoints.value, options);
      generatedRoutes = [];
    }
    
    if (generatedPath.length === 0) {
      if (showAlert) {
        alert('生成失败：未能生成有效航线，请检查参数设置');
      }
      scanPath.value = [];
      scanRoutes.value = [];
      scanBoundaryPoints.value = [];
      scanBoundaryGroups.value = [];
      routeStats.value = null;
      return false;
    }
    
    scanPath.value = generatedPath;
    scanRoutes.value = generatedRoutes;
    scanBoundaryPoints.value = generatedBoundaryPoints;
    scanBoundaryGroups.value = generatedBoundaryGroups;
    routeStats.value = calculateRouteStats(generatedPath);
    
    console.log('生成完成 |', {
      航点数: generatedPath.length,
      航程: routeStats.value.totalDistance + 'm',
      时间: Math.ceil(routeStats.value.flightTime / 60) + '分钟'
    });
    
    if (showAlert) {
      const routeCountText = routeTypeForGeneration === 'oblique' ? `\n方向组数: ${generatedRoutes.length}` : '';
      alert(`航线生成成功！\n航点数: ${generatedPath.length}${routeCountText}\n航程: ${routeStats.value.totalDistance}m\n预计时间: ${Math.ceil(routeStats.value.flightTime / 60)}分钟`);
    }
    
    return true;
  } catch (error) {
    console.error('生成面状航线失败:', error);
    if (showAlert) {
      alert('生成失败: ' + error.message);
    }
    scanPath.value = [];
    scanRoutes.value = [];
    scanBoundaryPoints.value = [];
    scanBoundaryGroups.value = [];
    routeStats.value = { ...calculateRouteStats([]), error: error.message };
    return false;
  }
};

// 手动生成（带提示）
const handleGeneratePolygonRoute = () => {
  generatePolygonRouteInternal(true);
};

// 防抖定时器
let autoGenerateTimer = null;

// 自动生成航线（实时响应，带防抖）
watch(
  [
    waypoints,
    () => missionConfig.value.routeType,
    effectiveRouteType,
    () => missionConfig.value.globalHeight,
    () => missionConfig.value.globalSpeed,
    () => missionConfig.value.polygonRoute,
    () => missionConfig.value.scanSetting
  ],
  () => {
    const routeTypeForGeneration = effectiveRouteType.value;

    // 清除之前的定时器
    if (autoGenerateTimer) {
      clearTimeout(autoGenerateTimer);
    }
    
    if (routeTypeForGeneration === 'mapping' || routeTypeForGeneration === 'strip') {
      // 面状/带状航线：自动生成（300ms 防抖）
      autoGenerateTimer = setTimeout(() => {
        generatePolygonRouteInternal(false);
      }, 300);
    } else if (routeTypeForGeneration === 'oblique') {
      // 倾斜航线：达到 3 个边界点后立即生成五向航线
      if (waypoints.value.length >= 3) {
        generatePolygonRouteInternal(false);
      } else {
        scanPath.value = [];
        scanRoutes.value = [];
        scanBoundaryPoints.value = [];
        scanBoundaryGroups.value = [];
        routeStats.value = null;
      }
    } else if (routeTypeForGeneration === 'patrol') {
      // 巡逻模式：使用旧的简单扫描（即时生成）
      if (waypoints.value.length >= 3) {
        const height = missionConfig.value.globalHeight;
        const overlap = missionConfig.value.scanSetting?.overlap || 20;
        const spacing = 20 * (1 - overlap / 100);

        scanPath.value = generateScanPath(
          waypoints.value,
          spacing,
          missionConfig.value.scanSetting?.angle || 0,
          missionConfig.value.scanSetting?.margin || 0
        );
        scanRoutes.value = [];
        scanBoundaryPoints.value = [...waypoints.value];
        scanBoundaryGroups.value = [];
      } else {
        scanPath.value = [];
        scanRoutes.value = [];
        scanBoundaryPoints.value = [];
        scanBoundaryGroups.value = [];
      }
    } else if (isSurfacePlannerMode.value) {
      scanPath.value = scanPath.value.map(point => ({
        ...point,
        speed: missionConfig.value.globalSpeed || missionConfig.value.globalTransitionalSpeed || point.speed || 5
      }));
      routeStats.value = scanPath.value.length > 0 ? calculateRouteStats(scanPath.value) : null;
    } else {
      // 其他模式：清空航线
      scanPath.value = [];
      scanRoutes.value = [];
      scanBoundaryPoints.value = [];
      scanBoundaryGroups.value = [];
      routeStats.value = null;
    }
  },
  { deep: true }
);

watch(
  () => missionConfig.value.closeRoute?.workflowStage,
  (stage, previousStage) => {
    if (missionConfig.value.routeType !== 'close' || stage === previousStage || !stage || !previousStage) {
      return;
    }

    waypoints.value = [];
    scanPath.value = [];
    scanRoutes.value = [];
    scanBoundaryPoints.value = [];
    scanBoundaryGroups.value = [];
    routeStats.value = null;
  }
);

const missionStats = computed(() => {
  const points = (generatedRouteTypes.includes(missionConfig.value.routeType) || isCloseRoughStage.value)
    ? scanPath.value
    : waypoints.value;

  let distance = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const R = 6378137;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    distance += R * c;
  }

  let area = 0;
  if (effectiveRouteType.value === 'strip' || isSurfacePlannerMode.value) {
    area = scanBoundaryGroups.value.reduce((sum, boundary) => {
      return sum + (boundary.length >= 3 ? getPolygonArea(boundary) : 0);
    }, 0);
  } else if ((effectiveRouteType.value === 'mapping' || effectiveRouteType.value === 'patrol' || effectiveRouteType.value === 'oblique') && waypoints.value.length >= 3) {
    area = getPolygonArea(waypoints.value);
  }

  return {
    distance: distance,
    time: distance / (missionConfig.value.globalSpeed || 5),
    waypointCount: points.length,
    area: area
  };
});

const visibleScanRoutes = computed(() => {
  if (effectiveRouteType.value !== 'oblique') {
    return scanRoutes.value;
  }

  const visibleKeys = missionConfig.value.polygonRoute?.obliqueVisibleRoutes || ['nadir', 'front', 'back', 'left', 'right'];
  const directionKeyByIndex = ['nadir', 'front', 'back', 'left', 'right'];

  return scanRoutes.value.filter(route => visibleKeys.includes(directionKeyByIndex[route.directionIndex]));
});

const visibleScanPath = computed(() => {
  if (effectiveRouteType.value === 'oblique') {
    return [];
  }

  return scanPath.value;
});

const displayBoundaryPoints = computed(() => {
  return (effectiveRouteType.value === 'strip' || isSurfacePlannerMode.value) ? scanBoundaryPoints.value : waypoints.value;
});

const displayBoundaryGroups = computed(() => {
  if (effectiveRouteType.value === 'strip' || isSurfacePlannerMode.value) {
    return scanBoundaryGroups.value;
  }
  return displayBoundaryPoints.value.length >= 3 ? [displayBoundaryPoints.value] : [];
});
</script>
