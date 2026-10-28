// 地球半径 (米)
const R = 6378137;

// 将角度转换为弧度
const toRad = (d) => d * Math.PI / 180;

// 计算两点间的距离 (Haversine 公式)
export const getDistance = (p1, p2) => {
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// 计算路径总长度
export const getPathLength = (path) => {
  let length = 0;
  for (let i = 0; i < path.length - 1; i++) {
    length += getDistance(path[i], path[i + 1]);
  }
  return length;
};

// 计算多边形面积 (Shoelace 公式，投影到平面近似计算)
// 注意：对于小范围区域（如无人机作业区），简单的墨卡托投影近似即可
export const getPolygonArea = (points) => {
  if (points.length < 3) return 0;
  
  let area = 0;
  const origin = points[0];
  
  // 投影到相对米坐标
  const project = (p) => {
    const x = (p.lng - origin.lng) * Math.PI / 180 * R * Math.cos(toRad(origin.lat));
    const y = (p.lat - origin.lat) * Math.PI / 180 * R;
    return { x, y };
  };

  const projected = points.map(project);

  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length;
    area += projected[i].x * projected[j].y;
    area -= projected[j].x * projected[i].y;
  }

  return Math.abs(area / 2);
};

// 格式化时间 (秒 -> MM:SS)
export const formatTime = (seconds) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}分${s}秒`;
};

// 判断两条线段是否相交 (p1-p2, p3-p4)
const checkIntersection = (p1, p2, p3, p4) => {
  const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  const p1_ = { x: p1.lng, y: p1.lat };
  const p2_ = { x: p2.lng, y: p2.lat };
  const p3_ = { x: p3.lng, y: p3.lat };
  const p4_ = { x: p4.lng, y: p4.lat };
  
  return (ccw(p1_, p3_, p4_) !== ccw(p2_, p3_, p4_)) && (ccw(p1_, p2_, p3_) !== ccw(p1_, p2_, p4_));
};

// 检查加入新点是否会导致自相交
export const willSelfIntersect = (newPoint, currentPoints) => {
  if (currentPoints.length < 2) return false;
  
  const lastPoint = currentPoints[currentPoints.length - 1];
  
  // 检查新线段 (lastPoint -> newPoint) 是否与之前的任何线段相交
  // 不包括与 lastPoint 连接的那条线段 (currentPoints[length-2] -> lastPoint)
  for (let i = 0; i < currentPoints.length - 2; i++) {
    const p1 = currentPoints[i];
    const p2 = currentPoints[i + 1];
    
    if (checkIntersection(lastPoint, newPoint, p1, p2)) {
      return true;
    }
  }
  
  return false;
};

const projectToMeters = (point, origin) => {
  const x = (point.lng - origin.lng) * Math.PI / 180 * R * Math.cos(toRad(origin.lat));
  const y = (point.lat - origin.lat) * Math.PI / 180 * R;
  return { x, y };
};

const unprojectFromMeters = (point, origin) => {
  const lat = origin.lat + (point.y / R) * 180 / Math.PI;
  const lng = origin.lng + (point.x / (R * Math.cos(toRad(origin.lat)))) * 180 / Math.PI;
  return { lat, lng };
};

const normalizeVector = (vector) => {
  const length = Math.hypot(vector.x, vector.y);
  if (length === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length
  };
};

const cross2D = (a, b) => a.x * b.y - a.y * b.x;

const lineIntersection = (p1, d1, p2, d2) => {
  const denominator = cross2D(d1, d2);
  if (Math.abs(denominator) < 1e-8) {
    return null;
  }
  const delta = { x: p2.x - p1.x, y: p2.y - p1.y };
  const t = cross2D(delta, d2) / denominator;
  return {
    x: p1.x + d1.x * t,
    y: p1.y + d1.y * t
  };
};

const getTurnAngle = (prev, current, next) => {
  const v1 = normalizeVector({ x: prev.x - current.x, y: prev.y - current.y });
  const v2 = normalizeVector({ x: next.x - current.x, y: next.y - current.y });
  const dot = Math.max(-1, Math.min(1, v1.x * v2.x + v1.y * v2.y));
  return Math.acos(dot) * 180 / Math.PI;
};

const splitStripCenterline = (centerLinePoints, splitAngleThreshold = 170) => {
  if (!Array.isArray(centerLinePoints) || centerLinePoints.length < 2) {
    return [];
  }

  const origin = centerLinePoints[0];
  const projected = centerLinePoints.map(point => projectToMeters(point, origin));

  const segments = [];
  let currentSegment = [centerLinePoints[0]];

  for (let i = 1; i < centerLinePoints.length; i++) {
    currentSegment.push(centerLinePoints[i]);

    if (i < centerLinePoints.length - 1) {
      const angle = getTurnAngle(projected[i - 1], projected[i], projected[i + 1]);
      if (angle < splitAngleThreshold) {
        segments.push([...currentSegment]);
        currentSegment = [centerLinePoints[i]];
      }
    }
  }

  if (currentSegment.length >= 2) {
    segments.push(currentSegment);
  }

  return segments;
};

const pushPointIfNeeded = (list, point, minDistance = 0.2) => {
  if (!point) return;
  if (list.length === 0) {
    list.push(point);
    return;
  }
  const last = list[list.length - 1];
  const distance = Math.hypot(point.x - last.x, point.y - last.y);
  if (distance >= minDistance) {
    list.push(point);
  }
};

const appendArc = (list, center, radius, fromVector, toVector, clockwise = false) => {
  const fromAngle = Math.atan2(fromVector.y, fromVector.x);
  const toAngle = Math.atan2(toVector.y, toVector.x);
  let delta = toAngle - fromAngle;

  if (clockwise && delta > 0) delta -= Math.PI * 2;
  if (!clockwise && delta < 0) delta += Math.PI * 2;

  const angleSpan = Math.abs(delta);
  const steps = Math.max(1, Math.ceil(angleSpan / (Math.PI / 18)));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const angle = fromAngle + delta * t;
    pushPointIfNeeded(list, {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    });
  }
};

const appendSquareCap = (list, center, direction, leftOffsetPoint, rightOffsetPoint, extensionDistance) => {
  const normalizedDirection = normalizeVector(direction);
  const extension = {
    x: normalizedDirection.x * extensionDistance,
    y: normalizedDirection.y * extensionDistance
  };

  pushPointIfNeeded(list, {
    x: leftOffsetPoint.x + extension.x,
    y: leftOffsetPoint.y + extension.y
  });
  pushPointIfNeeded(list, {
    x: rightOffsetPoint.x + extension.x,
    y: rightOffsetPoint.y + extension.y
  });
};

const buildOffsetSide = (projectedPoints, offsetDistance, sideSign, miterLimit = 4) => {
  const sidePoints = [];
  const segmentDirections = [];
  const segmentNormals = [];

  for (let i = 0; i < projectedPoints.length - 1; i++) {
    const direction = normalizeVector({
      x: projectedPoints[i + 1].x - projectedPoints[i].x,
      y: projectedPoints[i + 1].y - projectedPoints[i].y
    });
    if (Math.hypot(direction.x, direction.y) < 1e-8) continue;
    segmentDirections.push(direction);
    segmentNormals.push({
      x: -direction.y * sideSign,
      y: direction.x * sideSign
    });
  }

  if (segmentDirections.length === 0) {
    return sidePoints;
  }

  const start = {
    x: projectedPoints[0].x + segmentNormals[0].x * offsetDistance,
    y: projectedPoints[0].y + segmentNormals[0].y * offsetDistance
  };
  pushPointIfNeeded(sidePoints, start);

  let segmentIndex = 0;
  for (let i = 1; i < projectedPoints.length - 1; i++) {
    const prevDirection = segmentDirections[segmentIndex];
    const nextDirection = segmentDirections[segmentIndex + 1];
    const prevNormal = segmentNormals[segmentIndex];
    const nextNormal = segmentNormals[segmentIndex + 1];

    if (!nextDirection || !nextNormal) break;

    const center = projectedPoints[i];
    const prevOffsetPoint = {
      x: center.x + prevNormal.x * offsetDistance,
      y: center.y + prevNormal.y * offsetDistance
    };
    const nextOffsetPoint = {
      x: center.x + nextNormal.x * offsetDistance,
      y: center.y + nextNormal.y * offsetDistance
    };

    const joinPoint = lineIntersection(prevOffsetPoint, prevDirection, nextOffsetPoint, nextDirection);
    const useMiter = joinPoint && Math.hypot(joinPoint.x - center.x, joinPoint.y - center.y) <= offsetDistance * miterLimit;

    if (useMiter) {
      pushPointIfNeeded(sidePoints, joinPoint);
    } else {
      pushPointIfNeeded(sidePoints, prevOffsetPoint);
      const turn = cross2D(prevDirection, nextDirection);
      const isOuterJoin = sideSign === 1 ? turn > 0 : turn < 0;
      if (isOuterJoin && offsetDistance > 0.5) {
        appendArc(
          sidePoints,
          center,
          offsetDistance,
          prevNormal,
          nextNormal,
          sideSign === 1 ? false : true
        );
      } else {
        pushPointIfNeeded(sidePoints, nextOffsetPoint);
      }
    }

    segmentIndex++;
  }

  const end = {
    x: projectedPoints[projectedPoints.length - 1].x + segmentNormals[segmentNormals.length - 1].x * offsetDistance,
    y: projectedPoints[projectedPoints.length - 1].y + segmentNormals[segmentNormals.length - 1].y * offsetDistance
  };
  pushPointIfNeeded(sidePoints, end);

  return sidePoints;
};

const createStripBufferPolygon = (centerLinePoints, leftOffset = 30, rightOffset = 30) => {
  if (!Array.isArray(centerLinePoints) || centerLinePoints.length < 2) return [];

  const origin = centerLinePoints[0];
  const projected = centerLinePoints.map(point => projectToMeters(point, origin));
  if (projected.length < 2) return [];

  const leftSide = buildOffsetSide(projected, leftOffset, 1);
  const rightSide = buildOffsetSide(projected, rightOffset, -1);
  if (leftSide.length < 2 || rightSide.length < 2) return [];

  const polygonMeters = [...leftSide];
  const startDirection = normalizeVector({
    x: projected[1].x - projected[0].x,
    y: projected[1].y - projected[0].y
  });
  const endDirection = normalizeVector({
    x: projected[projected.length - 1].x - projected[projected.length - 2].x,
    y: projected[projected.length - 1].y - projected[projected.length - 2].y
  });
  const capExtension = Math.max(leftOffset, rightOffset);

  const endPoint = projected[projected.length - 1];
  appendSquareCap(
    polygonMeters,
    endPoint,
    endDirection,
    leftSide[leftSide.length - 1],
    rightSide[rightSide.length - 1],
    capExtension
  );

  for (let i = rightSide.length - 1; i >= 0; i--) {
    pushPointIfNeeded(polygonMeters, rightSide[i]);
  }

  const startPoint = projected[0];
  appendSquareCap(
    polygonMeters,
    startPoint,
    { x: -startDirection.x, y: -startDirection.y },
    rightSide[0],
    leftSide[0],
    capExtension
  );

  return polygonMeters.map(point => {
    const coords = unprojectFromMeters(point, origin);
    return {
      lat: Number(coords.lat.toFixed(7)),
      lng: Number(coords.lng.toFixed(7)),
      height: centerLinePoints[0]?.height || 50,
      speed: centerLinePoints[0]?.speed || 5
    };
  });
};

const createStripSegmentBoundary = (
  startPoint,
  endPoint,
  leftOffset = 30,
  rightOffset = 30,
  startCap = 'flat',
  endCap = 'flat'
) => {
  if (!startPoint || !endPoint) return [];

  const origin = startPoint;
  const start = projectToMeters(startPoint, origin);
  const end = projectToMeters(endPoint, origin);
  const direction = normalizeVector({
    x: end.x - start.x,
    y: end.y - start.y
  });

  if (Math.hypot(direction.x, direction.y) < 1e-8) {
    return [];
  }

  const normal = {
    x: -direction.y,
    y: direction.x
  };
  const extensionDistance = Math.max(leftOffset, rightOffset);
  const startExtension = startCap === 'square' ? extensionDistance : 0;
  const endExtension = endCap === 'square' ? extensionDistance : 0;

  const extendedStart = {
    x: start.x - direction.x * startExtension,
    y: start.y - direction.y * startExtension
  };
  const extendedEnd = {
    x: end.x + direction.x * endExtension,
    y: end.y + direction.y * endExtension
  };

  const polygonMeters = [
    {
      x: extendedStart.x + normal.x * leftOffset,
      y: extendedStart.y + normal.y * leftOffset
    },
    {
      x: extendedEnd.x + normal.x * leftOffset,
      y: extendedEnd.y + normal.y * leftOffset
    },
    {
      x: extendedEnd.x - normal.x * rightOffset,
      y: extendedEnd.y - normal.y * rightOffset
    },
    {
      x: extendedStart.x - normal.x * rightOffset,
      y: extendedStart.y - normal.y * rightOffset
    }
  ];

  return polygonMeters.map(point => {
    const coords = unprojectFromMeters(point, origin);
    return {
      lat: Number(coords.lat.toFixed(7)),
      lng: Number(coords.lng.toFixed(7)),
      height: startPoint.height || endPoint.height || 50,
      speed: startPoint.speed || endPoint.speed || 5
    };
  });
};

// Expand a strip centerline into a polygon work area.
export const generateStripBoundary = (centerLinePoints, leftOffset = 30, rightOffset = 30) => {
  return createStripBufferPolygon(centerLinePoints, leftOffset, rightOffset);
};

export const generateStripBoundaryGroups = (
  centerLinePoints,
  leftOffset = 30,
  rightOffset = 30,
  splitAngleThreshold = 170
) => {
  const mergedBoundary = generateStripBoundary(centerLinePoints, leftOffset, rightOffset);
  if (mergedBoundary.length >= 3) {
    return [mergedBoundary];
  }

  const segments = splitStripCenterline(centerLinePoints, splitAngleThreshold);
  return segments
    .map(segment => generateStripBoundary(segment, leftOffset, rightOffset))
    .filter(boundary => boundary.length >= 3);
};

export const generateStripRouteBoundaryGroups = (
  centerLinePoints,
  leftOffset = 30,
  rightOffset = 30,
  splitAngleThreshold = 170
) => {
  if (!Array.isArray(centerLinePoints) || centerLinePoints.length < 2) {
    return [];
  }

  const segmentGroups = [];

  for (let i = 0; i < centerLinePoints.length - 1; i++) {
    const startPoint = centerLinePoints[i];
    const endPoint = centerLinePoints[i + 1];
    const boundary = createStripSegmentBoundary(
      startPoint,
      endPoint,
      leftOffset,
      rightOffset,
      i === 0 ? 'square' : 'flat',
      i === centerLinePoints.length - 2 ? 'square' : 'flat'
    );

    if (boundary.length >= 3) {
      segmentGroups.push({
        centerLine: [startPoint, endPoint],
        boundary
      });
    }
  }

  if (segmentGroups.length > 0) {
    return segmentGroups;
  }

  const fallbackSegments = splitStripCenterline(centerLinePoints, splitAngleThreshold);
  return fallbackSegments
    .map(segment => ({
      centerLine: segment,
      boundary: generateStripBoundary(segment, leftOffset, rightOffset)
    }))
    .filter(item => item.boundary.length >= 3);
};
