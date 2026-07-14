import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { clamp01, normalizePoint } from "./geometry";
import { PdfCanvas } from "./canvas";
import { Toolbar } from "./toolbar";
import type { Annotation, DrawingState, PageSize, PdfEditorProps, Point, Tool } from "./types";
import { buildFlattenedPdf, clampScale, makeId, parseInitialAnnotations, serializeAnnotations } from "./utils";

GlobalWorkerOptions.workerSrc = workerSrc;

function pointerToSvg(event: ReactPointerEvent<SVGSVGElement>): Point {
  const svg = event.currentTarget;
  const rect = svg.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function clampToPage(point: Point, size: PageSize): Point {
  return {
    x: Math.max(0, Math.min(size.width, point.x)),
    y: Math.max(0, Math.min(size.height, point.y)),
  };
}

export function PdfEditor({ url, initialAnnotations, readOnly = false, onSave, onClose }: PdfEditorProps) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfName, setPdfName] = useState<string>("document.pdf");
  const [pageCount, setPageCount] = useState<number>(0);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [drawingState, setDrawingState] = useState<DrawingState>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [strokeColor, setStrokeColor] = useState<string>("#ef4444");
  const [strokeWidth, setStrokeWidth] = useState<number>(2);
  const [lineStyle, setLineStyle] = useState<"solid" | "dashed" | "dotted">("solid");
  const [stampLabel, setStampLabel] = useState<string>("APPROVED");
  const [activePage, setActivePage] = useState<number>(1);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const svgRefs = useRef<Record<number, SVGSVGElement | null>>({});
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const pagesScrollRef = useRef<HTMLElement | null>(null);

  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedId) ?? null,
    [annotations, selectedId],
  );

  useEffect(() => {
    setAnnotations(parseInitialAnnotations(initialAnnotations));
  }, [initialAnnotations]);

  useEffect(() => {
    let cancelled = false;
    async function loadPdf() {
      setError("");
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch PDF (${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        setPdfBytes(bytes);
        const baseName = url.split("?")[0].split("/").pop();
        setPdfName(baseName || "document.pdf");
        const loaded = await getDocument({ data: bytes }).promise;
        if (cancelled) return;
        setPdfDoc(loaded);
        setPageCount(loaded.numPages);
        setActivePage(1);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    void loadPdf();
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!pdfDoc) return;
    const doc = pdfDoc;
    let disposed = false;
    async function renderPages() {
      const sizes: Record<number, PageSize> = {};
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        sizes[i] = { width: viewport.width, height: viewport.height };
      }
      if (disposed) return;
      setPageSizes(sizes);

      for (let i = 1; i <= doc.numPages; i += 1) {
        const canvas = canvasRefs.current[i];
        if (!canvas) continue;
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      }
    }
    void renderPages();
    return () => {
      disposed = true;
    };
  }, [pdfDoc]);

  useEffect(() => {
    if (!pdfDoc) return;
    const doc = pdfDoc;
    let cancelled = false;
    async function renderThumbnails() {
      const nextThumbs: Record<number, string> = {};
      for (let i = 1; i <= doc.numPages; i += 1) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 0.2 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        nextThumbs[i] = canvas.toDataURL("image/png");
      }
      if (!cancelled) setThumbnails(nextThumbs);
    }
    void renderThumbnails();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc]);

  function onPointerDown(page: number, event: ReactPointerEvent<SVGSVGElement>) {
    if (readOnly || tool === "select") return;
    const size = pageSizes[page];
    if (!size) return;
    const pointer = clampToPage(pointerToSvg(event), size);
    const points = tool === "highlighter" ? [pointer] : [];
    setDrawingState({
      page,
      start: pointer,
      current: pointer,
      points,
    });
    setSelectedId(null);
  }

  function onPointerMove(page: number, event: ReactPointerEvent<SVGSVGElement>) {
    setActivePage(page);
    if (!drawingState || drawingState.page !== page) return;
    const size = pageSizes[page];
    if (!size) return;
    const pointer = clampToPage(pointerToSvg(event), size);
    setDrawingState((prev) => {
      if (!prev) return prev;
      if (tool === "highlighter") {
        return {
          ...prev,
          current: pointer,
          points: [...prev.points, pointer],
        };
      }
      return { ...prev, current: pointer };
    });
  }

  function onPointerUp(page: number) {
    if (!drawingState || drawingState.page !== page) return;
    const size = pageSizes[page];
    if (!size) {
      setDrawingState(null);
      return;
    }
    const startN = normalizePoint(drawingState.start, size.width, size.height);
    const endN = normalizePoint(drawingState.current, size.width, size.height);
    const nextId = makeId();
    let next: Annotation | null = null;
    if (tool === "line" || tool === "arrow") {
      next = {
        id: nextId,
        page,
        type: tool,
        start: startN,
        end: endN,
        color: strokeColor,
        strokeWidth,
        lineStyle,
      };
    } else if (tool === "rect") {
      next = {
        id: nextId,
        page,
        type: "rect",
        start: startN,
        end: endN,
        color: strokeColor,
        strokeWidth,
        lineStyle,
      };
    } else if (tool === "cloud") {
      next = {
        id: nextId,
        page,
        type: "cloud",
        start: startN,
        end: endN,
        color: strokeColor,
        strokeWidth,
        lineStyle,
      };
    } else if (tool === "highlighter" && drawingState.points.length > 1) {
      next = {
        id: nextId,
        page,
        type: "highlighter",
        points: drawingState.points.map((point) => normalizePoint(point, size.width, size.height)),
        color: strokeColor,
        strokeWidth,
        lineStyle,
        opacity: 0.35,
      };
    } else if (tool === "stamp") {
      next = {
        id: nextId,
        page,
        type: "stamp",
        position: {
          x: clamp01(endN.x),
          y: clamp01(endN.y),
        },
        width: 0.16,
        height: 0.05,
        color: strokeColor,
        strokeWidth,
        lineStyle,
        label: stampLabel.trim() || "STAMP",
        opacity: 0.95,
      };
    }

    if (next) {
      setAnnotations((prev) => [...prev, next]);
      setSelectedId(next.id);
    }
    setDrawingState(null);
  }

  function deleteSelected() {
    if (readOnly || !selectedId) return;
    setAnnotations((prev) => prev.filter((annotation) => annotation.id !== selectedId));
    setSelectedId(null);
  }

  async function save() {
    if (!onSave || !pdfBytes) return;
    setSaving(true);
    setError("");
    try {
      const blob = await buildFlattenedPdf(pdfBytes, annotations, pageSizes);
      await onSave({ pdfBlob: blob, annotations: serializeAnnotations(annotations) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded border border-slate-200 bg-white">
      <Toolbar
        tool={tool}
        setTool={setTool}
        readOnly={readOnly}
        strokeColor={strokeColor}
        setStrokeColor={setStrokeColor}
        strokeWidth={strokeWidth}
        setStrokeWidth={setStrokeWidth}
        lineStyle={lineStyle}
        setLineStyle={setLineStyle}
        stampLabel={stampLabel}
        setStampLabel={setStampLabel}
        scale={scale}
        onZoomIn={() => setScale((prev) => clampScale(prev + 0.1))}
        onZoomOut={() => setScale((prev) => clampScale(prev - 0.1))}
        onZoomReset={() => setScale(1)}
        onDeleteSelected={deleteSelected}
        hasSelected={Boolean(selectedAnnotation)}
        onSave={onSave ? () => void save() : undefined}
        saving={saving}
        onClose={onClose}
      />

      {error ? <div className="shrink-0 border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div> : null}

      {!pdfDoc ? (
        <div className="grid min-h-0 flex-1 place-items-center p-4 text-sm text-slate-500">Loading PDF...</div>
      ) : (
        <PdfCanvas
          pageCount={pageCount}
          pageSizes={pageSizes}
          pdfName={pdfName}
          scale={scale}
          annotations={annotations}
          drawingState={drawingState}
          tool={tool}
          strokeColor={strokeColor}
          strokeWidth={strokeWidth}
          readOnly={readOnly}
          selectedId={selectedId}
          thumbnails={thumbnails}
          canvasRefs={canvasRefs}
          svgRefs={svgRefs}
          pageRefs={pageRefs}
          pagesScrollRef={pagesScrollRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onSelectAnnotation={(annotationId) => {
            if (tool !== "select") return;
            setSelectedId(annotationId);
          }}
          setActivePage={setActivePage}
          activePage={activePage}
        />
      )}
    </section>
  );
}

export type { PdfEditorProps, PdfEditorSaveResult } from "./types";
