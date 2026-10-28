<template>
  <a-modal
    :open="visible"
    title="创建新航线"
    :width="900"
    @cancel="$emit('cancel')"
    centered
    class="create-mission-modal"
  >
    <div class="modal-content px-4">
      <div class="mb-4">
        <h3 class="section-title mb-2">巡检巡查航线</h3>
        <a-row :gutter="12">
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'waypoint' }"
              @click="form.routeType = 'waypoint'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 88 72" width="40" height="34" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M42 10L78 18L59 31L53 49L42 10Z" />
                  <path d="M42 10L59 31" />
                  <path d="M78 18L59 31" />
                  <path d="M12 20C12 15.6 15.6 12 20 12C24.4 12 28 15.6 28 20C28 25.9 20 33 20 33C20 33 12 25.9 12 20Z" />
                  <circle cx="20" cy="20" r="2.8" />
                  <path d="M58 41C58 36.6 61.6 33 66 33C70.4 33 74 36.6 74 41C74 46.9 66 54 66 54C66 54 58 46.9 58 41Z" />
                  <circle cx="66" cy="41" r="2.8" />
                  <path d="M7 54C7 49.6 10.6 46 15 46C19.4 46 23 49.6 23 54C23 59.9 15 67 15 67C15 67 7 59.9 7 54Z" />
                  <circle cx="15" cy="54" r="2.8" />
                  <path d="M21 31C27 31 32 33 37 37C42 41 48 42 58 42" />
                  <path d="M62 47C57 53 49 57 39 59C30 61 22 60 15 57" />
                  <path d="M15 60C22 60 29 60 36 58" />
                </svg>
              </div>
              <div class="route-name text-xs">航点航线</div>
            </div>
          </a-col>
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'patrol' }"
              @click="form.routeType = 'patrol'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
                  <path d="M12 7v5l3 3" />
                </svg>
              </div>
              <div class="route-name text-xs">巡逻航线</div>
            </div>
          </a-col>
        </a-row>
      </div>

      <div class="mb-4">
        <h3 class="section-title mb-2">测绘航线</h3>
        <a-row :gutter="12">
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'mapping' }"
              @click="form.routeType = 'mapping'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M4 4h16v16H4z" stroke-dasharray="2 2" />
                  <path d="M6 8h8M14 8v4M14 12H6M6 12v4M6 16h8" />
                </svg>
              </div>
              <div class="route-name text-xs">面状航线</div>
            </div>
          </a-col>
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'oblique' }"
              @click="form.routeType = 'oblique'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M4 16l4-8 12 2-4 8-12-2z" />
                  <path d="M8 8l-3 6" />
                </svg>
              </div>
              <div class="route-name text-xs">倾斜航线</div>
            </div>
          </a-col>
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'strip' }"
              @click="form.routeType = 'strip'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M4 12c0-4 2-8 6-8s6 4 6 8s2 8 6 8" />
                </svg>
              </div>
              <div class="route-name text-xs">带状航线</div>
            </div>
          </a-col>
        </a-row>
      </div>

      <div class="mb-4">
        <h3 class="section-title mb-2">精细化测绘航线</h3>
        <a-row :gutter="12">
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'slope' }"
              @click="form.routeType = 'slope'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M2 22L12 2L22 22H2Z" />
                </svg>
              </div>
              <div class="route-name text-xs">斜面航线</div>
            </div>
          </a-col>
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'geometry' }"
              @click="form.routeType = 'geometry'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <div class="route-name text-xs">几何体航线</div>
            </div>
          </a-col>
          <a-col :span="6">
            <div
              class="route-card"
              :class="{ 'route-card-active': form.routeType === 'close' }"
              @click="form.routeType = 'close'"
            >
              <div class="route-icon mb-2">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M8 2v4M16 2v4M8 18v4M16 18v4" />
                </svg>
              </div>
              <div class="route-name text-xs">贴近摄影航线</div>
            </div>
          </a-col>
        </a-row>
      </div>

      <div class="mb-4">
        <h3 class="section-title mb-2">选择飞行器</h3>
        <a-row :gutter="12">
          <a-col :span="4" v-for="aircraft in aircraftSeriesList" :key="aircraft.id">
            <div
              class="aircraft-card"
              :class="{ 'aircraft-card-active': form.aircraftSeries === aircraft.id }"
              @click="selectSeries(aircraft.id)"
            >
              {{ aircraft.name }}
            </div>
          </a-col>
        </a-row>
      </div>

      <div class="mb-4">
        <h3 class="section-title mb-2">选择型号</h3>
        <a-row :gutter="12">
          <a-col :span="4" v-for="model in currentModels" :key="model.id">
            <div
              class="aircraft-card"
              :class="{ 'aircraft-card-active': form.aircraftModel === model.id }"
              @click="form.aircraftModel = model.id"
            >
              {{ model.name }}
            </div>
          </a-col>
        </a-row>
      </div>

      <div class="mb-0">
        <h3 class="section-title mb-2">航线名称</h3>
        <a-input
          v-model:value="form.missionName"
          placeholder="请输入航线名称"
        />
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-3">
        <a-button @click="$emit('cancel')">取消</a-button>
        <a-button type="primary" @click="handleConfirm">确定</a-button>
      </div>
    </template>
  </a-modal>
</template>

<script setup>
import { computed, reactive, watch } from 'vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['cancel', 'confirm']);

const aircraftData = {
  m30: {
    name: '经纬 M30 系列',
    models: [
      { id: 'm30', name: 'Matrice 30', enumValue: 67, payloadValue: 52 },
      { id: 'm30t', name: 'Matrice 30T', enumValue: 67, payloadValue: 53 }
    ]
  },
  m3e: {
    name: 'Mavic 3 行业系列',
    models: [
      { id: 'm3e', name: 'Mavic 3E', enumValue: 77, payloadValue: 66 },
      { id: 'm3t', name: 'Mavic 3T', enumValue: 77, payloadValue: 67 },
      { id: 'm3m', name: 'Mavic 3M', enumValue: 77, payloadValue: 68 }
    ]
  },
  m3d: {
    name: 'Matrice 3D 系列',
    models: [
      { id: 'm3d', name: 'Matrice 3D', enumValue: 90, payloadValue: 80 },
      { id: 'm3td', name: 'Matrice 3TD', enumValue: 90, payloadValue: 81 }
    ]
  },
  m4e: {
    name: 'Matrice 4 行业系列',
    models: [
      { id: 'm4e', name: 'Matrice 4E', enumValue: 99, payloadValue: 88 },
      { id: 'm4t', name: 'Matrice 4T', enumValue: 99, payloadValue: 89 }
    ]
  },
  m4d: {
    name: 'Matrice 4D 系列',
    models: [
      { id: 'm4d', name: 'Matrice 4D', enumValue: 101, payloadValue: 90 }
    ]
  },
  m400: {
    name: 'Matrice 400',
    models: [
      { id: 'm400', name: 'Matrice 400', enumValue: 100, payloadValue: 0 }
    ]
  }
};

const aircraftSeriesList = Object.keys(aircraftData).map((key) => ({
  id: key,
  name: aircraftData[key].name
}));

const defaultMissionNames = {
  geometry: '新建几何体航线',
  slope: '新建斜面航线',
  waypoint: '新建航点航线',
  patrol: '新建巡逻航线',
  mapping: '新建面状航线',
  oblique: '新建倾斜航线',
  strip: '新建带状航线',
  close: '新建贴近摄影航线'
};

const form = reactive({
  routeType: 'patrol',
  aircraftSeries: 'm4e',
  aircraftModel: 'm4t',
  missionName: defaultMissionNames.patrol
});

watch(() => form.routeType, (newType) => {
  form.missionName = defaultMissionNames[newType] || '新建航线';
});

const currentModels = computed(() => aircraftData[form.aircraftSeries]?.models || []);

const selectSeries = (seriesId) => {
  form.aircraftSeries = seriesId;
  if (aircraftData[seriesId]?.models.length > 0) {
    form.aircraftModel = aircraftData[seriesId].models[0].id;
  }
};

const handleConfirm = () => {
  const series = aircraftData[form.aircraftSeries];
  const model = series?.models.find((item) => item.id === form.aircraftModel);

  emit('confirm', {
    ...form,
    droneEnumValue: model?.enumValue,
    payloadEnumValue: model?.payloadValue
  });
};
</script>

<style scoped>
.modal-content {
  padding: 0;
}

.section-title {
  font-size: 13px;
  color: #9ca3af;
  margin-bottom: 8px;
  font-weight: 500;
}

.route-card {
  background: #f9fafb;
  border: 2px solid transparent;
  border-radius: 6px;
  padding: 16px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transition: all 0.3s;
  min-height: 90px;
}

.route-card:hover:not(.route-card-disabled) {
  background: #f3f4f6;
  transform: translateY(-2px);
}

.route-card-active {
  background: #dbeafe !important;
  border-color: #3498db !important;
}

.route-card-disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.route-icon {
  margin-bottom: 8px;
  color: #6b7280;
}

.route-card-active .route-icon {
  color: #3498db;
}

.route-name {
  font-size: 12px;
  color: #374151;
  font-weight: 500;
  text-align: center;
}

.aircraft-card {
  background: #f9fafb;
  border: 2px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px 4px;
  cursor: pointer;
  text-align: center;
  font-size: 12px;
  color: #374151;
  transition: all 0.3s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aircraft-card:hover {
  background: #f3f4f6;
  border-color: #d1d5db;
}

.aircraft-card-active {
  background: #3498db !important;
  border-color: #3498db !important;
  color: #fff !important;
  font-weight: 600;
}
</style>
