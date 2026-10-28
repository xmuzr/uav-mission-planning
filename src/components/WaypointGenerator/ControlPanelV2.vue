<template>
  <div class="relative w-full h-full bg-white shadow-lg flex flex-col overflow-hidden font-sans border-r border-gray-200">
    <div class="p-4 bg-white border-b border-gray-200 flex flex-col gap-3 shrink-0">
      <div class="flex justify-between items-center">
        <div class="flex items-center gap-2">
          <a-button type="text" @click="$emit('back')">
            <template #icon><span>←</span></template>
          </a-button>
          <h1 class="text-lg text-gray-800 m-0 font-bold">航线编辑</h1>
        </div>
        <a-button type="text" @click="$emit('save')">
          <template #icon><span>💾</span></template>
        </a-button>
      </div>

      <div class="flex gap-2">
        <a-upload
          accept=".kmz"
          :show-upload-list="false"
          :before-upload="handleBeforeUpload"
          class="flex-1"
        >
          <a-button block size="small">
            <template #icon><span>📥</span></template>
            导入 KMZ
          </a-button>
        </a-upload>
        <a-button type="primary" block size="small" class="flex-1" :disabled="closeState.generating" @click="$emit('generate')">
          生成 KMZ
        </a-button>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-2 px-6 py-3 bg-white border-b border-gray-200 shrink-0">
      <div class="flex flex-col items-center min-h-[38px]" :class="{ invisible: waypoints.length === 0 }">
        <span class="text-xs text-gray-500 mb-1">总距离</span>
        <span class="text-sm font-semibold text-gray-800">{{ formatNumber(missionStats.distance) }} m</span>
      </div>
      <div class="flex flex-col items-center min-h-[38px]" :class="{ invisible: waypoints.length === 0 }">
        <span class="text-xs text-gray-500 mb-1">预计耗时</span>
        <span class="text-sm font-semibold text-gray-800">{{ formatTime(missionStats.time) }}</span>
      </div>
      <div class="flex flex-col items-center min-h-[38px]" :class="{ invisible: waypoints.length === 0 || missionStats.area <= 0 }">
        <span class="text-xs text-gray-500 mb-1">覆盖面积</span>
        <span class="text-sm font-semibold text-gray-800">{{ formatArea(missionStats.area) }}</span>
      </div>
    </div>

    <div class="overflow-y-auto p-6 flex flex-col gap-6 flex-1">
      <a-tabs v-model:activeKey="activeTab">
        <a-tab-pane key="config" tab="任务配置">
          <SlopeRouteConfig
            v-if="missionConfig.routeType === 'slope'"
            v-model="localMissionConfig"
            :state="slopeState"
            @command="$emit('slope-command', $event)"
          />
          <GeometryRouteConfig
            v-else-if="missionConfig.routeType === 'geometry'"
            v-model="localMissionConfig"
            :state="geometryState"
            @command="$emit('geometry-command', $event)"
          />
          <template v-else-if="missionConfig.routeType === 'close'">
            <CloseRouteConfig
              v-model="localMissionConfig"
              :state="closeState"
              @command="$emit('close-command', $event)"
            />
            <MissionConfig v-if="isCloseRoughStage" v-model="closeRoughMissionConfig" class="mt-6" />
          </template>
          <MissionConfig v-else v-model="localMissionConfig" />
        </a-tab-pane>
        <a-tab-pane key="polygon" :tab="polygonTabLabel" v-if="isPolygonMode">
          <PolygonRouteConfig
            v-model="polygonMissionConfig"
            :waypoints="waypoints"
            :route-stats="routeStats"
            @generate="$emit('generate-polygon')"
          />
        </a-tab-pane>
        <a-tab-pane key="waypoints" tab="航点列表">
          <WaypointList
            :waypoints="waypoints"
            @update:waypoints="$emit('update:waypoints', $event)"
            @remove="$emit('remove-waypoint', $event)"
            @clear="$emit('clear-waypoints')"
            @reverse="$emit('reverse-waypoints')"
          />
        </a-tab-pane>
      </a-tabs>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { formatTime } from '../../utils/geoUtils';
import CloseRouteConfig from './CloseRouteConfig.vue';
import MissionConfig from './MissionConfig.vue';
import GeometryRouteConfig from './GeometryRouteConfig.vue';
import PolygonRouteConfig from './PolygonRouteConfig.vue';
import SlopeRouteConfig from './SlopeRouteConfig.vue';
import WaypointList from './WaypointList.vue';

const props = defineProps({
  missionConfig: {
    type: Object,
    required: true
  },
  waypoints: {
    type: Array,
    required: true
  },
  missionStats: {
    type: Object,
    default: () => ({ area: 0, distance: 0, time: 0 })
  },
  routeStats: {
    type: Object,
    default: null
  },
  slopeState: {
    type: Object,
    default: () => ({})
  },
  geometryState: {
    type: Object,
    default: () => ({})
  },
  closeState: {
    type: Object,
    default: () => ({})
  }
});

const emit = defineEmits([
  'update:missionConfig',
  'update:waypoints',
  'remove-waypoint',
  'clear-waypoints',
  'reverse-waypoints',
  'generate',
  'generate-polygon',
  'import-kmz',
  'slope-command',
  'geometry-command',
  'close-command',
  'create-mission',
  'back',
  'save'
]);

const activeTab = ref('config');

const isCloseRoughStage = computed(() => {
  return props.missionConfig.routeType === 'close'
    && props.missionConfig.closeRoute?.workflowStage !== 'fine';
});

const closeRoughRouteType = computed(() => {
  return props.missionConfig.closeRoute?.roughRouteType === 'oblique' ? 'oblique' : 'mapping';
});

watch(
  [
    () => props.missionConfig.routeType,
    () => props.missionConfig.closeRoute?.workflowStage
  ],
  ([routeType, workflowStage]) => {
    const shouldForceConfig = routeType === 'slope'
      || routeType === 'geometry'
      || (routeType === 'close' && workflowStage === 'fine');

    if (shouldForceConfig && activeTab.value === 'polygon') {
      activeTab.value = 'config';
    }
  }
);

const isPolygonMode = computed(() => {
  if (isCloseRoughStage.value) {
    return true;
  }

  return ['mapping', 'polygon', 'oblique', 'strip'].includes(props.missionConfig.routeType);
});

const polygonTabLabel = computed(() => {
  if (isCloseRoughStage.value) {
    return closeRoughRouteType.value === 'oblique' ? '倾斜航线' : '正射航线';
  }
  if (props.missionConfig.routeType === 'oblique') return '倾斜航线';
  if (props.missionConfig.routeType === 'strip') return '带状航线';
  return '面状航线';
});

const localMissionConfig = computed({
  get: () => props.missionConfig,
  set: (val) => emit('update:missionConfig', val)
});

const closeRoughMissionConfig = computed({
  get: () => ({
    ...props.missionConfig,
    routeType: closeRoughRouteType.value
  }),
  set: (val) => {
    emit('update:missionConfig', {
      ...props.missionConfig,
      ...val,
      routeType: 'close',
      closeRoute: {
        ...(props.missionConfig.closeRoute || {}),
        ...(val.closeRoute || {}),
        workflowStage: props.missionConfig.closeRoute?.workflowStage || 'rough',
        roughRouteType: props.missionConfig.closeRoute?.roughRouteType || closeRoughRouteType.value
      }
    });
  }
});

const polygonMissionConfig = computed({
  get: () => (isCloseRoughStage.value ? closeRoughMissionConfig.value : localMissionConfig.value),
  set: (val) => {
    if (isCloseRoughStage.value) {
      closeRoughMissionConfig.value = val;
      return;
    }
    localMissionConfig.value = val;
  }
});

const formatArea = (areaM2) => {
  if (!areaM2 || Number.isNaN(areaM2)) return '0 m²';
  return `${Math.round(areaM2)} m²`;
};

const formatNumber = (num) => {
  if (!num || Number.isNaN(num)) return '0';
  return Math.round(num);
};

const handleBeforeUpload = (file) => {
  emit('import-kmz', file);
  return false;
};
</script>

<style scoped>
</style>
