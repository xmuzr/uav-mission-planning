<template>
  <div class="geometry-config">
    <div class="geometry-title">几何体航线</div>

    <div class="single-action-row">
      <a-button type="primary" @click="sendCommand('fit')" :disabled="!state.modelReady">居中</a-button>
    </div>

    <a-form layout="vertical" class="mt-4">
      <a-form-item label="几何体类型">
        <a-select :value="localConfig.geometryType" @update:value="val => updateConfig('geometryType', val)">
          <a-select-option value="box">长方体</a-select-option>
          <a-select-option value="cylinder">圆柱体</a-select-option>
        </a-select>
      </a-form-item>

      <div v-if="localConfig.geometryType === 'box'" class="single-action-row">
        <a-button type="primary" @click="sendCommand('draw')" :disabled="!state.modelReady">选择八点</a-button>
      </div>

      <div v-else-if="localConfig.geometryType === 'cylinder'" class="single-action-row">
        <a-button type="primary" @click="sendCommand('draw')" :disabled="!state.modelReady">选择三点</a-button>
      </div>

      <div class="single-action-row transform-action-row">
        <a-button
          :type="state.transformMode === 'translate' ? 'primary' : 'default'"
          @click="sendCommand('translate')"
          :disabled="!state.hasArea"
        >移动</a-button>
      </div>

      <a-row v-if="localConfig.geometryType === 'cylinder'" :gutter="10" class="radius-field-row">
        <a-col :span="24">
          <a-form-item label="半径 m">
            <a-input-number
              :value="displayRadius"
              :min="0.2"
              :step="0.5"
              :precision="2"
              class="w-full"
              @update:value="updateCylinderRadius"
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
              @update:value="val => updateConfig('lateralOverlap', val)"
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
              @update:value="val => updateConfig('longitudinalOverlap', val)"
            />
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="10">
        <a-col :span="24">
          <a-form-item label="表面距离 m">
            <a-input-number
              :value="localConfig.offset"
              :min="0"
              :step="0.5"
              class="w-full"
              @update:value="val => updateConfig('offset', val)"
            />
          </a-form-item>
        </a-col>
      </a-row>
    </a-form>

    <div class="result-action-grid">
      <a-button type="primary" @click="sendCommand('generate')" :disabled="!state.hasArea">生成航线</a-button>
      <a-button @click="sendCommand('clear')" :disabled="!state.hasArea">清除</a-button>
    </div>

    <div class="geometry-status">{{ state.statusText || '等待 3D 视图初始化...' }}</div>
    <div v-if="state.routeSummary?.waypointCount > 0" class="geometry-summary">
      扫描层 / 条 {{ state.routeSummary.scanLineCount }} / 航点 {{ state.routeSummary.waypointCount }} 个
    </div>
    <CoveragePreviewControls :preview="state.preview || {}" :has-route="state.routeSummary?.waypointCount > 0" @command="sendCommand" />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import CoveragePreviewControls from './CoveragePreviewControls.vue';

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
  geometryType: 'box',
  radiusOffset: 0,
  lateralOverlap: 80,
  longitudinalOverlap: 80,
  offset: 20
};

const localConfig = computed(() => ({
  ...defaults,
  ...(props.modelValue.geometryRoute || {})
}));
const roundRadius = (value) => Number(Math.max(0.2, value).toFixed(2));

const displayRadius = computed(() => {
  const baseRadius = Number(props.state?.baseRadius);
  if (Number.isFinite(baseRadius) && baseRadius > 0) {
    return roundRadius(baseRadius + (Number(localConfig.value.radiusOffset) || 0));
  }

  const currentRadius = Number(props.state?.currentRadius);
  if (Number.isFinite(currentRadius) && currentRadius > 0) {
    return roundRadius(currentRadius);
  }

  return roundRadius(Number(localConfig.value.radiusOffset) || 0.2);
});

const updateConfig = (key, value) => {
  emit('update:modelValue', {
    ...props.modelValue,
    geometryRoute: {
      ...localConfig.value,
      [key]: value
    }
  });
};

const updateCylinderRadius = (value) => {
  const nextRadius = Number(value);
  if (!Number.isFinite(nextRadius)) return;

  const baseRadius = Number(props.state?.baseRadius);
  const radiusOffset = Number.isFinite(baseRadius)
    ? nextRadius - baseRadius
    : nextRadius;

  updateConfig('radiusOffset', Number(radiusOffset.toFixed(3)));
};

const sendCommand = (command) => {
  emit('command', command);
};
</script>

<style scoped>
.geometry-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.geometry-title {
  color: #111827;
  font-size: 18px;
  font-weight: 700;
}

.single-action-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.transform-action-row {
  margin-top: 16px;
  margin-bottom: 12px;
}

.radius-field-row {
  margin-top: 4px;
}

.result-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.geometry-status {
  min-height: 40px;
  color: #374151;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-line;
}

.geometry-summary {
  color: #6b7280;
  font-size: 12px;
}
</style>
