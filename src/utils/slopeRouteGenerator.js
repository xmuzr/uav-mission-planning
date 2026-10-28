const EARTH_RADIUS_METERS = 6378137;

export const DEFAULT_SLOPE_GEOREFERENCE = {
  originLng: 104.3903,
  originLat: 31.0909,
  originHeight: 500,
  heading: 0,
  scale: 1
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const normalizeVector = (vector) => {
  if (!vector) return null;

  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!length) return null;

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length
  };
};

const distance3D = (a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const lerpPoint = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t
});

export const calculatePlaneNormal = (points) => {
  if (!Array.isArray(points) || points.length < 3) return null;

  const origin = points[0];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const edgeA = {
      x: a.x - origin.x,
      y: a.y - origin.y,
      z: a.z - origin.z
    };
    const edgeB = {
      x: b.x - origin.x,
      y: b.y - origin.y,
      z: b.z - origin.z
    };
    const normal = normalizeVector({
      x: edgeA.y * edgeB.z - edgeA.z * edgeB.y,
      y: edgeA.z * edgeB.x - edgeA.x * edgeB.z,
      z: edgeA.x * edgeB.y - edgeA.y * edgeB.x
    });

    if (normal) {
      return normal;
    }
  }

  return null;
};

export const getSlopeAngleDegrees = (normal, up = { x: 0, y: 1, z: 0 }) => {
  if (!normal) return 0;

  const normalLength = Math.hypot(normal.x, normal.y, normal.z);
  const upLength = Math.hypot(up.x, up.y, up.z);
  if (!normalLength || !upLength) return 0;

  const dot = Math.abs(
    clamp(
      (normal.x * up.x + normal.y * up.y + normal.z * up.z) / (normalLength * upLength),
      -1,
      1
    )
  );

  return Math.acos(dot) * 180 / Math.PI;
};

export const buildSlopeRoute = (corners, options = {}) => {
  if (!Array.isArray(corners) || corners.length !== 4) {
    return { routePoints: [], scanLineCount: 0 };
  }

  const spacing = Math.max(Number(options.spacing) || 0.8, 0.1);
  const offset = Number(options.offset) || 0;
  const leftLength = distance3D(corners[0], corners[3]);
  const rightLength = distance3D(corners[1], corners[2]);
  const width = Math.max(leftLength, rightLength);
  const scanLineCount = Math.max(2, Math.floor(width / spacing) + 1);
  const routePoints = [];

  for (let i = 0; i < scanLineCount; i += 1) {
    const t = scanLineCount === 1 ? 0 : i / (scanLineCount - 1);
    const left = lerpPoint(corners[0], corners[3], t);
    const right = lerpPoint(corners[1], corners[2], t);

    left.z += offset;
    right.z += offset;

    if (i % 2 === 0) {
      routePoints.push(left, right);
    } else {
      routePoints.push(right, left);
    }
  }

  return { routePoints, scanLineCount, spacing, offset };
};

export const normalizeSlopeGeoReference = (geoReference = {}) => ({
  originLng: Number.isFinite(Number(geoReference.originLng))
    ? Number(geoReference.originLng)
    : DEFAULT_SLOPE_GEOREFERENCE.originLng,
  originLat: Number.isFinite(Number(geoReference.originLat))
    ? Number(geoReference.originLat)
    : DEFAULT_SLOPE_GEOREFERENCE.originLat,
  originHeight: Number.isFinite(Number(geoReference.originHeight))
    ? Number(geoReference.originHeight)
    : DEFAULT_SLOPE_GEOREFERENCE.originHeight,
  heading: Number.isFinite(Number(geoReference.heading))
    ? Number(geoReference.heading)
    : DEFAULT_SLOPE_GEOREFERENCE.heading,
  scale: Number.isFinite(Number(geoReference.scale)) && Number(geoReference.scale) !== 0
    ? Number(geoReference.scale)
    : DEFAULT_SLOPE_GEOREFERENCE.scale
});

export const projectModelPointToGeo = (point, geoReference = {}) => {
  const geo = normalizeSlopeGeoReference(geoReference);
  const scale = geo.scale;
  const headingRad = geo.heading * Math.PI / 180;

  const localX = point.x * scale;
  const localY = point.y * scale;
  const localZ = point.z * scale;

  const eastMeters = localX * Math.cos(headingRad) - localZ * Math.sin(headingRad);
  const northMeters = localX * Math.sin(headingRad) + localZ * Math.cos(headingRad);
  const originLatRad = geo.originLat * Math.PI / 180;

  const lat = geo.originLat + northMeters / EARTH_RADIUS_METERS * 180 / Math.PI;
  const lng = geo.originLng + eastMeters / (EARTH_RADIUS_METERS * Math.cos(originLatRad)) * 180 / Math.PI;

  return {
    lat,
    lng,
    height: geo.originHeight + localY
  };
};

export const calculateBearing = (start, end) => {
  if (!start || !end) return 0;

  const lat1 = start.lat * Math.PI / 180;
  const lat2 = end.lat * Math.PI / 180;
  const deltaLng = (end.lng - start.lng) * Math.PI / 180;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const projectModelVectorToGeoEnu = (vector, geoReference = {}) => {
  const geo = normalizeSlopeGeoReference(geoReference);
  const headingRad = geo.heading * Math.PI / 180;
  const scale = geo.scale;

  return {
    east: (vector.x * Math.cos(headingRad) - vector.z * Math.sin(headingRad)) * scale,
    north: (vector.x * Math.sin(headingRad) + vector.z * Math.cos(headingRad)) * scale,
    up: vector.y * scale
  };
};

const getSurfaceFacingOrientation = (surfaceNormal, geoReference = {}) => {
  const outwardNormal = normalizeVector(surfaceNormal);
  if (!outwardNormal) return null;

  const targetDirection = projectModelVectorToGeoEnu({
    x: -outwardNormal.x,
    y: -outwardNormal.y,
    z: -outwardNormal.z
  }, geoReference);
  const horizontalDistance = Math.hypot(targetDirection.east, targetDirection.north);

  return {
    directionAngle: horizontalDistance > 1e-6
      ? (Math.atan2(targetDirection.east, targetDirection.north) * 180 / Math.PI + 360) % 360
      : 0,
    gimbalPitch: clamp(
      Math.atan2(targetDirection.up, Math.max(horizontalDistance, 1e-6)) * 180 / Math.PI,
      -90,
      30
    )
  };
};

export const modelPointsToWaypoints = (points, geoReference, missionConfig = {}, surfaceNormal = null) => {
  const geoPoints = points.map(point => projectModelPointToGeo(point, geoReference));
  const speed = missionConfig.globalSpeed || missionConfig.globalTransitionalSpeed || 5;
  const fallbackGimbalPitch = typeof missionConfig.gimbalPitch === 'number' ? missionConfig.gimbalPitch : -60;
  const surfaceOrientation = getSurfaceFacingOrientation(surfaceNormal, geoReference);

  return geoPoints.map((point, index) => {
    const next = geoPoints[index + 1] || geoPoints[index - 1] || point;
    return {
      ...point,
      speed,
      gimbalPitch: surfaceOrientation ? surfaceOrientation.gimbalPitch : fallbackGimbalPitch,
      directionAngle: surfaceOrientation ? surfaceOrientation.directionAngle : calculateBearing(point, next)
    };
  });
};
