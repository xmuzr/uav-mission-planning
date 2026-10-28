// Geometry-only planning; the viewer supplies model ray picks and clearance tests.
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = a => Math.hypot(a.x, a.y, a.z);
const unit = a => length(a) > 1e-8 ? mul(a, 1 / length(a)) : null;
const distance = (a, b) => length(sub(a, b));
const at = (box, x, y, z) => add(box.center, add(mul(box.xAxis, x), add(mul(box.yAxis, y), mul(box.zAxis, z))));

export const CLOSE_FACES = [
  { value: 'front', label: '正面' }, { value: 'right', label: '右侧' },
  { value: 'back', label: '背面' }, { value: 'left', label: '左侧' },
  { value: 'top', label: '顶面' }
];

export function coveringRows(min, max, spacing) {
  if (!(spacing > 0) || !Number.isFinite(spacing) || !(max > min)) throw new Error('扫描范围或间距无效');
  const count = Math.ceil((max - min) / spacing);
  if (count > 20000) throw new Error('扫描点过密，请缩小范围或降低重叠率');
  return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
}

export function closePhotoSpacing(camera, range, lateralOverlap, longitudinalOverlap) {
  if (![camera.sensorWidth, camera.sensorHeight, camera.focalLength, range].every(n => Number.isFinite(n) && n > 0)) throw new Error('相机参数或拍摄距离无效');
  const overlap = n => Math.min(0.95, Math.max(0, Number(n) / 100));
  const width = range * camera.sensorWidth / camera.focalLength;
  const height = range * camera.sensorHeight / camera.focalLength;
  return {
    // For wall photos the vertical sensor extent controls height-layer spacing.
    wallRows: height * (1 - overlap(lateralOverlap)),
    wallPoints: width * (1 - overlap(longitudinalOverlap)),
    roofRows: width * (1 - overlap(lateralOverlap)),
    roofPoints: height * (1 - overlap(longitudinalOverlap))
  };
}

export function estimateSurfaceNormal(center, horizontal, vertical, fallback) {
  if (!horizontal || !vertical) return fallback;
  let normal = unit(cross(sub(horizontal, center), sub(vertical, center)));
  if (!normal) return fallback;
  if (dot(normal, fallback) < 0) normal = mul(normal, -1);
  // An almost tangent estimate is usually a neighbor on another surface.
  return dot(normal, fallback) >= 0.25 ? normal : fallback;
}

export function closeRouteLegs(points) {
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const transition = !!(points[i - 1].isTransition || points[i].isTransition);
    const last = legs[legs.length - 1];
    if (last && last.transition === transition) last.points.push(points[i]);
    else legs.push({ transition, points: [points[i - 1], points[i]] });
  }
  return legs;
}

export async function connectCloseSegments(segments, { isClear, connect, checkCancelled = () => {} }) {
  const points = [];
  let connectorPointCount = 0;
  for (const source of segments) {
    checkCancelled();
    if (!source.length) continue;
    // Preserve every photo target, including isolated samples.
    const segment = [...source];
    if (points.length) {
      const previous = points[points.length - 1];
      if (!(await isClear(previous, segment[0]))) {
        const connector = await connect(previous, segment[0]);
        if (!connector) throw new Error('有扫描段无法安全连接。请缩小范围、调整贴近距离或取消受遮挡的扫描面；未生成可导出的连续航线。');
        for (const point of connector) {
          points.push({ ...point, isTransition: true, skipAction: true, photoDistance: 0 });
          connectorPointCount++;
        }
      }
    }
    points.push(...segment);
  }
  // The sequence checked here is exactly the sequence drawn and exported.
  for (let i = 1; i < points.length; i++) {
    checkCancelled();
    if (!(await isClear(points[i - 1], points[i]))) throw new Error('连续航线校验发现模型碰撞，已停止生成，请调整扫描范围。');
  }
  return { points, connectorPointCount };
}

export async function planClosePhotography({ box, camera, range, lateralOverlap = 80, longitudinalOverlap = 70,
  faces = CLOSE_FACES.map(face => face.value), raycast, isVisible, isClear, isPositionClear, connect, makeWaypoint,
  onProgress = () => {}, yieldControl = async () => {}, checkCancelled = () => {}, maxSamples = 12000 }) {
  const spacing = closePhotoSpacing(camera, range, lateralOverlap, longitudinalOverlap);
  const { minX, maxX, minY, maxY, minZ, maxZ, xAxis, yAxis, zAxis } = box;
  const x = coveringRows(minX, maxX, spacing.wallPoints);
  const y = coveringRows(minY, maxY, spacing.wallPoints);
  const z = coveringRows(minZ, maxZ, spacing.wallRows);
  const negative = a => mul(a, -1);
  const definitions = [
    { key: 'front', label: '正面', u: x, v: z, normal: yAxis, tangent: xAxis, at: (u, v) => at(box, u, maxY, v) },
    { key: 'right', label: '右侧', u: y, v: z, normal: xAxis, tangent: yAxis, at: (u, v) => at(box, maxX, u, v) },
    { key: 'back', label: '背面', u: x, v: z, normal: negative(yAxis), tangent: xAxis, at: (u, v) => at(box, u, minY, v) },
    { key: 'left', label: '左侧', u: y, v: z, normal: negative(xAxis), tangent: yAxis, at: (u, v) => at(box, minX, u, v) },
    { key: 'top', label: '顶面', u: coveringRows(minX, maxX, spacing.roofPoints), v: coveringRows(minY, maxY, spacing.roofRows), normal: zAxis, tangent: xAxis, at: (u, v) => at(box, u, v, maxZ) }
  ].filter(face => faces.includes(face.key));
  if (!definitions.length) throw new Error('请至少选择一个扫描面');
  const requested = definitions.reduce((n, face) => n + face.u.length * face.v.length, 0);
  if (requested > maxSamples) throw new Error(`当前需要 ${requested} 个采样点，超过单次 ${maxSamples} 点限制。请分区域规划或降低重叠率；程序不会自动放大间距。`);
  const diagnostics = { requested, sampled: 0, missing: 0, detected: 0, scheduled: 0, repaired: 0, normalFallback: 0, connectorPointCount: 0 };
  const targets = [], segments = [];
  const inside = p => {
    const delta = sub(p, box.center), tolerance = 0.15;
    return [[xAxis, minX, maxX], [yAxis, minY, maxY], [zAxis, minZ, maxZ]]
      .every(([axis, min, max]) => { const value = dot(delta, axis); return value >= min - tolerance && value <= max + tolerance; });
  };
  // Eight independent detailed picks per batch keep model loading and rendering responsive.
  async function batches(items, fn) {
    const result = [];
    for (let i = 0; i < items.length; i += 8) {
      checkCancelled();
      result.push(...await Promise.all(items.slice(i, i + 8).map(fn)));
      await yieldControl();
    }
    return result;
  }
  for (const face of definitions) {
    const samples = face.v.flatMap((v, row) => face.u.map((u, col) => ({ u, v, row, col })));
    const hits = await batches(samples, async sample => {
      const start = add(face.at(sample.u, sample.v), mul(face.normal, Math.max(30, range + 30)));
      const hit = await raycast(start, negative(face.normal));
      diagnostics.sampled++;
      const position = hit && inside(hit) ? hit : null;
      if (!position) diagnostics.missing++;
      onProgress(`正在采样${face.label}：${diagnostics.sampled} / ${requested}`);
      return position;
    });
    const columns = face.u.length;
    const neighbor = (row, col, dr, dc, center) => {
      const rr = row + dr, cc = col + dc;
      if (rr < 0 || rr >= face.v.length || cc < 0 || cc >= columns) return null;
      const p = hits[rr * columns + cc];
      const expected = Math.abs(dc ? face.u[cc] - face.u[col] : face.v[rr] - face.v[row]);
      if (!p || distance(p, center) > Math.max(0.5, expected * 3)) return null;
      // Reflect backward differences so tangents always point along increasing grid axes.
      return dr < 0 || dc < 0 ? add(center, sub(center, p)) : p;
    };
    const candidates = await batches(samples, async ({ row, col }) => {
      const position = hits[row * columns + col];
      if (!position) return null;
      const horizontal = neighbor(row, col, 0, 1, position) || neighbor(row, col, 0, -1, position);
      const vertical = neighbor(row, col, 1, 0, position) || neighbor(row, col, -1, 0, position);
      const normal = estimateSurfaceNormal(position, horizontal, vertical, face.normal);
      if (normal === face.normal) diagnostics.normalFallback++;
      const target = { position, normal, scheduled: false, surface: face.key };
      targets.push(target);
      diagnostics.detected++;
      // A roof keeps vertical stand-off: following every equipment/mesh normal
      // laterally would make neighboring photo rows cross. Walls follow their
      // estimated normals, while roof height still follows each actual hit.
      const viewDirection = face.key === 'top' ? zAxis : normal;
      const tangent = unit(sub(face.tangent, mul(viewDirection, dot(face.tangent, viewDirection)))) || xAxis;
      const second = unit(cross(viewDirection, tangent)) || zAxis;
      const angle = Math.PI / 12;
      const directions = [viewDirection, ...[tangent, negative(tangent), second, negative(second)]
        .map(axis => add(mul(viewDirection, Math.cos(angle)), mul(axis, Math.sin(angle))))];
      for (let attempt = 0; attempt < directions.length; attempt++) {
        const drone = add(position, mul(directions[attempt], range));
        if (!(await isVisible(drone, position))) continue;
        // Check a short segment at the photo position, with the same body clearance as flight legs.
        if (!(await (isPositionClear ? isPositionClear(drone) : isClear(drone, add(drone, mul(directions[attempt], 0.25)))))) continue;
        const waypoint = makeWaypoint(drone, position, { surfaceKey: face.key === 'top' ? 'close-top' : 'close-model', surfaceName: face.label, normal,
          photoDistance: face.key === 'top' ? spacing.roofPoints : spacing.wallPoints });
        target.scheduled = true;
        diagnostics.scheduled++;
        if (attempt > 0) diagnostics.repaired++;
        return waypoint;
      }
      return null;
    });
    // Serpentine rows retain all photo points; no straight-line simplification.
    for (let row = 0; row < face.v.length; row++) {
      const line = candidates.slice(row * columns, (row + 1) * columns);
      if (row % 2) line.reverse();
      let segment = [];
      for (const point of line) {
        checkCancelled();
        if (!point) {
          if (segment.length) segments.push(segment);
          segment = [];
        } else if (segment.length && !(await isClear(segment[segment.length - 1], point))) {
          segments.push(segment); segment = [point];
        } else segment.push(point);
      }
      if (segment.length) segments.push(segment);
      await yieldControl();
    }
  }
  if (!segments.length) throw new Error('选定范围内没有可用拍摄点，请检查模型、底面范围与高度。');
  onProgress('正在连接扫描段并检查整条航线…');
  const continuous = await connectCloseSegments(segments, { isClear, connect, checkCancelled });
  diagnostics.connectorPointCount = continuous.connectorPointCount;
  diagnostics.uncovered = diagnostics.detected - diagnostics.scheduled;
  return { ...continuous, segments, targets, diagnostics, spacing, scanLineCount: definitions.reduce((n, face) => n + face.v.length, 0) };
}
