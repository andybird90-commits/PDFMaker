import type { Point } from "./types";

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

export function buildCloudPath(
  x: number,
  y: number,
  width: number,
  height: number,
  scallopRadius = 8,
): string {
  const points: Point[] = [];
  const perimeter = 2 * (width + height);
  const step = scallopRadius * 1.5;
  const totalPoints = Math.max(8, Math.floor(perimeter / step));

  for (let i = 0; i < totalPoints; i += 1) {
    const distance = (i / totalPoints) * perimeter;
    if (distance <= width) {
      points.push({ x: x + distance, y });
    } else if (distance <= width + height) {
      points.push({ x: x + width, y: y + (distance - width) });
    } else if (distance <= 2 * width + height) {
      points.push({
        x: x + width - (distance - (width + height)),
        y: y + height,
      });
    } else {
      points.push({
        x,
        y: y + height - (distance - (2 * width + height)),
      });
    }
  }

  if (points.length < 3) {
    return "";
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const cx = (current.x + next.x) / 2;
    const cy = (current.y + next.y) / 2;
    path += ` Q ${current.x} ${current.y}, ${cx} ${cy}`;
  }
  path += " Z";
  return path;
}

export function polylineToPath(points: Point[]): string {
  if (points.length === 0) {
    return "";
  }
  return points.reduce((acc, point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }
    return `${acc} L ${point.x} ${point.y}`;
  }, "");
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
