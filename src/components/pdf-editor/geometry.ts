import type { LineStyle, Point } from "./types";

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function normalizePoint(point: Point, width: number, height: number): Point {
  return {
    x: clamp01(point.x / width),
    y: clamp01(point.y / height),
  };
}

export function denormalizePoint(point: Point, width: number, height: number): Point {
  return {
    x: point.x * width,
    y: point.y * height,
  };
}

export function rectFromPoints(a: Point, b: Point): { x: number; y: number; w: number; h: number } {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function buildCloudPath(x: number, y: number, width: number, height: number, scallopRadius = 8): string {
  type CloudAnchor = Point & { nx: number; ny: number };
  const points: CloudAnchor[] = [];
  const perimeter = 2 * (width + height);
  const step = Math.max(4, scallopRadius * 1.1);
  const totalPoints = Math.max(8, Math.floor(perimeter / step));

  for (let i = 0; i < totalPoints; i += 1) {
    const distance = (i / totalPoints) * perimeter;
    if (distance <= width) {
      points.push({ x: x + distance, y, nx: 0, ny: -1 });
    } else if (distance <= width + height) {
      points.push({ x: x + width, y: y + (distance - width), nx: 1, ny: 0 });
    } else if (distance <= 2 * width + height) {
      points.push({ x: x + width - (distance - (width + height)), y: y + height, nx: 0, ny: 1 });
    } else {
      points.push({ x, y: y + height - (distance - (2 * width + height)), nx: -1, ny: 0 });
    }
  }

  if (points.length < 3) return "";
  const bumpDistance = scallopRadius * 1.65;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const mx = (current.x + next.x) / 2;
    const my = (current.y + next.y) / 2;
    const nx = (current.nx + next.nx) / 2;
    const ny = (current.ny + next.ny) / 2;
    const cx = mx + nx * bumpDistance;
    const cy = my + ny * bumpDistance;
    path += ` Q ${cx} ${cy}, ${next.x} ${next.y}`;
  }
  path += " Z";
  return path;
}

export function polylineToPath(points: Point[]): string {
  if (points.length === 0) return "";
  return points.reduce((acc, point, index) => (index === 0 ? `M ${point.x} ${point.y}` : `${acc} L ${point.x} ${point.y}`), "");
}

export function lineStyleToDash(style: LineStyle, weight: number): string | undefined {
  if (style === "dashed") return `${weight * 4} ${weight * 2}`;
  if (style === "dotted") return `${weight} ${weight * 1.5}`;
  return undefined;
}
