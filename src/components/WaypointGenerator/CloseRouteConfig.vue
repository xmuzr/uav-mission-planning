<template>
  <div class="close-config">
    <div class="close-title">贴近摄影航线</div>

    <div class="workflow-card" :class="{ 'workflow-card-active': !isFineStage }">
      <div class="workflow-step">Phase 1</div>
      <div class="workflow-heading">正射 / 倾斜粗模采集</div>
      <a-form layout="vertical" class="mt-4">
        <a-form-item label="粗模采集方式">
          <a-select
            :value="localConfig.roughRouteType"
            :options="roughRouteOptions"
            @update:value="value => updateRouteConfig('roughRouteType', value)"
          />
        </a-form-item>
      </a-form>

      <div class="close-note">第一阶段用于规划采集航线。照片需在外部软件中重建；下一步加载已有三维模型。</div>
      <a-button v-if="!isFineStage" type="primary" block @click="updateWorkflowStage('fine')">
        加载已有粗模，进入贴近规划
      </a-button>
    </div>

    <div class="workflow-card" :class="{ 'workflow-card-active': isFineStage }">
      <div class="workflow-step">Phase 2</div>
      <div class="workflow-heading">三维贴近摄影规划</div>
    </div>

    <template v-if="isFineStage">
      <div class="workflow-toolbar">
        <span class="workflow-badge">已有三维瓦片模型</span>
        <a-button type="link" class="!px-0" :disabled="state.generating" @click="updateWorkflowStage('rough')">
          返回第一阶段
        </a-button>
      </div>

      <div class="action-grid">
        <a-button type="primary" @click="sendCommand('fit')" :disabled="!state.modelReady || state.generating">居中</a-button>
        <a-button type="primary" @click="sendCommand('draw')" :disabled="!state.modelReady || state.generating">选择底面</a-button>
        <a-button
          :type="state.transformMode === 'translate' ? 'primary' : 'default'"
          @click="sendCommand('translate')"
          :disabled="!state.hasArea || state.generating"
        >
          平移
        </a-button>
      </div>

      <a-form layout="vertical" class="mt-4" :disabled="state.generating">
        <a-form-item label="三维瓦片地址">
          <a-input-search v-model:value="modelUrlDraft" enter-button="加载" @search="applyModelUrl" />
        </a-form-item>
        <a-form-item label="扫描表面">
          <a-checkbox-group :value="localConfig.scanFaces" :options="scanFaceOptions" @update:value="value => updateRouteConfig('scanFaces', value)" />
        </a-form-item>
        <a-form-item label="拍摄相机参数">
          <a-select :value="localConfig.cameraPreset" :options="cameraOptions" @update:value="value => updateRouteConfig('cameraPreset', value)" />
          <div class="workflow-text">未匹配到机型时使用 M30T 参考参数；请按实际相机选择。</div>
        </a-form-item>
        <a-row :gutter="10">
          <a-col :span="12">
            <a-form-item label="底面高度 m">
              <a-input-number
                :value="localConfig.bottomHeight"
                :min="-200"
                :max="500"
                :step="0.5"
                :precision="1"
                class="w-full"
                @update:value="value => updateRouteConfig('bottomHeight', value)"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="顶面高度 m">
              <a-input-number
                :value="localConfig.topHeight"
                :min="-200"
                :max="500"
                :step="0.5"
                :precision="1"
                class="w-full"
                @update:value="value => updateRouteConfig('topHeight', value)"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="10">
          <a-col :span="12">
            <a-form-item label="贴近距离 m">
              <a-input-number
                :value="localConfig.closeDistance"
                :min="1"
                :max="15"
                :step="0.5"
                :precision="1"
                class="w-full"
                @update:value="value => updateRouteConfig('closeDistance', value)"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="飞行速度 m/s">
              <a-input-number
                :value="flightSpeed"
                :min="1"
                :max="2"
                :step="0.1"
                :precision="1"
                class="w-full"
                @update:value="updateFlightSpeed"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <a-row :gutter="10">
          <a-col :span="12">
            <a-form-item label="旁向重叠率 %">
              <a-input-number
                :value="localConfig.lateralOverlap"
                :min="0"
                :max="95"
                :step="1"
                class="w-full"
                @update:value="value => updateRouteConfig('lateralOverlap', value)"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="航向重叠率 %">
              <a-input-number
                :value="localConfig.longitudinalOverlap"
                :min="0"
                :max="95"
                :step="1"
                class="w-full"
                @update:value="value => updateRouteConfig('longitudinalOverlap', value)"
              />
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>

      <div class="result-action-grid">
        <a-button type="primary" @click="sendCommand('generate')" :loading="state.generating" :disabled="!state.hasArea || state.generating || !localConfig.scanFaces.length">生成航线</a-button>
        <a-button @click="sendCommand('clear')" :disabled="!state.hasArea">{{ state.generating ? '取消规划' : '清除' }}</a-button>
      </div>

      <div class="close-status">{{ state.statusText || '等待粗模加载完成...' }}</div>
      <div v-if="state.routeSummary?.waypointCount > 0" class="close-summary">
        扫描线 {{ state.routeSummary.scanLineCount }} 条 / 航点 {{ state.routeSummary.waypointCount }} 个
      </div>
      <div v-if="state.diagnostics" class="diagnostics">
        <strong>已探测表面拍摄安排</strong>
        <div>已安排 {{ state.diagnostics.scheduled }} / {{ state.diagnostics.detected }} 个表面采样点；待补拍 {{ state.diagnostics.uncovered }} 点。</div>
        <div>局部补拍 {{ state.diagnostics.repaired }} 点；未命中模型 {{ state.diagnostics.missing }} 条射线。</div>
        <div>过渡点 {{ state.diagnostics.connectorPointCount }} 个，不执行拍照。</div>
        <div>侧面层间距 {{ state.diagnostics.wallRowSpacing.toFixed(2) }}m，拍照间距 {{ state.diagnostics.wallPointSpacing.toFixed(2) }}m。</div>
        <div>相机：{{ state.diagnostics.cameraLabel }}；{{ state.diagnostics.normalFallback }} 点使用扫描面方向估计。</div>
      </div>
      <div class="close-note">绿点：已安排拍摄；红点：已探测但未安排。绿色线为拍摄航段，橙色虚线为过渡。检查基于现有模型，不代表现场实飞验证或连续面积覆盖率；深凹槽、桥底等未被射线探测的表面仍需单独规划。</div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { CLOSE_FACES } from '../../utils/closeRoutePlanning';

const props = defineProps({
  modelValue: {
    type: Object,
    required: true
  },
  state: {
    type: Object,
    default: () => ({})
  }
});

const emit = defineEmits(['update:modelValue', 'command']);

const defaults = {
  workflowStage: 'rough',
  roughRouteType: 'mapping',
  closeDistance: 10,
  bottomHeight: 0,
  topHeight: 20,
  lateralOverlap: 80,
  longitudinalOverlap: 70,
  scanFaces: CLOSE_FACES.map(face => face.value),
  cameraPreset: 'auto',
  modelUrl: '/models/ruansan/tileset.json'
};
const scanFaceOptions = CLOSE_FACES;
const cameraOptions = [
  { value: 'auto', label: '跟随机型（未匹配时用参考参数）' },
  { value: 'm3e', label: 'Mavic 3E' }, { value: 'm3t', label: 'Mavic 3T 广角' },
  { value: 'm30t', label: 'M30T 广角' }, { value: 'm300', label: 'M300 RTK + P1' }
];

const roughRouteOptions = [
  { label: '正射摄影', value: 'mapping' },
  { label: '倾斜摄影', value: 'oblique' }
];

const localConfig = computed(() => ({
  ...defaults,
  ...(props.modelValue.closeRoute || {})
}));
const modelUrlDraft = ref(localConfig.value.modelUrl);
watch(() => localConfig.value.modelUrl, value => { modelUrlDraft.value = value; });
const applyModelUrl = value => {
  const url = value.trim();
  if (url) updateRouteConfig('modelUrl', url);
};

const isFineStage = computed(() => localConfig.value.workflowStage === 'fine');

const flightSpeed = computed(() => {
  const speed = Number(props.modelValue.globalSpeed ?? props.modelValue.globalTransitionalSpeed);
  return Number.isFinite(speed) ? speed : (isFineStage.value ? 1.5 : 7);
});

const emitMissionUpdate = (patch = {}) => {
  emit('update:modelValue', {
    ...props.modelValue,
    ...patch
  });
};

const updateRouteConfig = (key, value) => {
  emitMissionUpdate({
    closeRoute: {
      ...localConfig.value,
      [key]: value
    }
  });
};

const updateFlightSpeed = (value) => {
  if (typeof value !== 'number') return;
  emitMissionUpdate({
    globalSpeed: value,
    globalTransitionalSpeed: value
  });
};

const updateWorkflowStage = (stage) => {
  const stagePatch = stage === 'fine'
    ? {
        globalAction: 'takePhoto',
        globalSpeed: 1.5,
        globalTransitionalSpeed: 1.5,
        gimbalPitch: 0
      }
    : {
        globalAction: 'takePhoto',
        globalSpeed: 7,
        globalTransitionalSpeed: 7,
        gimbalPitch: -90
      };

  emitMissionUpdate({
    ...stagePatch,
    closeRoute: {
      ...localConfig.value,
      workflowStage: stage
    }
  });
};

const sendCommand = (command) => {
  emit('command', command);
};
</script>

<style scoped>
.close-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.close-title {
  color: #111827;
  font-size: 18px;
  font-weight: 700;
}

.workflow-card {
  padding: 12px;
  border: 1px solid #dbe4f0;
  border-radius: 12px;
  background: #f8fbff;
}

.workflow-card-active {
  border-color: #1677ff;
  background: #eff6ff;
}

.workflow-step {
  color: #1677ff;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.workflow-heading {
  margin-top: 4px;
  color: #111827;
  font-size: 15px;
  font-weight: 700;
}

.workflow-text,
.workflow-note,
.close-note,
.close-status,
.close-summary {
  color: #4b5563;
  font-size: 13px;
  line-height: 1.5;
}
.diagnostics { padding: 12px; background: #eff6ff; border-radius: 8px; font-size: 12px; line-height: 1.8; color: #334155; }

.workflow-note {
  margin-bottom: 10px;
}

.workflow-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.workflow-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 600;
}

.action-grid,
.result-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.close-note {
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff7ed;
}

.close-status {
  min-height: 40px;
  white-space: pre-line;
}
</style>
