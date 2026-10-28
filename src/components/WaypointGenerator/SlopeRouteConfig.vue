<template>
  <div class="slope-config">
    <div class="slope-title">斜面航线</div>

    <div class="action-grid">
      <a-button type="primary" @click="sendCommand('fit')" :disabled="!state.modelReady">居中</a-button>
      <a-button type="primary" @click="sendCommand('draw')" :disabled="!state.modelReady">绘制测区</a-button>
      <a-button
        :type="state.transformMode === 'translate' ? 'primary' : 'default'"
        @click="sendCommand('translate')"
        :disabled="!state.hasArea"
      >
        平移
      </a-button>
      <a-button
        :type="state.transformMode === 'rotate' ? 'primary' : 'default'"
        @click="sendCommand('rotate')"
        :disabled="!state.hasArea"
      >
        旋转
      </a-button>
    </div>

    <a-form layout="vertical" class="mt-4">
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
        <a-col :span="12">
          <a-form-item label="离立面距离 m">
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
      <a-button
        :type="localConfig.reverseSide ? 'primary' : 'default'"
        @click="updateConfig('reverseSide', !localConfig.reverseSide)"
        :disabled="!state.hasArea || !(state.routeSummary?.waypointCount > 0)"
        title="将航线切换到测区平面的另一侧，离面距离保持不变"
      >反向航线</a-button>
      <a-button @click="sendCommand('clear')" :disabled="!state.hasArea">清除</a-button>
    </div>

    <div class="slope-status">{{ state.statusText || '等待 3D 视图初始化...' }}</div>
    <div v-if="state.routeSummary?.waypointCount > 0" class="slope-summary">
      扫描线 {{ state.routeSummary.scanLineCount }} 条 / 航点 {{ state.routeSummary.waypointCount }} 个
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

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
  lateralOverlap: 80,
  longitudinalOverlap: 80,
  offset: 20,
  reverseSide: false
};

const localConfig = computed(() => ({
  ...defaults,
  ...(props.modelValue.slopeRoute || {})
}));

const updateConfig = (key, value) => {
  emit('update:modelValue', {
    ...props.modelValue,
    slopeRoute: {
      ...localConfig.value,
      [key]: value
    }
  });
};

const sendCommand = (command) => {
  emit('command', command);
};
</script>

<style scoped>
.slope-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.slope-title {
  color: #111827;
  font-size: 18px;
  font-weight: 700;
}

.action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.result-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.slope-status {
  min-height: 40px;
  color: #374151;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-line;
}

.slope-summary {
  color: #6b7280;
  font-size: 12px;
}
</style>
