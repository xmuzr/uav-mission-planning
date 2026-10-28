<template>
  <section class="coverage-controls">
    <h3>飞行与拍摄模拟</h3>
    <div class="preview-note">根据蓝色几何体和规划航线模拟拍照，不代表无人机实际拍摄记录。</div>
    <div class="preview-actions">
      <a-button type="primary" :disabled="!hasRoute || generating" :loading="preview.phase === 'preparing'" @click="$emit('command', 'preview-play')">{{ playLabel }}</a-button>
      <a-button :disabled="preview.phase !== 'playing'" @click="$emit('command', 'preview-pause')">暂停</a-button>
      <a-button :disabled="!prepared" @click="$emit('command', 'preview-reset')">重置</a-button>
    </div>
    <div class="speed-row">
      <label>播放速度</label>
      <a-select v-model:value="speed" aria-label="模拟播放速度" @change="value => $emit('command', { type: 'preview-speed', value })">
        <a-select-option v-for="value in [1, 5, 20, 50, 100]" :key="value" :value="value">{{ value }} 倍</a-select-option>
      </a-select>
    </div>
    <a-alert v-if="preview.error" type="warning" :message="preview.error" show-icon />
    <template v-if="prepared">
      <div class="progress-label"><span>{{ phaseLabel }} · 飞行进度</span><span>{{ preview.flightPercent || 0 }}%</span></div>
      <a-progress :percent="preview.flightPercent || 0" :show-info="false" :status="preview.phase === 'playing' ? 'active' : 'normal'" />
      <div class="preview-metrics">
        <div><strong>{{ preview.photoCount || 0 }} / {{ preview.totalPhotos || 0 }}</strong><span>模拟拍照张数</span></div>
        <div><strong>{{ preview.coveragePercent || 0 }}%</strong><span>有效采样覆盖</span></div>
        <div><strong>{{ preview.unseen || 0 }}</strong><span>未达标采样点</span></div>
      </div>
      <div class="preview-note">已覆盖 {{ preview.covered || 0 }} / {{ preview.targetCount || 0 }} 点，观测至少两次 {{ preview.repeated || 0 }} 点。</div>
      <div class="preview-note">当前可有效拍摄 {{ preview.currentVisible || 0 }} 点；累计覆盖在模拟拍照时更新。</div>
      <div v-if="preview.layerBand" class="layer-band">
        <strong>当前第 {{ preview.layerBand.currentLayer }} / {{ preview.layerBand.totalLayers }} 个航线高度层</strong>
        <div>本层正拍覆盖高度约 {{ preview.layerBand.span.toFixed(1) }}m，上下各约 {{ preview.layerBand.halfSpan.toFixed(1) }}m。</div>
        <div>相对几何体底部 {{ preview.layerBand.minHeight.toFixed(1) }}～{{ preview.layerBand.maxHeight.toFixed(1) }}m。</div>
        <div v-if="preview.layerBand.layerCount">该高度带含规划第 {{ preview.layerBand.firstLayer }}～{{ preview.layerBand.lastLayer }} 层，共 {{ preview.layerBand.layerCount }} 层。</div>
        <div>按正对侧面和设定距离估算；具体点仍需满足视场与有效条件。这里的层是规划高度层。</div>
      </div>
      <div v-if="preview.quality" class="preview-note">有效条件：偏离表面法线 ≤{{ preview.quality.maxIncidenceDegrees }}°，估算像元尺寸 ≤{{ preview.quality.maxGsdCm.toFixed(2) }}cm/像素（正拍基准 {{ preview.quality.referenceGsdCm.toFixed(2) }}cm 的 {{ preview.quality.maxGsdRatio }} 倍）。这是模拟阈值，实际清晰度需照片检验。</div>
      <div class="preview-actions two-columns">
        <a-button :type="preview.showFrustum ? 'primary' : 'default'" @click="$emit('command', 'preview-frustum')">相机视锥</a-button>
        <a-button :type="preview.showCoverage ? 'primary' : 'default'" @click="$emit('command', 'preview-coverage')">覆盖着色</a-button>
      </div>
      <div class="preview-note">黄点是当前符合条件的点，绿点是累计有效覆盖，红点尚未达标；黄色线框是光学视场，线框内的点还需通过角度和分辨率检查。不计周边建筑遮挡。</div>
      <div class="preview-note">相机：{{ preview.cameraLabel }}。统计 {{ preview.targetCount }} 个几何体表面采样点，不代表连续面积覆盖率或重建质量。</div>
    </template>
    <div v-else-if="!preview.error && preview.phase !== 'preparing'" class="preview-note">生成航线后，点击开始模拟即可查看飞行、拍照和覆盖变化。</div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue';
const props = defineProps({ preview: { type: Object, default: () => ({}) }, hasRoute: Boolean, generating: Boolean });
defineEmits(['command']);
const speed = ref(20);
const prepared = computed(() => ['ready', 'playing', 'paused', 'finished'].includes(props.preview.phase));
const phaseLabel = computed(() => ({ ready: '待播放', playing: '模拟中', paused: '已暂停', finished: '模拟结束' }[props.preview.phase] || '模拟'));
const playLabel = computed(() => props.preview.phase === 'paused' ? '继续模拟' : props.preview.phase === 'finished' ? '重新模拟' : '开始模拟');
</script>

<style scoped>
.coverage-controls { border: 1px solid #dbeafe; background: #f8fbff; padding: 14px; border-radius: 8px; margin-top: 8px; display: flex; flex-direction: column; gap: 10px; }
h3 { font-size: 15px; color: #172554; margin: 0; }
.preview-note { font-size: 12px; color: #64748b; line-height: 1.6; }
.layer-band { padding: 10px; background: #eff6ff; border-radius: 6px; color: #334155; font-size: 12px; line-height: 1.8; }
.preview-actions { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 6px; }
.two-columns { grid-template-columns: 1fr 1fr; }
.speed-row, .progress-label { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #475569; }
.speed-row :deep(.ant-select) { width: 110px; }
.preview-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.preview-metrics > div { display: flex; flex-direction: column; gap: 4px; }
.preview-metrics strong { color: #0f172a; font-size: 15px; }
.preview-metrics span { color: #64748b; font-size: 11px; }
</style>
