import { degrees, PDFDocument, rgb, type PDFPage } from "pdf-lib";
import { buildCloudPath, clamp01, denormalizePoint, lineStyleToDash, normalizePoint, rectFromPoints } from "./geometry";
import type { Annotation, HighlighterAnnotation, LineStyle, PageSize, PdfEditorAnnotations, Point } from "./types";

export function makeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function parseInitialAnnotations(input: unknown): Annotation[] {
  if (!input) return [];
  if (Array.isArray(input)) return input as Annotation[];
  if (typeof input === "object" && input !== null && "annotations" in input) {
    const value = (input as { annotations?: unknown }).annotations;
    if (Array.isArray(value)) return value as Annotation[];
  }
  return [];
}

export function toPdfColor(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  const full = cleaned.length === 3 ? cleaned.split("").map((c) => `${c}${c}`).join("") : cleaned;
  const normalized = full.padEnd(6, "0").slice(0, 6);
  const int = Number.parseInt(normalized, 16);
  return {
    r: ((int >> 16) & 255) / 255,
    g: ((int >> 8) & 255) / 255,
    b: (int & 255) / 255,
  };
}

function drawHighlighterSegments(page: PDFPage, annotation: HighlighterAnnotation, size: PageSize): void {
  if (annotation.points.length < 2) return;
  const c = toPdfColor(annotation.color);
  for (let i = 1; i < annotation.points.length; i += 1) {
    const a = denormalizePoint(annotation.points[i - 1], size.width, size.height);
    const b = denormalizePoint(annotation.points[i], size.width, size.height);
    page.drawLine({
      start: { x: a.x, y: size.height - a.y },
      end: { x: b.x, y: size.height - b.y },
      thickness: annotation.strokeWidth,
      color: rgb(c.r, c.g, c.b),
      opacity: annotation.opacity,
    });
  }
}

export async function buildFlattenedPdf(
  sourceBytes: Uint8Array,
  annotations: Annotation[],
  pageSizes: Record<number, PageSize>,
): Promise<Blob> {
  const doc = await PDFDocument.load(sourceBytes);
  const pages = doc.getPages();
  for (const annotation of annotations) {
    const page = pages[annotation.page - 1];
    const size = pageSizes[annotation.page];
    if (!page || !size) continue;
    const c = toPdfColor(annotation.color);
    const dashRaw = lineStyleToDash(annotation.lineStyle, annotation.strokeWidth);
    const dashArray = dashRaw?.split(" ").map((value) => Number(value) || 0).filter((value) => value > 0);
    const optionsBase = {
      color: rgb(c.r, c.g, c.b),
      borderColor: rgb(c.r, c.g, c.b),
      borderWidth: annotation.strokeWidth,
      borderDashArray: dashArray,
    };
    if (annotation.type === "line" || annotation.type === "arrow") {
      const start = denormalizePoint(annotation.start, size.width, size.height);
      const end = denormalizePoint(annotation.end, size.width, size.height);
      page.drawLine({
        start: { x: start.x, y: size.height - start.y },
        end: { x: end.x, y: size.height - end.y },
        thickness: annotation.strokeWidth,
        color: rgb(c.r, c.g, c.b),
        dashArray,
      });
      if (annotation.type === "arrow") {
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const arrowLength = Math.max(8, annotation.strokeWidth * 4);
        const left = {
          x: end.x - arrowLength * Math.cos(angle - Math.PI / 6),
          y: end.y - arrowLength * Math.sin(angle - Math.PI / 6),
        };
        const right = {
          x: end.x - arrowLength * Math.cos(angle + Math.PI / 6),
          y: end.y - arrowLength * Math.sin(angle + Math.PI / 6),
        };
        page.drawLine({
          start: { x: end.x, y: size.height - end.y },
          end: { x: left.x, y: size.height - left.y },
          thickness: annotation.strokeWidth,
          color: rgb(c.r, c.g, c.b),
        });
        page.drawLine({
          start: { x: end.x, y: size.height - end.y },
          end: { x: right.x, y: size.height - right.y },
          thickness: annotation.strokeWidth,
          color: rgb(c.r, c.g, c.b),
        });
      }
      continue;
    }
    if (annotation.type === "rect") {
      const rect = rectFromPoints(
        denormalizePoint(annotation.start, size.width, size.height),
        denormalizePoint(annotation.end, size.width, size.height),
      );
      page.drawRectangle({
        x: rect.x,
        y: size.height - rect.y - rect.h,
        width: rect.w,
        height: rect.h,
        ...optionsBase,
      });
      continue;
    }
    if (annotation.type === "cloud") {
      const rect = rectFromPoints(
        denormalizePoint(annotation.start, size.width, size.height),
        denormalizePoint(annotation.end, size.width, size.height),
      );
      const d = buildCloudPath(rect.x, rect.y, Math.max(8, rect.w), Math.max(8, rect.h), Math.max(8, annotation.strokeWidth * 3));
      page.drawSvgPath(d, {
        borderColor: rgb(c.r, c.g, c.b),
        borderWidth: annotation.strokeWidth,
      });
      continue;
    }
    if (annotation.type === "highlighter") {
      drawHighlighterSegments(page, annotation, size);
      continue;
    }
    if (annotation.type === "stamp") {
      const at = denormalizePoint(annotation.position, size.width, size.height);
      page.drawText(annotation.label, {
        x: at.x,
        y: size.height - at.y - annotation.height,
        size: Math.max(8, annotation.height * 0.55),
        color: rgb(c.r, c.g, c.b),
        rotate: degrees(0),
        opacity: annotation.opacity,
      });
    }
  }
  const output = await doc.save();
  const safeBytes = Uint8Array.from(output);
  return new Blob([safeBytes.buffer], { type: "application/pdf" });
}

export function getDashArray(style: LineStyle, strokeWidth: number): string | undefined {
  return lineStyleToDash(style, strokeWidth);
}

export function normalizeFromEvent(point: Point, size: PageSize): Point {
  return normalizePoint(point, size.width, size.height);
}

export function clampScale(value: number): number {
  return Math.min(4, Math.max(0.5, value));
}

export function serializeAnnotations(annotations: Annotation[]): PdfEditorAnnotations {
  return {
    schemaVersion: 1,
    annotations,
  };
}

export { clamp01 };
