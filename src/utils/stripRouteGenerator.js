import { calculateSpacing } from './polygonRouteGenerator.js';

const METERS_PER_DEGREE = 6378137 * Math.PI / 180;
const MIN_SEGMENT_LENGTH = 0.2;
const MAX_WAYPOINTS = 20000;
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const interpolate = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
});
const cross = (a, b) => a.x * b.y - a.y * b.x;
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

const nonnegative = (value, name) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name}必须是有效的非负数`);
  }
  return number;
};

// Build one ribbon. Both adjacent sections use exactly the same cross-section
// at a corner, instead of overlapping two independently capped rectangles.
const buildSections = (points, leftWidth, rightWidth) => {
  const directions = points.slice(1).map((point, index) => {
    const delta = subtract(point, points[index]);
    const length = distance(point, points[index]);
    return { x: delta.x / length, y: delta.y / length };
  });
  const normals = directions.map(({ x, y }) => ({ x: -y, y: x }));
  const cap = Math.max(leftWidth, rightWidth);

  const sections = points.map((point, index) => {
    let center = point;
    let normal;
    if (index === 0 || index === points.length - 1) {
      const directionIndex = index === 0 ? 0 : directions.length - 1;
      const direction = directions[directionIndex];
      const sign = index === 0 ? -1 : 1;
      center = { x: point.x + direction.x * cap * sign, y: point.y + direction.y * cap * sign };
      normal = normals[directionIndex];
    } else {
      const previous = directions[index - 1];
      const next = directions[index];
      const denominator = 1 + previous.x * next.x + previous.y * next.y;
      if (denominator < 1e-6) {
        throw new Error('中心线存在折返，请调整转角后重新生成带状航线');
      }
      normal = {
        x: (normals[index - 1].x + normals[index].x) / denominator,
        y: (normals[index - 1].y + normals[index].y) / denominator
      };
      if (Math.hypot(normal.x, normal.y) > 4) {
        throw new Error('中心线转角过急，请调整转角后重新生成带状航线');
      }
    }
    return {
      left: { x: center.x + normal.x * leftWidth, y: center.y + normal.y * leftWidth },
      right: { x: center.x - normal.x * rightWidth, y: center.y - normal.y * rightWidth }
    };
  });

  // A sharp bend next to a short segment can invert the inner edge. Reject it
  // rather than producing a bow-tie cell and crossing flight legs.
  for (let index = 1; index < sections.length; index++) {
    const start = sections[index - 1];
    const end = sections[index];
    const direction = directions[index - 1];
    const forward = (a, b) => {
      const delta = subtract(b, a);
      return delta.x * direction.x + delta.y * direction.y;
    };
    if (forward(start.left, end.left) < MIN_SEGMENT_LENGTH
      || forward(start.right, end.right) < MIN_SEGMENT_LENGTH) {
      throw new Error('转角附近的中心线过短或测区过宽，请调整中心线或外扩距离');
    }
  }
  return sections;
};

const assertSimpleBoundary = (boundary) => {
  const intersects = (a, b, c, d) => {
    const ab = subtract(b, a);
    const cd = subtract(d, c);
    const denominator = cross(ab, cd);
    if (Math.abs(denominator) < 1e-8) return false;
    const ac = subtract(c, a);
    const t = cross(ac, cd) / denominator;
    const u = cross(ac, ab) / denominator;
    return t > 1e-8 && t < 1 - 1e-8 && u > 1e-8 && u < 1 - 1e-8;
  };
  for (let i = 0; i < boundary.length; i++) {
    for (let j = i + 2; j < boundary.length; j++) {
      if (i === 0 && j === boundary.length - 1) continue;
      if (intersects(boundary[i], boundary[(i + 1) % boundary.length],
        boundary[j], boundary[(j + 1) % boundary.length])) {
        throw new Error('带状测区在转角处自相交，请调整中心线或减小外扩距离');
      }
    }
  }
};

export const generateStripRoute = (centerLinePoints, options = {}) => {
  if (!Array.isArray(centerLinePoints) || centerLinePoints.length < 2) {
    return { waypoints: [], boundaryPoints: [], scanLineCount: 0 };
  }
  const origin = centerLinePoints[0];
  const lngScale = METERS_PER_DEGREE * Math.cos(Number(origin.lat) * Math.PI / 180);
  const project = (point) => ({
    x: (Number(point.lng) - Number(origin.lng)) * lngScale,
    y: (Number(point.lat) - Number(origin.lat)) * METERS_PER_DEGREE
  });
  const toGeo = (point) => ({
    lng: Number(origin.lng) + point.x / lngScale,
    lat: Number(origin.lat) + point.y / METERS_PER_DEGREE
  });
  const points = [];
  for (const point of centerLinePoints) {
    const projected = project(point);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
      throw new Error('中心线坐标无效');
    }
    if (points.length === 0 || distance(points[points.length - 1], projected) >= MIN_SEGMENT_LENGTH) {
      points.push(projected);
    }
  }
  if (points.length < 2) return { waypoints: [], boundaryPoints: [], scanLineCount: 0 };

  const leftWidth = nonnegative(options.leftOffset ?? 30, '左侧外扩距离');
  const rightWidth = nonnegative(options.rightOffset ?? 30, '右侧外扩距离');
  const margin = nonnegative(options.margin ?? 0, '安全边距');
  if (leftWidth + rightWidth <= 0 || margin > Math.min(leftWidth, rightWidth)
    || leftWidth + rightWidth - 2 * margin <= 0) {
    throw new Error('安全边距过大或带状测区宽度为零，请调整外扩距离和边距');
  }
  const height = Number(options.height ?? origin.height ?? 50);
  const speed = Number(options.speed ?? origin.speed ?? 5);
  let spacing = Number(options.spacing ?? 30);
  if (options.useCamera && options.camera) {
    spacing = calculateSpacing(height, options.camera, options.overlapRate ?? 0.7, 'lateral');
  }
  if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('航线间距必须大于零');
  if (!Number.isFinite(height) || !Number.isFinite(speed) || speed <= 0) {
    throw new Error('飞行高度或速度无效');
  }

  const outerSections = buildSections(points, leftWidth, rightWidth);
  const boundary = [
    ...outerSections.map((section) => section.left),
    ...outerSections.map((section) => section.right).reverse()
  ];
  assertSimpleBoundary(boundary);
  const sections = margin === 0 ? outerSections : buildSections(points, leftWidth - margin, rightWidth - margin);
  const scanSections = [sections[0]];
  for (let index = 1; index < sections.length; index++) {
    const start = sections[index - 1];
    const end = sections[index];
    // Bound spacing on both edges, including the longer outside of a bend.
    const length = Math.max(distance(start.left, end.left), distance(start.right, end.right));
    const steps = Math.max(1, Math.ceil(length / spacing));
    if ((scanSections.length + steps) * 2 > MAX_WAYPOINTS) {
      throw new Error('航点过多，请增大间距或拆分带状任务');
    }
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      scanSections.push({ left: interpolate(start.left, end.left, t), right: interpolate(start.right, end.right, t) });
    }
  }

  const waypoints = scanSections.flatMap((section, index) => {
    const pair = index % 2 === 0 ? [section.left, section.right] : [section.right, section.left];
    return pair.map((point) => ({ ...toGeo(point), height, speed }));
  }).map((point, index) => ({ ...point, index }));
  return { waypoints, boundaryPoints: boundary.map(toGeo), scanLineCount: scanSections.length };
};
