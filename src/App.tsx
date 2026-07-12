import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  buildCloudPath,
  denormalizePoint,
  downloadBlob,
  normalizePoint,
  polylineToPath,
  rectFromPoints,
} from "./annotationUtils";
import type { Annotation, MarkupDocument, Point, StampAnnotation, Tool } from "./types";

GlobalWorkerOptions.workerSrc = workerSrc;

type DrawingState =
  | {
      page: number;
      start: Point;
      current: Point;
      points: Point[];
    }
  | null;

type PageSize = { width: number; height: number };

const DEFAULT_STROKE_WIDTH = 2;
const DEFAULT_HIGHLIGHTER_WIDTH = 14;

function makeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfName, setPdfName] = useState<string>("document.pdf");
  const [pageCount, setPageCount] = useState<number>(0);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [scale, setScale] = useState<number>(1.25);
  const [tool, setTool] = useState<Tool>("select");
  const [strokeColor, setStrokeColor] = useState<string>("#ff2d55");
  const [strokeWidth, setStrokeWidth] = useState<number>(DEFAULT_STROKE_WIDTH);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [drawingState, setDrawingState] = useState<DrawingState>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stampLabel, setStampLabel] = useState<string>("APPROVED");
  const [stampImageDataUrl, setStampImageDataUrl] = useState<string | null>(null);
  const [stampOpacity, setStampOpacity] = useState<number>(0.95);

  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const svgRefs = useRef<Record<number, SVGSVGElement | null>>({});

  const sortedAnnotations = useMemo(
    () => [...annotations].sort((a, b) => a.page - b.page),
    [annotations],
  );

  useEffect(() => {
    if (!pdfDoc || pageCount === 0) {
      return;
    }

    let cancelled = false;
    const currentDoc = pdfDoc;

    async function renderPages(): Promise<void> {
      const nextSizes: Record<number, PageSize> = {};

      for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
        const canvas = canvasRefs.current[pageNum];
        if (!canvas) {
          continue;
        }

        const page = await currentDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          continue;
        }

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        nextSizes[pageNum] = { width: viewport.width, height: viewport.height };
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      }

      if (!cancelled) {
        setPageSizes(nextSizes);
      }
    }

    void renderPages();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageCount, scale]);

  async function handleFileUpload(file: File | null): Promise<void> {
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const loadingTask = getDocument({ data });
    const doc = await loadingTask.promise;
    setPdfDoc(doc);
    setPdfName(file.name);
    setPageCount(doc.numPages);
    setAnnotations([]);
    setSelectedId(null);
  }

  function getEventPoint(event: React.PointerEvent<SVGSVGElement>, page: number): Point | null {
    const size = pageSizes[page];
    if (!size) return null;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function addAnnotation(annotation: Annotation): void {
    setAnnotations((prev) => [...prev, annotation]);
  }

  function onPointerDown(page: number, event: React.PointerEvent<SVGSVGElement>): void {
    if (tool === "select") return;
    const point = getEventPoint(event, page);
    const size = pageSizes[page];
    if (!point || !size) return;

    if (tool === "stamp") {
      const normalized = normalizePoint(point, size.width, size.height);
      const baseStamp: Omit<StampAnnotation, "stampKind"> = {
        id: makeId(),
        type: "stamp",
        page,
        color: strokeColor,
        strokeWidth,
        position: normalized,
        width: 0.2,
        height: 0.08,
        opacity: stampOpacity,
      };

      if (stampImageDataUrl) {
        addAnnotation({
          ...baseStamp,
          stampKind: "image",
          imageDataUrl: stampImageDataUrl,
        });
      } else {
        addAnnotation({
          ...baseStamp,
          stampKind: "text",
          label: stampLabel || "STAMP",
        });
      }
      return;
    }

    if (tool === "highlighter") {
      setDrawingState({ page, start: point, current: point, points: [point] });
      return;
    }

    setDrawingState({ page, start: point, current: point, points: [] });
  }

  function onPointerMove(page: number, event: React.PointerEvent<SVGSVGElement>): void {
    if (!drawingState || drawingState.page !== page) return;
    const point = getEventPoint(event, page);
    if (!point) return;

    setDrawingState((prev) => {
      if (!prev || prev.page !== page) return prev;
      if (tool === "highlighter") {
        return { ...prev, current: point, points: [...prev.points, point] };
      }
      return { ...prev, current: point };
    });
  }

  function onPointerUp(page: number): void {
    if (!drawingState || drawingState.page !== page) return;

    const size = pageSizes[page];
    if (!size) return;

    const start = normalizePoint(drawingState.start, size.width, size.height);
    const end = normalizePoint(drawingState.current, size.width, size.height);
    const shared = {
      id: makeId(),
      page,
      color: strokeColor,
      strokeWidth,
    };

    if (tool === "line" || tool === "arrow") {
      addAnnotation({
        ...shared,
        type: tool,
        start,
        end,
      });
    } else if (tool === "rect") {
      addAnnotation({
        ...shared,
        type: "rect",
        start,
        end,
        fillColor: "transparent",
      });
    } else if (tool === "cloud") {
      addAnnotation({
        ...shared,
        type: "cloud",
        start,
        end,
      });
    } else if (tool === "highlighter" && drawingState.points.length > 1) {
      addAnnotation({
        ...shared,
        type: "highlighter",
        strokeWidth: DEFAULT_HIGHLIGHTER_WIDTH,
        opacity: 0.35,
        points: drawingState.points.map((p) => normalizePoint(p, size.width, size.height)),
      });
    }
    setDrawingState(null);
  }

  function removeSelected(): void {
    if (!selectedId) return;
    setAnnotations((prev) => prev.filter((annotation) => annotation.id !== selectedId));
    setSelectedId(null);
  }

  function undoLast(): void {
    setAnnotations((prev) => prev.slice(0, -1));
  }

  function clearAll(): void {
    setAnnotations([]);
    setSelectedId(null);
  }

  function saveMarkupJson(): void {
    const doc: MarkupDocument = {
      schemaVersion: 1,
      fileName: pdfName,
      createdAt: new Date().toISOString(),
      annotations: sortedAnnotations,
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${pdfName.replace(/\.pdf$/i, "")}.markups.json`);
  }

  async function loadMarkupJson(file: File | null): Promise<void> {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text) as MarkupDocument;
    if (!Array.isArray(parsed.annotations)) {
      throw new Error("Invalid annotation payload");
    }
    setAnnotations(parsed.annotations);
    setSelectedId(null);
  }

  async function exportAnnotatedPngs(): Promise<void> {
    for (let page = 1; page <= pageCount; page += 1) {
      const baseCanvas = canvasRefs.current[page];
      const svg = svgRefs.current[page];
      const size = pageSizes[page];
      if (!baseCanvas || !svg || !size) {
        continue;
      }

      const output = document.createElement("canvas");
      output.width = size.width;
      output.height = size.height;
      const ctx = output.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(baseCanvas, 0, 0);

      const serialized = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = svgUrl;
      });
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(svgUrl);

      const pngBlob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, "image/png"));
      if (!pngBlob) continue;
      downloadBlob(pngBlob, `${pdfName.replace(/\.pdf$/i, "")}-page-${page}.png`);
    }
  }

  function renderAnnotation(annotation: Annotation, page: number): ReactElement | null {
    const size = pageSizes[page];
    if (!size) return null;

    const selected = selectedId === annotation.id;
    const commonProps = {
      onClick: (event: React.MouseEvent<SVGElement>) => {
        event.stopPropagation();
        if (tool === "select") {
          setSelectedId(annotation.id);
        }
      },
      style: { cursor: tool === "select" ? "pointer" : "crosshair" },
      stroke: annotation.color,
      strokeWidth: selected ? annotation.strokeWidth + 1.25 : annotation.strokeWidth,
      "data-annotation-id": annotation.id,
    };

    if (annotation.type === "line" || annotation.type === "arrow") {
      const start = denormalizePoint(annotation.start, size.width, size.height);
      const end = denormalizePoint(annotation.end, size.width, size.height);
      return (
        <line
          key={annotation.id}
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          markerEnd={annotation.type === "arrow" ? `url(#arrow-${page})` : undefined}
          {...commonProps}
        />
      );
    }

    if (annotation.type === "rect") {
      const start = denormalizePoint(annotation.start, size.width, size.height);
      const end = denormalizePoint(annotation.end, size.width, size.height);
      const rect = rectFromPoints(start, end);
      return (
        <rect
          key={annotation.id}
          x={rect.x}
          y={rect.y}
          width={Math.max(2, rect.w)}
          height={Math.max(2, rect.h)}
          fill={annotation.fillColor ?? "transparent"}
          {...commonProps}
        />
      );
    }

    if (annotation.type === "cloud") {
      const start = denormalizePoint(annotation.start, size.width, size.height);
      const end = denormalizePoint(annotation.end, size.width, size.height);
      const rect = rectFromPoints(start, end);
      const d = buildCloudPath(rect.x, rect.y, Math.max(rect.w, 8), Math.max(rect.h, 8));
      return <path key={annotation.id} d={d} fill="transparent" {...commonProps} />;
    }

    if (annotation.type === "highlighter") {
      const points = annotation.points.map((point) => denormalizePoint(point, size.width, size.height));
      const d = polylineToPath(points);
      return (
        <path
          key={annotation.id}
          d={d}
          fill="none"
          stroke={annotation.color}
          strokeWidth={annotation.strokeWidth}
          opacity={annotation.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
          onClick={commonProps.onClick}
          style={commonProps.style}
        />
      );
    }

    if (annotation.type === "stamp") {
      const position = denormalizePoint(annotation.position, size.width, size.height);
      const width = annotation.width * size.width;
      const height = annotation.height * size.height;
      const x = position.x - width / 2;
      const y = position.y - height / 2;
      if (annotation.stampKind === "image" && annotation.imageDataUrl) {
        return (
          <image
            key={annotation.id}
            href={annotation.imageDataUrl}
            x={x}
            y={y}
            width={width}
            height={height}
            opacity={annotation.opacity}
            onClick={commonProps.onClick}
            style={commonProps.style}
          />
        );
      }

      return (
        <g key={annotation.id} onClick={commonProps.onClick} style={commonProps.style} opacity={annotation.opacity}>
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill="rgba(255,255,255,0.7)"
            stroke={annotation.color}
            strokeWidth={selected ? annotation.strokeWidth + 1 : annotation.strokeWidth}
            rx={4}
            ry={4}
          />
          <text
            x={position.x}
            y={position.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={Math.max(12, height * 0.32)}
            fontWeight={700}
            fill={annotation.color}
          >
            {annotation.label ?? "STAMP"}
          </text>
        </g>
      );
    }

    return null;
  }

  function renderActiveShape(page: number): ReactElement | null {
    if (!drawingState || drawingState.page !== page) return null;
    const start = drawingState.start;
    const current = drawingState.current;

    if (tool === "line" || tool === "arrow") {
      return (
        <line
          x1={start.x}
          y1={start.y}
          x2={current.x}
          y2={current.y}
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          markerEnd={tool === "arrow" ? `url(#arrow-${page})` : undefined}
          pointerEvents="none"
        />
      );
    }

    if (tool === "rect") {
      const rect = rectFromPoints(start, current);
      return (
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          fill="transparent"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          pointerEvents="none"
        />
      );
    }

    if (tool === "cloud") {
      const rect = rectFromPoints(start, current);
      const d = buildCloudPath(rect.x, rect.y, Math.max(rect.w, 8), Math.max(rect.h, 8));
      return <path d={d} fill="transparent" stroke={strokeColor} strokeWidth={strokeWidth} pointerEvents="none" />;
    }

    if (tool === "highlighter" && drawingState.points.length > 1) {
      return (
        <path
          d={polylineToPath(drawingState.points)}
          fill="none"
          stroke={strokeColor}
          strokeWidth={DEFAULT_HIGHLIGHTER_WIDTH}
          opacity={0.35}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      );
    }

    return null;
  }

  const pages = Array.from({ length: pageCount }, (_, idx) => idx + 1);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="group">
          <label className="uploadLabel">
            Open PDF
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => {
                void handleFileUpload(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label className="uploadLabel">
            Load Markups
            <input
              type="file"
              accept="application/json"
              onChange={(event) => {
                void loadMarkupJson(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button type="button" onClick={saveMarkupJson} disabled={annotations.length === 0}>
            Save Markups
          </button>
          <button type="button" onClick={() => void exportAnnotatedPngs()} disabled={!pdfDoc}>
            Export PNG
          </button>
        </div>

        <div className="group">
          {(["select", "line", "arrow", "rect", "cloud", "highlighter", "stamp"] as Tool[]).map((name) => (
            <button
              key={name}
              type="button"
              className={tool === name ? "active" : ""}
              onClick={() => {
                setTool(name);
                setSelectedId(null);
              }}
            >
              {name}
            </button>
          ))}
        </div>

        <div className="group">
          <label>
            Color
            <input type="color" value={strokeColor} onChange={(event) => setStrokeColor(event.target.value)} />
          </label>
          <label>
            Width
            <input
              type="range"
              min={1}
              max={12}
              value={strokeWidth}
              onChange={(event) => setStrokeWidth(Number(event.target.value))}
            />
          </label>
          <label>
            Zoom
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={scale}
              onChange={(event) => setScale(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="group">
          <label>
            Stamp text
            <input type="text" value={stampLabel} onChange={(event) => setStampLabel(event.target.value)} />
          </label>
          <label className="uploadLabel">
            Stamp image
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  setStampImageDataUrl(typeof reader.result === "string" ? reader.result : null);
                };
                reader.readAsDataURL(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button type="button" onClick={() => setStampImageDataUrl(null)}>
            Text stamp mode
          </button>
          <label>
            Stamp opacity
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={stampOpacity}
              onChange={(event) => setStampOpacity(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="group">
          <button type="button" onClick={undoLast} disabled={annotations.length === 0}>
            Undo
          </button>
          <button type="button" onClick={removeSelected} disabled={!selectedId}>
            Delete Selected
          </button>
          <button type="button" onClick={clearAll} disabled={annotations.length === 0}>
            Clear
          </button>
        </div>
      </header>

      <main className="viewer">
        {!pdfDoc ? (
          <div className="empty">Upload a PDF to start annotating.</div>
        ) : (
          pages.map((page) => {
            const size = pageSizes[page];
            return (
              <section key={page} className="pageSection">
                <div className="pageHeader">
                  <h3>
                    Page {page} / {pageCount}
                  </h3>
                  <span>{pdfName}</span>
                </div>

                <div
                  className="pageCanvasWrap"
                  style={{
                    width: size?.width ?? "fit-content",
                    height: size?.height ?? "fit-content",
                  }}
                >
                  <canvas
                    ref={(el) => {
                      canvasRefs.current[page] = el;
                    }}
                    className="pdfCanvas"
                  />
                  {size ? (
                    <svg
                      ref={(el) => {
                        svgRefs.current[page] = el;
                      }}
                      className="overlay"
                      width={size.width}
                      height={size.height}
                      viewBox={`0 0 ${size.width} ${size.height}`}
                      onPointerDown={(event) => onPointerDown(page, event)}
                      onPointerMove={(event) => onPointerMove(page, event)}
                      onPointerUp={() => onPointerUp(page)}
                      onPointerLeave={() => onPointerUp(page)}
                      onClick={() => {
                        if (tool === "select") setSelectedId(null);
                      }}
                    >
                      <defs>
                        <marker
                          id={`arrow-${page}`}
                          markerWidth="10"
                          markerHeight="10"
                          refX="8"
                          refY="3"
                          orient="auto"
                          markerUnits="strokeWidth"
                        >
                          <path d="M0,0 L0,6 L9,3 z" fill={strokeColor} />
                        </marker>
                      </defs>

                      {annotations
                        .filter((annotation) => annotation.page === page)
                        .map((annotation) => renderAnnotation(annotation, page))}
                      {renderActiveShape(page)}
                    </svg>
                  ) : null}
                </div>
              </section>
            );
          })
        )}
      </main>
    </div>
  );
}

export default App;
