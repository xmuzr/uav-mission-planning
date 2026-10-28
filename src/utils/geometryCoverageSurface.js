// Sample the same convex proxy used by the geometry planner. No tileset picks.
export function isGeometryOccluded(eye, target, shape) {
  if (!shape) return false;
  // Selected corner directions can be slightly non-orthogonal. Dotting with
  // those directions is not an inverse transform: it moves surface samples
  // inside the proxy and falsely hides part of the visible wall. Use the dual
  // basis so occlusion tests the same geometry that sampling and drawing use.
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const { xAxis, yAxis, zAxis } = shape;
  const axes = [cross(yAxis, zAxis), cross(zAxis, xAxis), cross(xAxis, yAxis)];
  const determinant = dot(xAxis, axes[0]);
  if (Math.abs(determinant) < 1e-12) return false;
  const project = (point, axis) => ((point.x - shape.center.x) * axis.x +
    (point.y - shape.center.y) * axis.y + (point.z - shape.center.z) * axis.z) / determinant;
  const start = axes.map(axis => project(eye, axis));
  const delta = axes.map((axis, i) => project(target, axis) - start[i]);
  const distance = Math.hypot(...delta);
  if (distance < 1e-6) return false;
  // Only an interior intersection before the target blocks the line of sight.
  // This excludes touching a silhouette and the target's own surface.
  const epsilon = 1e-5;
  let enter = 0, exit = 1 - Math.min(0.5, 0.001 / distance);
  const clip = (axis, min, max) => {
    if (Math.abs(delta[axis]) < 1e-12) return start[axis] > min && start[axis] < max;
    const a = (min - start[axis]) / delta[axis], b = (max - start[axis]) / delta[axis];
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    return enter < exit;
  };
  if (!clip(2, shape.minZ + epsilon, shape.maxZ - epsilon)) return false;
  if (!(shape.radius > 0)) {
    return clip(0, shape.minX + epsilon, shape.maxX - epsilon) &&
      clip(1, shape.minY + epsilon, shape.maxY - epsilon);
  }
  const radius = shape.radius - epsilon;
  const a = delta[0] ** 2 + delta[1] ** 2;
  const b = 2 * (start[0] * delta[0] + start[1] * delta[1]);
  const c = start[0] ** 2 + start[1] ** 2 - radius ** 2;
  if (a < 1e-16) return c < 0 && enter < exit;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) return false;
  const root = Math.sqrt(discriminant);
  enter = Math.max(enter, (-b - root) / (2 * a));
  exit = Math.min(exit, (-b + root) / (2 * a));
  return enter < exit;
}

export function sampleGeometryCoverageSurface(shape) {
  const { center, xAxis, yAxis, zAxis, minX, maxX, minY, maxY, minZ, maxZ, radius } = shape;
  const steps = size => Math.max(3, Math.min(14, Math.ceil(size / 3)));
  const nx = steps(maxX - minX), ny = steps(maxY - minY), nz = steps(maxZ - minZ);
  const at = (a, b, i, count) => a + (b - a) * (i + 0.5) / count;
  const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
  const targets = [];
  const add = (x, y, z, normal) => targets.push({
    position: {
      x: center.x + xAxis.x * x + yAxis.x * y + zAxis.x * z,
      y: center.y + xAxis.y * x + yAxis.y * y + zAxis.y * z,
      z: center.z + xAxis.z * x + yAxis.z * y + zAxis.z * z
    }, normal
  });
  if (radius > 0) {
    for (let z = 0; z < nz; z++) for (let a = 0; a < 36; a++) {
      const angle = (a + 0.5) * Math.PI * 2 / 36;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      add(radius * cos, radius * sin, at(minZ, maxZ, z, nz), {
        x: xAxis.x * cos + yAxis.x * sin,
        y: xAxis.y * cos + yAxis.y * sin,
        z: xAxis.z * cos + yAxis.z * sin
      });
    }
  } else {
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
      add(at(minX, maxX, x, nx), maxY, at(minZ, maxZ, z, nz), yAxis);
      add(at(minX, maxX, x, nx), minY, at(minZ, maxZ, z, nz), scale(yAxis, -1));
    }
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      add(maxX, at(minY, maxY, y, ny), at(minZ, maxZ, z, nz), xAxis);
      add(minX, at(minY, maxY, y, ny), at(minZ, maxZ, z, nz), scale(xAxis, -1));
    }
  }
  // The original planner scans four walls / the cylinder wall, plus the roof.
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
    const px = at(minX, maxX, x, nx), py = at(minY, maxY, y, ny);
    if (radius > 0 && px * px + py * py > radius * radius) continue;
    add(px, py, maxZ, zAxis);
  }
  return targets;
}
