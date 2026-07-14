import { buildCloudPath, denormalizePoint, polylineToPath, rectFromPoints } from "./geometry";
import { getDashArray } from "./utils";
import type { Annotation, DrawingState, PageSize, Point, Tool } from "./types";
import type { MutableRefObject, PointerEvent as ReactPointerEvent, ReactElement } from "react";

type PdfCanvasProps = {
  pageCount: number;
  pageSizes: Record<number, PageSize>;
  pdfName: string;
  scale: number;
  annotations: Annotation[];
  drawingState: DrawingState;
  tool: Tool;
  strokeColor: string;
  strokeWidth: number;
  readOnly: boolean;
  selectedId: string | null;
  thumbnails: Record<number, string>;
  canvasRefs: MutableRefObject<Record<number, HTMLCanvasElement | null>>;
  svgRefs: MutableRefObject<Record<number, SVGSVGElement | null>>;
  pageRefs: MutableRefObject<Record<number, HTMLElement | null>>;
  pagesScrollRef: MutableRefObject<HTMLElement | null>;
  onPointerDown: (page: number, event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerMove: (page: number, event: ReactPointerEvent<SVGSVGElement>) => void;
  onPointerUp: (page: number) => void;
  onSelectAnnotation: (annotationId: string) => void;
  setActivePage: (page: number) => void;
  activePage: number;
};

function toScreen(point: Point, size: PageSize): Point {
  return denormalizePoint(point, size.width, size.height);
}

function renderAnnotation(annotation: Annotation, size: PageSize, selectedId: string | null): ReactElement | null {
  const isSelected = annotation.id === selectedId;
  const common = {
    stroke: annotation.color,
    strokeWidth: annotation.strokeWidth,
    strokeDasharray: getDashArray(annotation.lineStyle, annotation.strokeWidth),
    fill: "transparent",
    className: isSelected ? "drop-shadow-[0_0_6px_rgba(14,165,233,0.8)]" : undefined,
  };
  if (annotation.type === "line" || annotation.type === "arrow") {
    const start = toScreen(annotation.start, size);
    const end = toScreen(annotation.end, size);
    return (
      <line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        markerEnd={annotation.type === "arrow" ? "url(#pdf-editor-arrow)" : undefined}
        {...common}
      />
    );
  }
  if (annotation.type === "rect") {
    const rect = rectFromPoints(toScreen(annotation.start, size), toScreen(annotation.end, size));
    return <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} {...common} />;
  }
  if (annotation.type === "cloud") {
    const rect = rectFromPoints(toScreen(annotation.start, size), toScreen(annotation.end, size));
    const d = buildCloudPath(rect.x, rect.y, Math.max(6, rect.w), Math.max(6, rect.h), Math.max(8, annotation.strokeWidth * 3));
    return <path d={d} {...common} />;
  }
  if (annotation.type === "highlighter") {
    const points = annotation.points.map((point) => toScreen(point, size));
    return (
      <path
        d={polylineToPath(points)}
        fill="none"
        stroke={annotation.color}
        strokeWidth={annotation.strokeWidth}
        strokeDasharray={getDashArray(annotation.lineStyle, annotation.strokeWidth)}
        opacity={annotation.opacity}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (annotation.type === "stamp") {
    const point = toScreen(annotation.position, size);
    return (
      <g>
        <rect x={point.x} y={point.y} width={annotation.width} height={annotation.height} rx={6} fill={annotation.color} opacity={0.15} />
        <text x={point.x + 6} y={point.y + annotation.height / 1.5} fill={annotation.color} fontSize={Math.max(10, annotation.height * 0.5)}>
          {annotation.label}
        </text>
      </g>
    );
  }
  return null;
}

function renderActiveShape(
  drawingState: DrawingState,
  tool: Tool,
  color: string,
  strokeWidth: number,
): ReactElement | null {
  if (!drawingState) return null;
  const start = drawingState.start;
  const current = drawingState.current;
  if (tool === "line" || tool === "arrow") {
    return (
      <line
        x1={start.x}
        y1={start.y}
        x2={current.x}
        y2={current.y}
        stroke={color}
        strokeWidth={strokeWidth}
        markerEnd={tool === "arrow" ? "url(#pdf-editor-arrow)" : undefined}
      />
    );
  }
  if (tool === "rect") {
    const rect = rectFromPoints(start, current);
    return <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill="transparent" stroke={color} strokeWidth={strokeWidth} />;
  }
  if (tool === "cloud") {
    const rect = rectFromPoints(start, current);
    const d = buildCloudPath(rect.x, rect.y, Math.max(6, rect.w), Math.max(6, rect.h), Math.max(8, strokeWidth * 3));
    return <path d={d} fill="transparent" stroke={color} strokeWidth={strokeWidth} />;
  }
  if (tool === "highlighter" && drawingState.points.length > 1) {
    return (
      <path
        d={polylineToPath(drawingState.points)}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        opacity={0.35}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  if (tool === "stamp") {
    return <rect x={current.x} y={current.y} width={90} height={28} fill={color} opacity={0.2} />;
  }
  return null;
}

export function PdfCanvas({
  pageCount,
  pageSizes,
  pdfName,
  scale,
  annotations,
  drawingState,
  tool,
  strokeColor,
  strokeWidth,
  readOnly,
  selectedId,
  thumbnails,
  canvasRefs,
  svgRefs,
  pageRefs,
  pagesScrollRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelectAnnotation,
  setActivePage,
  activePage,
}: PdfCanvasProps) {
  const pages = Array.from({ length: pageCount }, (_, idx) => idx + 1);
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-hidden bg-slate-100 p-2">
      <aside className="w-36 shrink-0 overflow-y-auto rounded border border-slate-200 bg-white p-2">
        <div className="space-y-2">
          {pages.map((page) => (
            <button
              key={`thumb-${page}`}
              type="button"
              className={`w-full rounded border p-1 text-left text-xs ${activePage === page ? "border-sky-500" : "border-slate-200"}`}
              onClick={() => {
                setActivePage(page);
                pageRefs.current[page]?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <div className="mb-1">Page {page}</div>
              {thumbnails[page] ? <img src={thumbnails[page]} alt={`Page ${page} thumbnail`} className="w-full border border-slate-200" /> : null}
            </button>
          ))}
        </div>
      </aside>

      <section ref={pagesScrollRef} className="min-h-0 flex-1 overflow-auto rounded border border-slate-200 bg-slate-50 p-3">
        <div className="space-y-4">
          {pages.map((page) => {
            const size = pageSizes[page];
            return (
              <section
                key={page}
                ref={(el) => {
                  pageRefs.current[page] = el;
                }}
                className="mx-auto w-fit rounded bg-white p-3 shadow"
                onMouseEnter={() => setActivePage(page)}
              >
                <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                  <span>
                    Page {page} / {pageCount}
                  </span>
                  <span>{pdfName}</span>
                </div>

                <div
                  className="relative"
                  style={{
                    width: size?.width ?? 1,
                    height: size?.height ?? 1,
                    transform: `scale(${scale})`,
                    transformOrigin: "top left",
                  }}
                >
                  <canvas
                    ref={(el) => {
                      canvasRefs.current[page] = el;
                    }}
                    className="block border border-slate-100"
                  />
                  {size ? (
                    <svg
                      ref={(el) => {
                        svgRefs.current[page] = el;
                      }}
                      className={`absolute left-0 top-0 ${readOnly ? "cursor-default" : "cursor-crosshair"}`}
                      width={size.width}
                      height={size.height}
                      viewBox={`0 0 ${size.width} ${size.height}`}
                      onPointerDown={(event) => onPointerDown(page, event)}
                      onPointerMove={(event) => onPointerMove(page, event)}
                      onPointerUp={() => onPointerUp(page)}
                      onPointerLeave={() => onPointerUp(page)}
                    >
                      <defs>
                        <marker id="pdf-editor-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                          <path d="M0,0 L0,6 L9,3 z" fill={strokeColor} />
                        </marker>
                      </defs>
                      {annotations
                        .filter((annotation) => annotation.page === page)
                        .map((annotation) => (
                          <g
                            key={annotation.id}
                            onPointerDown={(event) => {
                              if (tool !== "select") return;
                              event.stopPropagation();
                              onSelectAnnotation(annotation.id);
                            }}
                          >
                            {renderAnnotation(annotation, size, selectedId)}
                          </g>
                        ))}
                      {drawingState?.page === page ? renderActiveShape(drawingState, tool, strokeColor, strokeWidth) : null}
                    </svg>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}
