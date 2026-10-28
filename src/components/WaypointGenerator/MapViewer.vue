<template>
  <div class="relative w-full h-full absolute inset-0">
    <vc-viewer 
      @ready="onViewerReady" 
      :camera="camera" 
      @left-click="onMapClick"
      :animation="false"
      :timeline="false"
      :base-layer-picker="false"
    >
      <vc-navigation></vc-navigation>
      
      <!-- Waypoints (User Clicks) -->
      <vc-entity
        v-for="(wp, index) in displayWaypoints"
        :key="'wp-' + index"
        :position="wp"
        :point="pointGraphics"
        :label="{
          text: (index + 1).toString(),
          font: '14px sans-serif',
          pixelOffset: [0, -20],
          horizontalOrigin: 0,
          verticalOrigin: 1,
          fillColor: 'white',
          outlineColor: 'black',
          outlineWidth: 2
        }"
      >
      </vc-entity>

      <!-- Polygon Area (Patrol Mode) -->
      <template v-if="isPatrolMode">
        <vc-entity
          v-for="(boundary, index) in visibleBoundaryGroups"
          :key="`boundary-${index}`"
        >
          <vc-graphics-polygon
            :hierarchy="boundary"
            :material="'rgba(52, 152, 219, 0.3)'"
            :outline="true"
            :outlineColor="'#3498db'"
          ></vc-graphics-polygon>
        </vc-entity>
      </template>

      <vc-entity v-if="showStripCenterLine">
        <vc-graphics-polyline
          :positions="waypointPositions"
          :material="'#3498db'"
          :width="3"
        ></vc-graphics-polyline>
      </vc-entity>

      <!-- Connection Lines (Normal Mode) -->
      <vc-entity v-else-if="showConnectionLine">
        <vc-graphics-polyline
          :positions="waypointPositions"
          :material="'#3498db'"
          :width="3"
        ></vc-graphics-polyline>
      </vc-entity>

      <!-- Generated Scan Path (S-Shape) -->
      <vc-entity v-if="showScanPath">
        <vc-graphics-polyline
          :positions="scanPathPositions"
          :material="'#f1c40f'"
          :width="4"
        ></vc-graphics-polyline>
      </vc-entity>

      <!-- Oblique Routes (Grouped, Multi-color) -->
      <template v-if="visibleScanRoutes.length > 0">
        <vc-entity
          v-for="route in visibleScanRoutes"
          :key="`scan-route-${route.directionIndex}`"
        >
          <vc-graphics-polyline
            v-if="routePositions(route).length > 1"
            :positions="routePositions(route)"
            :material="route.color || '#3498db'"
            :width="3"
          ></vc-graphics-polyline>
        </vc-entity>
      </template>
    </vc-viewer>
    
    <!-- Coordinate System Info -->
    <div class="absolute bottom-5 right-5 bg-white/95 p-3.5 rounded-lg shadow-md z-10 backdrop-blur-sm">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs text-gray-500 font-medium">坐标系统</span>
        <span class="text-sm font-bold text-green-500 bg-green-50 py-1 px-2.5 rounded font-mono">WGS84</span>
      </div>
      <div class="text-[11px] text-green-600 font-medium">✓ 大疆航线标准坐标</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  waypoints: {
    type: Array,
    default: () => []
  },
  boundaryPoints: {
    type: Array,
    default: () => []
  },
  boundaryGroups: {
    type: Array,
    default: () => []
  },
  routeType: {
    type: String,
    default: 'waypoint'
  },
  isClosedLoop: {
    type: Boolean,
    default: false
  },
  isPatrolMode: {
    type: Boolean,
    default: false
  },
  scanPath: {
    type: Array,
    default: () => []
  },
  scanRoutes: {
    type: Array,
    default: () => []
  },
  clickable: {
    type: Boolean,
    default: true
  }
});

watch(() => props.scanPath, (val) => {
  console.log('MapViewer received scanPath:', val.length);
}, { deep: true });

watch(() => props.isPatrolMode, (val) => {
  console.log('MapViewer isPatrolMode:', val);
});

const emit = defineEmits(['map-click']);

const camera = ref({
  position: {
    lng: 104.39, 
    lat: 31.09,
    height: 1000
  },
  heading: 360,
  pitch: -90,
  roll: 0
});

const pointGraphics = {
  pixelSize: 10,
  color: 'red',
  outlineColor: 'white',
  outlineWidth: 2
};

let cesiumInstance = null;
let viewerInstance = null;

const normalizePosition = (wp) => {
  if (!wp) return null;
  const lng = Number(wp.lng);
  const lat = Number(wp.lat);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }

  // The map editor shows ground footprints, matching the surface picked by a click
  // and the polygon boundary. Keep flight altitude in the original mission data;
  // rendering it here lifts points off the map and introduces perspective offsets.
  return { lng, lat, height: 0 };
};

const displayWaypoints = computed(() => {
  return props.waypoints
    .map(normalizePosition)
    .filter(Boolean);
});

const waypointPositions = computed(() => {
  const positions = [...displayWaypoints.value];
  // Normal mode closed loop logic
  if (!props.isPatrolMode && props.isClosedLoop && positions.length >= 2) {
    positions.push(positions[0]);
  }
  return positions;
});

const polygonBoundaryPositions = computed(() => {
  const source = props.boundaryPoints.length > 0 ? props.boundaryPoints : props.waypoints;
  return source
    .map(normalizePosition)
    .filter(Boolean);
});

const polygonBoundaryGroups = computed(() => {
  if (props.boundaryGroups.length > 0) {
    return props.boundaryGroups
      .map(group => group.map(normalizePosition).filter(Boolean))
      .filter(group => group.length > 2);
  }
  return polygonBoundaryPositions.value.length > 2 ? [polygonBoundaryPositions.value] : [];
});

const visibleBoundaryGroups = computed(() => {
  return props.isPatrolMode ? polygonBoundaryGroups.value : [];
});

const scanPathPositions = computed(() => {
  return props.scanPath
    .map(normalizePosition)
    .filter(Boolean);
});

const visibleScanRoutes = computed(() => {
  return props.isPatrolMode ? props.scanRoutes : [];
});

const showStripCenterLine = computed(() => {
  return props.routeType === 'strip' && waypointPositions.value.length > 1;
});

const showConnectionLine = computed(() => {
  return !props.isPatrolMode && waypointPositions.value.length > 1;
});

const showScanPath = computed(() => {
  return props.isPatrolMode && scanPathPositions.value.length > 1 && visibleScanRoutes.value.length === 0;
});

const routePositions = (route) => {
  const waypoints = route?.waypoints || [];
  return waypoints
    .map(normalizePosition)
    .filter(Boolean);
};

const onViewerReady = ({ Cesium, viewer }) => {
  console.log('Viewer ready');
  cesiumInstance = Cesium;
  viewerInstance = viewer;
  
  viewer.imageryLayers.removeAll();
  
  const amapProvider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://webst02.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    minimumLevel: 3,
    maximumLevel: 18
  });
  
  viewer.imageryLayers.addImageryProvider(amapProvider);
};

const onMapClick = (e) => {
  if (!props.clickable) return;
  if (!viewerInstance || !cesiumInstance) return;
  
  try {
    const windowPosition = e.windowPosition || e.position;
    if (!windowPosition) return;
    
    const ray = viewerInstance.camera.getPickRay(windowPosition);
    if (!ray) return;
    
    const cartesian3 = viewerInstance.scene.globe.pick(ray, viewerInstance.scene);
    if (!cartesian3) return;
    
    const cartographic = cesiumInstance.Cartographic.fromCartesian(cartesian3);
    if (!cartographic) return;
    
    const lng = cesiumInstance.Math.toDegrees(cartographic.longitude);
    const lat = cesiumInstance.Math.toDegrees(cartographic.latitude);
    
    emit('map-click', { lat, lng });
  } catch (error) {
    console.error('Map click error:', error);
  }
};
</script>
