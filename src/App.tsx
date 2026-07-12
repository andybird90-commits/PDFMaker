import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  buildCloudPath,
  clamp01,
  denormalizePoint,
  downloadBlob,
  lineStyleToDash,
  normalizePoint,
  polylineToPath,
  rectFromPoints,
} from "./annotationUtils";
import type {
  Annotation,
  EditorProjectDocument,
  LineStyle,
  MarkupDocument,
  MeasureAnnotation,
  PinStatus,
  Point,
  StampAnnotation,
  Tool,
} from "./types";

GlobalWorkerOptions.workerSrc = workerSrc;

type DrawingState =
  | {
      page: number;
      start: Point;
      current: Point;
      points: Point[];
    }
  | null;

type InteractionState =
  | {
      page: number;
      annotationId: string;
      mode: "move" | "resize";
      handle?: string;
      startPoint: Point;
      initialAnnotation: Annotation;
    }
  | null;

type PageSize = { width: number; height: number };
type CustomStamp = { id: string; name: string; dataUrl: string };
type BatchDocument = {
  id: string;
  name: string;
  bytes: Uint8Array;
  annotations: Annotation[];
  calibrationByPage: Record<number, number>;
  rotationByPage: Record<number, number>;
};

const DEFAULT_STROKE_WIDTH = 2;
const DEFAULT_HIGHLIGHTER_WIDTH = 14;
const DEFAULT_HIGHLIGHTER_COLOR = "#ffe45e";
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const CUSTOM_STAMPS_STORAGE_KEY = "pdfmaker.customStamps.v1";
const PIN_STATUS_COLOR: Record<PinStatus, string> = {
  open: "#dc2626",
  in_progress: "#2563eb",
  scheduled: "#ca8a04",
  closed: "#16a34a",
};

const STAMP_PRESETS: Array<{ id: string; label: string; color: string }> = [
  { id: "approved", label: "APPROVED", color: "#0f766e" },
  { id: "construction", label: "CONSTRUCTION", color: "#1d4ed8" },
  { id: "status-a", label: "STATUS A", color: "#059669" },
  { id: "status-b", label: "STATUS B", color: "#ca8a04" },
  { id: "status-c", label: "STATUS C", color: "#dc2626" },
];

function makeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfName, setPdfName] = useState<string>("document.pdf");
  const [pageCount, setPageCount] = useState<number>(0);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [scale, setScale] = useState<number>(1.25);
  const [tool, setTool] = useState<Tool>("select");
  const [strokeColor, setStrokeColor] = useState<string>("#ff2d55");
  const [highlighterColor, setHighlighterColor] = useState<string>(DEFAULT_HIGHLIGHTER_COLOR);
  const [strokeWidth, setStrokeWidth] = useState<number>(DEFAULT_STROKE_WIDTH);
  const [highlighterWidth, setHighlighterWidth] = useState<number>(DEFAULT_HIGHLIGHTER_WIDTH);
  const [lineStyle, setLineStyle] = useState<LineStyle>("solid");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [drawingState, setDrawingState] = useState<DrawingState>(null);
  const [interaction, setInteraction] = useState<InteractionState>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stampLabel, setStampLabel] = useState<string>("APPROVED");
  const [stampOpacity, setStampOpacity] = useState<number>(0.95);
  const [activeStampPresetId, setActiveStampPresetId] = useState<string>("approved");
  const [customStamps, setCustomStamps] = useState<CustomStamp[]>([]);
  const [activeCustomStampId, setActiveCustomStampId] = useState<string>("");
  const [pdfFileHandle, setPdfFileHandle] = useState<any | null>(null);
  const [actionNotice, setActionNotice] = useState<string>("");
  const [calibrationByPage, setCalibrationByPage] = useState<Record<number, number>>({});
  const [rotationByPage, setRotationByPage] = useState<Record<number, number>>({});
  const [batchDocuments, setBatchDocuments] = useState<BatchDocument[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string>("");
  const [activePage, setActivePage] = useState<number>(1);

  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const svgRefs = useRef<Record<number, SVGSVGElement | null>>({});
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const pagesScrollRef = useRef<HTMLElement | null>(null);
  const zoomAnchorRef = useRef<{ mouseX: number; mouseY: number; contentX: number; contentY: number } | null>(null);
  const openInputRef = useRef<HTMLInputElement | null>(null);
  const loadMarkupInputRef = useRef<HTMLInputElement | null>(null);
  const openBatchInputRef = useRef<HTMLInputElement | null>(null);
  const [isMiddlePanning, setIsMiddlePanning] = useState<boolean>(false);
  const panStateRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);
  const pinchStateRef = useRef<{
    initialDistance: number;
    initialScale: number;
    anchorX: number;
    anchorY: number;
    contentX: number;
    contentY: number;
  } | null>(null);
  const suppressBatchSyncRef = useRef<boolean>(false);

  const sortedAnnotations = useMemo(
    () => [...annotations].sort((a, b) => a.page - b.page),
    [annotations],
  );
  const selectedAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === selectedId) ?? null,
    [annotations, selectedId],
  );
  const lastRotatableAnnotation = useMemo(
    () =>
      [...annotations]
        .reverse()
        .find((annotation) =>
          ["line", "arrow", "rect", "cloud", "highlighter", "stamp", "measure"].includes(annotation.type),
        ) ?? null,
    [annotations],
  );
  const pinNumberById = useMemo(() => {
    const map = new Map<string, number>();
    let index = 1;
    for (const annotation of sortedAnnotations) {
      if (annotation.type === "pin") {
        map.set(annotation.id, index);
        index += 1;
      }
    }
    return map;
  }, [sortedAnnotations]);
  const activeStampPreset = useMemo(
    () => STAMP_PRESETS.find((preset) => preset.id === activeStampPresetId) ?? STAMP_PRESETS[0],
    [activeStampPresetId],
  );
  const activeCustomStamp = useMemo(
    () => customStamps.find((stamp) => stamp.id === activeCustomStampId) ?? null,
    [customStamps, activeCustomStampId],
  );
  const activePageForTools = selectedAnnotation?.page ?? activePage;
  const activeCalibration = calibrationByPage[activePageForTools];

  useEffect(() => {
    setStampLabel(activeStampPreset.label);
    setStrokeColor(activeStampPreset.color);
  }, [activeStampPreset]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CUSTOM_STAMPS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CustomStamp[];
      if (!Array.isArray(parsed)) return;
      const valid = parsed.filter((stamp) => typeof stamp?.id === "string" && typeof stamp?.dataUrl === "string");
      setCustomStamps(valid);
    } catch {
      // Ignore malformed local cache and continue.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CUSTOM_STAMPS_STORAGE_KEY, JSON.stringify(customStamps));
  }, [customStamps]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTypingContext =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        target?.isContentEditable;
      if (isTypingContext) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selectedId) return;
        event.preventDefault();
        removeSelected();
        notify("Deleted selected annotation.");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId]);

  useEffect(() => {
    if (!activeBatchId || suppressBatchSyncRef.current) return;
    setBatchDocuments((prev) =>
      prev.map((document) =>
        document.id === activeBatchId
          ? { ...document, annotations, calibrationByPage, rotationByPage }
          : document,
      ),
    );
  }, [annotations, calibrationByPage, rotationByPage, activeBatchId]);

  function statusLabel(status: PinStatus): string {
    if (status === "in_progress") return "In progress";
    if (status === "scheduled") return "Scheduled";
    if (status === "closed") return "Closed";
    return "Open";
  }

  function normalizeImportedAnnotation(annotation: Annotation): Annotation {
    if (annotation.type === "pin") {
      return {
        ...annotation,
        lineStyle: annotation.lineStyle ?? "solid",
        color: PIN_STATUS_COLOR[annotation.status] ?? annotation.color,
      };
    }
    return {
      ...annotation,
      lineStyle: annotation.lineStyle ?? "solid",
    };
  }

  function normalizedDistance(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function calibrationFactorForPage(page: number): number | null {
    return calibrationByPage[page] ?? null;
  }

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
        const rotation = rotationByPage[pageNum] ?? 0;
        const viewport = page.getViewport({ scale, rotation });
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
  }, [pdfDoc, pageCount, scale, rotationByPage]);

  useEffect(() => {
    if (!pdfDoc || pageCount === 0) {
      setThumbnails({});
      return;
    }

    let cancelled = false;
    const currentDoc = pdfDoc;

    async function renderThumbnails(): Promise<void> {
      const next: Record<number, string> = {};
      for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
        const page = await currentDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.22 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        next[pageNum] = canvas.toDataURL("image/png");
      }
      if (!cancelled) {
        setThumbnails(next);
      }
    }

    void renderThumbnails();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageCount]);

  useEffect(() => {
    const anchor = zoomAnchorRef.current;
    const container = pagesScrollRef.current;
    if (!anchor || !container) return;
    container.scrollLeft = Math.max(0, anchor.contentX * scale - anchor.mouseX);
    container.scrollTop = Math.max(0, anchor.contentY * scale - anchor.mouseY);
    zoomAnchorRef.current = null;
  }, [scale]);

  async function loadPdfBytes(data: Uint8Array, fileName: string): Promise<void> {
    const loadingTask = getDocument({ data });
    const doc = await loadingTask.promise;
    setPdfDoc(doc);
    setPdfBytes(data);
    setPdfName(fileName);
    setPageCount(doc.numPages);
    setSelectedId(null);
  }

  function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function handlePdfFile(file: File): Promise<void> {
    const data = new Uint8Array(await file.arrayBuffer());
    const document: BatchDocument = {
      id: makeId(),
      name: file.name,
      bytes: data,
      annotations: [],
      calibrationByPage: {},
      rotationByPage: {},
    };
    suppressBatchSyncRef.current = true;
    setBatchDocuments([document]);
    setActiveBatchId(document.id);
    await loadPdfBytes(data, file.name);
    setAnnotations(document.annotations);
    setCalibrationByPage({});
    setRotationByPage({});
    setActivePage(1);
    suppressBatchSyncRef.current = false;
    setPdfFileHandle(null);
  }

  async function handleOpenBatch(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const batch = await Promise.all(
      Array.from(files).map(async (file) => ({
        id: makeId(),
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        annotations: [] as Annotation[],
        calibrationByPage: {},
        rotationByPage: {},
      })),
    );
    if (batch.length === 0) return;
    suppressBatchSyncRef.current = true;
    setBatchDocuments(batch);
    setActiveBatchId(batch[0].id);
    await loadPdfBytes(batch[0].bytes, batch[0].name);
    setAnnotations([]);
    setCalibrationByPage(batch[0].calibrationByPage);
    setRotationByPage(batch[0].rotationByPage);
    setActivePage(1);
    suppressBatchSyncRef.current = false;
    setPdfFileHandle(null);
    notify(`Loaded batch of ${batch.length} PDFs.`);
  }

  async function switchBatchDocument(documentId: string): Promise<void> {
    const target = batchDocuments.find((document) => document.id === documentId);
    if (!target || target.id === activeBatchId) return;
    suppressBatchSyncRef.current = true;
    setActiveBatchId(target.id);
    await loadPdfBytes(target.bytes, target.name);
    setAnnotations(target.annotations);
    setCalibrationByPage(target.calibrationByPage);
    setRotationByPage(target.rotationByPage);
    setActivePage(1);
    setSelectedId(null);
    suppressBatchSyncRef.current = false;
    setPdfFileHandle(null);
  }

  async function handleProjectOpen(parsed: EditorProjectDocument): Promise<void> {
    if (parsed.kind !== "pdfmaker-project" || typeof parsed.pdfData !== "string") {
      throw new Error("Invalid project file.");
    }
    const bytes = base64ToBytes(parsed.pdfData);
    const normalizedAnnotations = (parsed.annotations ?? []).map((annotation) =>
      normalizeImportedAnnotation(annotation),
    );
    const document: BatchDocument = {
      id: makeId(),
      name: parsed.fileName || "project.pdf",
      bytes,
      annotations: normalizedAnnotations,
      calibrationByPage: parsed.calibrationByPage ?? {},
      rotationByPage: parsed.rotationByPage ?? {},
    };
    suppressBatchSyncRef.current = true;
    setBatchDocuments([document]);
    setActiveBatchId(document.id);
    await loadPdfBytes(bytes, document.name);
    setAnnotations(normalizedAnnotations);
    setCalibrationByPage(document.calibrationByPage);
    setRotationByPage(document.rotationByPage);
    setActivePage(1);
    suppressBatchSyncRef.current = false;
  }

  async function handleOpenFile(file: File | null): Promise<"pdf" | "project" | "markups" | "unknown"> {
    if (!file) return "unknown";
    if (file.name.toLowerCase().endsWith(".pdf")) {
      await handlePdfFile(file);
      return "pdf";
    }
    const text = await file.text();
    const parsed = JSON.parse(text) as MarkupDocument | EditorProjectDocument;
    if ((parsed as EditorProjectDocument).kind === "pdfmaker-project") {
      await handleProjectOpen(parsed as EditorProjectDocument);
      return "project";
    }
    if (Array.isArray((parsed as MarkupDocument).annotations)) {
      setAnnotations(
        (parsed as MarkupDocument).annotations.map((annotation) => normalizeImportedAnnotation(annotation)),
      );
      setCalibrationByPage((parsed as MarkupDocument).calibrationByPage ?? {});
      setRotationByPage((parsed as MarkupDocument).rotationByPage ?? {});
      setSelectedId(null);
      return "markups";
    }
    throw new Error("Unsupported file format. Use PDF, project JSON, or markups JSON.");
  }

  async function triggerOpenDialog(): Promise<void> {
    if (typeof (window as any).showOpenFilePicker === "function") {
      const [handle] = await (window as any).showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "PDFMaker files",
            accept: {
              "application/pdf": [".pdf"],
              "application/json": [".json", ".pdfmaker.json"],
            },
          },
        ],
      });
      if (!handle) return;
      const file = await handle.getFile();
      const opened = await handleOpenFile(file);
      setPdfFileHandle(opened === "pdf" ? handle : null);
      return;
    }
    openInputRef.current?.click();
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

  function beginInteraction(
    event: React.PointerEvent<SVGElement>,
    annotation: Annotation,
    page: number,
    mode: "move" | "resize",
    handle?: string,
  ): void {
    if (tool !== "select") return;
    if (event.button !== 0) return;
    event.stopPropagation();
    const svg = svgRefs.current[page];
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setSelectedId(annotation.id);
    setInteraction({
      page,
      annotationId: annotation.id,
      mode,
      handle,
      startPoint: { x: event.clientX - rect.left, y: event.clientY - rect.top },
      initialAnnotation: annotation,
    });
  }

  function movePoint(point: Point, dx: number, dy: number): Point {
    return {
      x: clamp01(point.x + dx),
      y: clamp01(point.y + dy),
    };
  }

  function updateSelectedAnnotation(updater: (annotation: Annotation) => Annotation): void {
    if (!selectedId) return;
    setAnnotations((prev) =>
      prev.map((annotation) => (annotation.id === selectedId ? updater(annotation) : annotation)),
    );
  }

  function updateAnnotationById(targetId: string, updater: (annotation: Annotation) => Annotation): void {
    setAnnotations((prev) => prev.map((annotation) => (annotation.id === targetId ? updater(annotation) : annotation)));
  }

  function resizeAnnotation(annotation: Annotation, pointer: Point, handle: string): Annotation {
    if (
      annotation.type === "line" ||
      annotation.type === "arrow" ||
      (annotation.type === "measure" && annotation.measureKind === "distance")
    ) {
      if (handle === "start") return { ...annotation, start: pointer };
      if (handle === "end") return { ...annotation, end: pointer };
      return annotation;
    }

    if (
      annotation.type === "rect" ||
      annotation.type === "cloud" ||
      (annotation.type === "measure" && annotation.measureKind === "area")
    ) {
      const start = annotation.start;
      const end = annotation.end;
      if (handle === "nw") return { ...annotation, start: pointer, end };
      if (handle === "ne") return { ...annotation, start: { x: start.x, y: pointer.y }, end: { x: pointer.x, y: end.y } };
      if (handle === "sw") return { ...annotation, start: { x: pointer.x, y: start.y }, end: { x: end.x, y: pointer.y } };
      if (handle === "se") return { ...annotation, start, end: pointer };
      return annotation;
    }

    if (annotation.type === "stamp") {
      const center = annotation.position;
      const left = center.x - annotation.width / 2;
      const top = center.y - annotation.height / 2;
      const right = center.x + annotation.width / 2;
      const bottom = center.y + annotation.height / 2;
      const next = { left, top, right, bottom };
      if (handle === "nw") {
        next.left = pointer.x;
        next.top = pointer.y;
      } else if (handle === "ne") {
        next.right = pointer.x;
        next.top = pointer.y;
      } else if (handle === "sw") {
        next.left = pointer.x;
        next.bottom = pointer.y;
      } else if (handle === "se") {
        next.right = pointer.x;
        next.bottom = pointer.y;
      } else {
        return annotation;
      }
      const width = Math.max(0.05, Math.abs(next.right - next.left));
      const height = Math.max(0.03, Math.abs(next.bottom - next.top));
      return {
        ...annotation,
        position: {
          x: clamp01((next.left + next.right) / 2),
          y: clamp01((next.top + next.bottom) / 2),
        },
        width,
        height,
      };
    }

    return annotation;
  }

  function onPointerDown(page: number, event: React.PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0) return;
    setActivePage(page);
    if (tool === "select") {
      setSelectedId(null);
      return;
    }
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
        lineStyle,
        position: normalized,
        width: 0.2,
        height: 0.08,
        opacity: stampOpacity,
      };

      if (activeCustomStamp) {
        addAnnotation({
          ...baseStamp,
          stampKind: "image",
          imageDataUrl: activeCustomStamp.dataUrl,
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

    if (tool === "pin") {
      const normalized = normalizePoint(point, size.width, size.height);
      const pinId = makeId();
      addAnnotation({
        id: pinId,
        type: "pin",
        page,
        color: PIN_STATUS_COLOR.open,
        strokeWidth: 2,
        lineStyle: "solid",
        position: normalized,
        title: `Pin ${pinNumberById.size + 1}`,
        description: "",
        status: "open",
        scheduledFor: "",
        createdAt: new Date().toISOString(),
      });
      setSelectedId(pinId);
      setTool("select");
      return;
    }

    if (tool === "highlighter") {
      setDrawingState({ page, start: point, current: point, points: [point] });
      return;
    }

    setDrawingState({ page, start: point, current: point, points: [] });
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
      lineStyle,
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
        color: highlighterColor,
        strokeWidth: highlighterWidth,
        opacity: 0.35,
        points: drawingState.points.map((p) => normalizePoint(p, size.width, size.height)),
      });
    } else if (tool === "calibrate") {
      const distance = normalizedDistance(start, end);
      if (distance <= 0.0001) {
        notify("Calibration line too short.");
      } else {
        const entered = window.prompt("Known length in millimeters (mm):", "1000");
        if (entered && !Number.isNaN(Number(entered))) {
          const knownMm = Number(entered);
          if (knownMm > 0) {
            const mmPerUnit = knownMm / distance;
            setCalibrationByPage((prev) => ({ ...prev, [page]: mmPerUnit }));
            notify(`Calibrated page ${page}: ${knownMm} mm.`);
          }
        }
      }
    } else if (tool === "measure-distance") {
      const factor = calibrationFactorForPage(page);
      if (!factor) {
        notify("Calibrate this page first (mm).");
      } else {
        const distanceMm = normalizedDistance(start, end) * factor;
        const label = `${distanceMm.toFixed(1)} mm`;
        const measure: MeasureAnnotation = {
          ...shared,
          type: "measure",
          measureKind: "distance",
          start,
          end,
          label,
          valueMm: distanceMm,
        };
        addAnnotation(measure);
      }
    } else if (tool === "measure-area") {
      const factor = calibrationFactorForPage(page);
      if (!factor) {
        notify("Calibrate this page first (mm).");
      } else {
        const widthUnits = Math.abs(end.x - start.x);
        const heightUnits = Math.abs(end.y - start.y);
        const widthMm = widthUnits * factor;
        const heightMm = heightUnits * factor;
        const areaMm2 = widthMm * heightMm;
        const label = `${areaMm2.toFixed(1)} mm²`;
        const measure: MeasureAnnotation = {
          ...shared,
          type: "measure",
          measureKind: "area",
          start,
          end,
          label,
          areaMm2,
        };
        addAnnotation(measure);
      }
    }
    setDrawingState(null);
    setInteraction(null);
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

  function exportPinsJson(): void {
    try {
      const pins = sortedAnnotations.filter((annotation) => annotation.type === "pin");
      const payload = {
        schemaVersion: 1,
        fileName: pdfName,
        exportedAt: new Date().toISOString(),
        pins,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      downloadBlob(blob, `${pdfName.replace(/\.pdf$/i, "")}.pins.json`);
      notify("Pins JSON exported.");
    } catch (error) {
      const message = getErrorMessage(error);
      notify(`Pins JSON export failed: ${message}`);
      window.alert(`Pins JSON export failed:\n${message}`);
    }
  }

  function csvEscape(value: string): string {
    if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
      return `"${value.replaceAll("\"", "\"\"")}"`;
    }
    return value;
  }

  function exportPinsCsv(): void {
    try {
      const pins = sortedAnnotations.filter((annotation) => annotation.type === "pin");
      const header = [
        "Pin Number",
        "Pin ID",
        "Page",
        "Title",
        "Description",
        "Status",
        "Scheduled For",
        "Created At",
        "Has Photo",
        "X",
        "Y",
      ];
      const rows = pins.map((pin) => [
        String(pinNumberById.get(pin.id) ?? ""),
        pin.id,
        String(pin.page),
        pin.title,
        pin.description,
        statusLabel(pin.status),
        pin.scheduledFor,
        pin.createdAt,
        pin.photoDataUrl ? "Yes" : "No",
        pin.position.x.toFixed(4),
        pin.position.y.toFixed(4),
      ]);
      const csv = [header, ...rows].map((row) => row.map((cell) => csvEscape(cell)).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      downloadBlob(blob, `${pdfName.replace(/\.pdf$/i, "")}.pins.csv`);
      notify("Pins CSV exported.");
    } catch (error) {
      const message = getErrorMessage(error);
      notify(`Pins CSV export failed: ${message}`);
      window.alert(`Pins CSV export failed:\n${message}`);
    }
  }

  function onViewportWheel(event: React.WheelEvent<HTMLElement>): void {
    if (!pdfDoc) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    zoomAnchorRef.current = {
      mouseX,
      mouseY,
      contentX: (target.scrollLeft + mouseX) / scale,
      contentY: (target.scrollTop + mouseY) / scale,
    };
    const nextScale = scale - event.deltaY * 0.0012;
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale)));
  }

  function zoomIn(): void {
    setScale((prev) => Math.min(MAX_SCALE, prev + 0.1));
  }

  function zoomOut(): void {
    setScale((prev) => Math.max(MIN_SCALE, prev - 0.1));
  }

  function zoomReset(): void {
    setScale(1.25);
  }

  function notify(message: string): void {
    setActionNotice(message);
    window.setTimeout(() => {
      setActionNotice((prev) => (prev === message ? "" : prev));
    }, 4500);
  }

  function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function onViewportMouseDown(event: React.MouseEvent<HTMLElement>): void {
    if (event.button !== 1) return;
    const target = event.currentTarget;
    event.preventDefault();
    setIsMiddlePanning(true);
    panStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      left: target.scrollLeft,
      top: target.scrollTop,
    };
  }

  function onViewportMouseMove(event: React.MouseEvent<HTMLElement>): void {
    if (!isMiddlePanning || !panStateRef.current) return;
    const target = event.currentTarget;
    const dx = event.clientX - panStateRef.current.startX;
    const dy = event.clientY - panStateRef.current.startY;
    target.scrollLeft = panStateRef.current.left - dx;
    target.scrollTop = panStateRef.current.top - dy;
  }

  function endViewportPan(): void {
    setIsMiddlePanning(false);
    panStateRef.current = null;
  }

  function touchDistance(t1: { clientX: number; clientY: number }, t2: { clientX: number; clientY: number }): number {
    const dx = t2.clientX - t1.clientX;
    const dy = t2.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onViewportTouchStart(event: React.TouchEvent<HTMLElement>): void {
    if (event.touches.length < 2) return;
    const [t1, t2] = [event.touches[0], event.touches[1]];
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const midpointX = (t1.clientX + t2.clientX) / 2 - rect.left;
    const midpointY = (t1.clientY + t2.clientY) / 2 - rect.top;
    pinchStateRef.current = {
      initialDistance: touchDistance(t1, t2),
      initialScale: scale,
      anchorX: midpointX,
      anchorY: midpointY,
      contentX: (target.scrollLeft + midpointX) / scale,
      contentY: (target.scrollTop + midpointY) / scale,
    };
  }

  function onViewportTouchMove(event: React.TouchEvent<HTMLElement>): void {
    if (event.touches.length < 2 || !pinchStateRef.current) return;
    event.preventDefault();
    const [t1, t2] = [event.touches[0], event.touches[1]];
    const currentDistance = touchDistance(t1, t2);
    const ratio = currentDistance / pinchStateRef.current.initialDistance;
    const nextScale = pinchStateRef.current.initialScale * ratio;
    zoomAnchorRef.current = {
      mouseX: pinchStateRef.current.anchorX,
      mouseY: pinchStateRef.current.anchorY,
      contentX: pinchStateRef.current.contentX,
      contentY: pinchStateRef.current.contentY,
    };
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale)));
  }

  function onViewportTouchEnd(event: React.TouchEvent<HTMLElement>): void {
    if (event.touches.length < 2) {
      pinchStateRef.current = null;
    }
  }

  function addCustomStamp(name: string, dataUrl: string): void {
    const stamp: CustomStamp = {
      id: makeId(),
      name,
      dataUrl,
    };
    setCustomStamps((prev) => [stamp, ...prev]);
    setActiveCustomStampId(stamp.id);
  }

  function deleteActiveCustomStamp(): void {
    if (!activeCustomStampId) return;
    setCustomStamps((prev) => prev.filter((stamp) => stamp.id !== activeCustomStampId));
    setActiveCustomStampId("");
  }

  function applyPinStatus(status: PinStatus): void {
    updateSelectedAnnotation((annotation) =>
      annotation.type === "pin"
        ? {
            ...annotation,
            status,
            color: PIN_STATUS_COLOR[status],
          }
        : annotation,
    );
  }

  function rotatePoint(point: Point, center: Point, direction: "cw" | "ccw"): Point {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    if (direction === "cw") {
      return { x: clamp01(center.x + dy), y: clamp01(center.y - dx) };
    }
    return { x: clamp01(center.x - dy), y: clamp01(center.y + dx) };
  }

  function rotatePointUnit(point: Point, direction: "cw" | "ccw"): Point {
    if (direction === "cw") {
      return { x: clamp01(point.y), y: clamp01(1 - point.x) };
    }
    return { x: clamp01(1 - point.y), y: clamp01(point.x) };
  }

  function rotateSheet(direction: "cw" | "ccw"): void {
    const page = activePageForTools;
    setAnnotations((prev) =>
      prev.map((annotation) => {
        if (annotation.page !== page) return annotation;
        if (annotation.type === "line" || annotation.type === "arrow") {
          return {
            ...annotation,
            start: rotatePointUnit(annotation.start, direction),
            end: rotatePointUnit(annotation.end, direction),
          };
        }
        if (annotation.type === "rect" || annotation.type === "cloud" || annotation.type === "measure") {
          return {
            ...annotation,
            start: rotatePointUnit(annotation.start, direction),
            end: rotatePointUnit(annotation.end, direction),
          };
        }
        if (annotation.type === "highlighter") {
          return {
            ...annotation,
            points: annotation.points.map((point) => rotatePointUnit(point, direction)),
          };
        }
        if (annotation.type === "stamp") {
          return {
            ...annotation,
            position: rotatePointUnit(annotation.position, direction),
            width: annotation.height,
            height: annotation.width,
          };
        }
        if (annotation.type === "pin") {
          return {
            ...annotation,
            position: rotatePointUnit(annotation.position, direction),
          };
        }
        return annotation;
      }),
    );
    setRotationByPage((prev) => {
      const current = prev[page] ?? 0;
      const next = direction === "cw" ? (current + 90) % 360 : (current + 270) % 360;
      return { ...prev, [page]: next };
    });
    notify(`Rotated sheet page ${page} ${direction === "cw" ? "right" : "left"}.`);
  }

  function rotateSelectedDrawing(direction: "cw" | "ccw"): void {
    const target = selectedAnnotation ?? lastRotatableAnnotation;
    if (!target) {
      notify("Select an annotation to rotate.");
      return;
    }
    updateAnnotationById(target.id, (annotation) => {
      if (
        annotation.type === "line" ||
        annotation.type === "arrow" ||
        (annotation.type === "measure" && annotation.measureKind === "distance")
      ) {
        const center = {
          x: (annotation.start.x + annotation.end.x) / 2,
          y: (annotation.start.y + annotation.end.y) / 2,
        };
        return {
          ...annotation,
          start: rotatePoint(annotation.start, center, direction),
          end: rotatePoint(annotation.end, center, direction),
        };
      }
      if (
        annotation.type === "rect" ||
        annotation.type === "cloud" ||
        (annotation.type === "measure" && annotation.measureKind === "area")
      ) {
        const corners = [
          annotation.start,
          { x: annotation.end.x, y: annotation.start.y },
          annotation.end,
          { x: annotation.start.x, y: annotation.end.y },
        ];
        const center = {
          x: (annotation.start.x + annotation.end.x) / 2,
          y: (annotation.start.y + annotation.end.y) / 2,
        };
        const rotated = corners.map((corner) => rotatePoint(corner, center, direction));
        const xs = rotated.map((point) => point.x);
        const ys = rotated.map((point) => point.y);
        return {
          ...annotation,
          start: { x: Math.min(...xs), y: Math.min(...ys) },
          end: { x: Math.max(...xs), y: Math.max(...ys) },
        };
      }
      if (annotation.type === "highlighter") {
        const xs = annotation.points.map((point) => point.x);
        const ys = annotation.points.map((point) => point.y);
        const center = {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        };
        return {
          ...annotation,
          points: annotation.points.map((point) => rotatePoint(point, center, direction)),
        };
      }
      if (annotation.type === "stamp") {
        return {
          ...annotation,
          width: annotation.height,
          height: annotation.width,
        };
      }
      return annotation;
    });
    setSelectedId(target.id);
    notify(`Rotated ${target.type} ${direction === "cw" ? "clockwise" : "counter-clockwise"}.`);
  }

  function saveMarkupJson(): void {
    const doc: MarkupDocument = {
      schemaVersion: 1,
      fileName: pdfName,
      createdAt: new Date().toISOString(),
      annotations: sortedAnnotations,
      calibrationByPage,
      rotationByPage,
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
    setAnnotations(
      parsed.annotations.map((annotation) => normalizeImportedAnnotation(annotation)),
    );
    setCalibrationByPage(parsed.calibrationByPage ?? {});
    setRotationByPage(parsed.rotationByPage ?? {});
    setSelectedId(null);
  }

  async function exportAnnotatedPngs(): Promise<void> {
    try {
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
      notify("PNG export started.");
    } catch (error) {
      const message = getErrorMessage(error);
      notify(`PNG export failed: ${message}`);
      console.error("PNG export failed", error);
      window.alert(`PNG export failed:\n${message}`);
    }
  }

  function hexToRgb(hexColor: string): { r: number; g: number; b: number } {
    const sanitized = hexColor.replace("#", "");
    const value = sanitized.length === 3
      ? sanitized
          .split("")
          .map((c) => `${c}${c}`)
          .join("")
      : sanitized;
    const int = Number.parseInt(value, 16);
    return {
      r: (int >> 16) & 255,
      g: (int >> 8) & 255,
      b: int & 255,
    };
  }

  function toPdfColor(hexColor: string) {
    const { r, g, b } = hexToRgb(hexColor);
    return rgb(r / 255, g / 255, b / 255);
  }

  function getDashArray(style: LineStyle, width: number): number[] | undefined {
    if (style === "dashed") return [width * 4, width * 2];
    if (style === "dotted") return [width, width * 1.5];
    return undefined;
  }

  function toPdfPoint(point: Point, pageWidth: number, pageHeight: number): Point {
    return {
      x: point.x * pageWidth,
      y: (1 - point.y) * pageHeight,
    };
  }

  function dataUrlToBytes(dataUrl: string): Uint8Array {
    const base64 = dataUrl.split(",")[1] ?? "";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function dataUrlToPngBytes(dataUrl: string): Promise<Uint8Array> {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image data."));
      img.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not create image conversion canvas.");
    }
    ctx.drawImage(image, 0, 0);
    const pngDataUrl = canvas.toDataURL("image/png");
    return dataUrlToBytes(pngDataUrl);
  }

  function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const normalized = new Uint8Array(bytes.byteLength);
    normalized.set(bytes);
    return normalized.buffer;
  }

  async function getSourcePdfBytes(): Promise<Uint8Array | null> {
    if (pdfDoc) {
      const docBytes = await pdfDoc.getData();
      return new Uint8Array(docBytes);
    }
    if (!pdfBytes) return null;
    return new Uint8Array(pdfBytes);
  }

  async function buildFlattenedPdfBytes(): Promise<Uint8Array | null> {
    const sourceBytes = await getSourcePdfBytes();
    if (!sourceBytes) return null;
    const output = await PDFDocument.load(sourceBytes);
    const pages = output.getPages();
    const imageCache = new Map<string, Awaited<ReturnType<typeof output.embedPng>>>();

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      const pageNo = pageIndex + 1;
      const { width, height } = page.getSize();
      const pageAnnotations = annotations.filter((annotation) => annotation.page === pageNo);
      const pageRotation = rotationByPage[pageNo] ?? 0;
      if (pageRotation !== 0) {
        page.setRotation(degrees(pageRotation));
      }

      for (const annotation of pageAnnotations) {
        const color = toPdfColor(annotation.color);
        const dashArray = getDashArray(annotation.lineStyle ?? "solid", annotation.strokeWidth);
        if (annotation.type === "line" || annotation.type === "arrow") {
          const start = toPdfPoint(annotation.start, width, height);
          const end = toPdfPoint(annotation.end, width, height);
          page.drawLine({
            start,
            end,
            color,
            thickness: annotation.strokeWidth,
            dashArray,
          });
          if (annotation.type === "arrow") {
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const angle = Math.atan2(dy, dx);
            const arm = Math.max(8, annotation.strokeWidth * 4);
            page.drawLine({
              start: end,
              end: {
                x: end.x - arm * Math.cos(angle - Math.PI / 7),
                y: end.y - arm * Math.sin(angle - Math.PI / 7),
              },
              color,
              thickness: annotation.strokeWidth,
            });
            page.drawLine({
              start: end,
              end: {
                x: end.x - arm * Math.cos(angle + Math.PI / 7),
                y: end.y - arm * Math.sin(angle + Math.PI / 7),
              },
              color,
              thickness: annotation.strokeWidth,
            });
          }
          continue;
        }

        if (annotation.type === "rect" || annotation.type === "cloud") {
          const start = toPdfPoint(annotation.start, width, height);
          const end = toPdfPoint(annotation.end, width, height);
          const x = Math.min(start.x, end.x);
          const y = Math.min(start.y, end.y);
          const w = Math.max(1, Math.abs(end.x - start.x));
          const h = Math.max(1, Math.abs(end.y - start.y));
          if (annotation.type === "rect") {
            page.drawRectangle({
              x,
              y,
              width: w,
              height: h,
              borderColor: color,
              borderWidth: annotation.strokeWidth,
              opacity: 0,
              borderDashArray: dashArray,
            });
          } else {
            const path = buildCloudPath(0, 0, w, h, Math.max(6, annotation.strokeWidth * 2));
            page.drawSvgPath(path, {
              x,
              y,
              borderColor: color,
              borderWidth: annotation.strokeWidth,
              color: rgb(1, 1, 1),
              opacity: 0,
            });
          }
          continue;
        }

        if (annotation.type === "highlighter") {
          const points = annotation.points.map((point) => toPdfPoint(point, width, height));
          for (let i = 0; i < points.length - 1; i += 1) {
            page.drawLine({
              start: points[i],
              end: points[i + 1],
              color,
              thickness: annotation.strokeWidth,
              opacity: annotation.opacity,
              dashArray,
            });
          }
          continue;
        }

        if (annotation.type === "measure") {
          const start = toPdfPoint(annotation.start, width, height);
          const end = toPdfPoint(annotation.end, width, height);
          const measureColor = rgb(0.64, 0.9, 0.2);
          if (annotation.measureKind === "distance") {
            page.drawLine({
              start,
              end,
              color: measureColor,
              thickness: Math.max(1, annotation.strokeWidth),
              dashArray: [4, 3],
            });
            page.drawText(annotation.label, {
              x: (start.x + end.x) / 2,
              y: (start.y + end.y) / 2 + 5,
              size: 9,
              color: measureColor,
            });
          } else {
            const x = Math.min(start.x, end.x);
            const y = Math.min(start.y, end.y);
            const w = Math.max(1, Math.abs(end.x - start.x));
            const h = Math.max(1, Math.abs(end.y - start.y));
            page.drawRectangle({
              x,
              y,
              width: w,
              height: h,
              borderColor: measureColor,
              borderWidth: Math.max(1, annotation.strokeWidth),
              borderDashArray: [4, 3],
              color: rgb(1, 1, 1),
              opacity: 0,
            });
            page.drawText(annotation.label, {
              x: x + w / 2 - 20,
              y: y + h / 2,
              size: 9,
              color: measureColor,
            });
          }
          continue;
        }

        if (annotation.type === "stamp") {
          const center = toPdfPoint(annotation.position, width, height);
          const stampWidth = annotation.width * width;
          const stampHeight = annotation.height * height;
          const x = center.x - stampWidth / 2;
          const y = center.y - stampHeight / 2;
          if (annotation.stampKind === "image" && annotation.imageDataUrl) {
            const cached = imageCache.get(annotation.imageDataUrl);
            const embedded = cached
              ?? (annotation.imageDataUrl.includes("image/png")
                ? await output.embedPng(dataUrlToBytes(annotation.imageDataUrl))
                : annotation.imageDataUrl.includes("image/jpeg") || annotation.imageDataUrl.includes("image/jpg")
                  ? await output.embedJpg(dataUrlToBytes(annotation.imageDataUrl))
                  : await output.embedPng(await dataUrlToPngBytes(annotation.imageDataUrl)));
            imageCache.set(annotation.imageDataUrl, embedded);
            page.drawImage(embedded, {
              x,
              y,
              width: stampWidth,
              height: stampHeight,
              opacity: annotation.opacity,
            });
          } else {
            page.drawRectangle({
              x,
              y,
              width: stampWidth,
              height: stampHeight,
              borderColor: color,
              borderWidth: annotation.strokeWidth,
              color: rgb(1, 1, 1),
              opacity: 0.65 * annotation.opacity,
            });
            page.drawText(annotation.label ?? "STAMP", {
              x: x + 6,
              y: y + stampHeight / 2 - 4,
              size: Math.max(9, stampHeight * 0.28),
              color,
              opacity: annotation.opacity,
            });
          }
          continue;
        }

        if (annotation.type === "pin") {
          const center = toPdfPoint(annotation.position, width, height);
          const pinNumber = pinNumberById.get(annotation.id) ?? 0;
          const pinColor = toPdfColor(PIN_STATUS_COLOR[annotation.status] ?? annotation.color);
          page.drawCircle({
            x: center.x,
            y: center.y + 9,
            size: 9,
            borderColor: rgb(0.08, 0.08, 0.08),
            borderWidth: 1.2,
            color: pinColor,
          });
          page.drawSvgPath("M0,0 L6,0 L3,-9 Z", {
            x: center.x - 3,
            y: center.y + 2,
            borderColor: rgb(0.08, 0.08, 0.08),
            borderWidth: 1.2,
            color: pinColor,
          });
          page.drawText(String(pinNumber), {
            x: center.x - 3,
            y: center.y + 7,
            size: 7,
            color: rgb(1, 1, 1),
          });
        }
      }
    }

    const flattenedBytes = await output.save();
    return new Uint8Array(flattenedBytes);
  }

  async function savePdfToHandle(handle: any): Promise<void> {
    const bytes = await buildFlattenedPdfBytes();
    if (!bytes) return;
    const writable = await handle.createWritable();
    await writable.write(new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }));
    await writable.close();
  }

  async function savePdf(): Promise<void> {
    try {
      if (!pdfDoc) {
        notify("Open a PDF before saving.");
        return;
      }
      if (pdfFileHandle) {
        await savePdfToHandle(pdfFileHandle);
        notify("Saved PDF successfully.");
        return;
      }
      await savePdfAs();
    } catch (error) {
      const message = getErrorMessage(error);
      notify(`Save failed: ${message}`);
      console.error("Save failed", error);
      window.alert(`Save failed:\n${message}`);
    }
  }

  async function savePdfAs(): Promise<void> {
    try {
      const bytes = await buildFlattenedPdfBytes();
      if (!bytes) {
        notify("Open a PDF before Save As.");
        return;
      }
      if (typeof (window as any).showSaveFilePicker === "function") {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: `${pdfName.replace(/\.pdf$/i, "")}-annotated.pdf`,
          types: [
            {
              description: "PDF file",
              accept: { "application/pdf": [".pdf"] },
            },
          ],
        });
        if (!handle) return;
        await savePdfToHandle(handle);
        setPdfFileHandle(handle);
        notify("Save As completed.");
        return;
      }
      downloadBlob(
        new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }),
        `${pdfName.replace(/\.pdf$/i, "")}-annotated.pdf`,
      );
      notify("Save As download started.");
    } catch (error) {
      const message = getErrorMessage(error);
      notify(`Save As failed: ${message}`);
      console.error("Save As failed", error);
      window.alert(`Save As failed:\n${message}`);
    }
  }

  async function exportFlattenedPdf(): Promise<void> {
    try {
      const bytes = await buildFlattenedPdfBytes();
      if (!bytes) {
        notify("Open a PDF before export.");
        return;
      }
      downloadBlob(
        new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }),
        `${pdfName.replace(/\.pdf$/i, "")}-flattened.pdf`,
      );
      notify("Exported flattened PDF.");
    } catch (error) {
      const message = getErrorMessage(error);
      notify(`Export failed: ${message}`);
      console.error("Export failed", error);
      window.alert(`Export failed:\n${message}`);
    }
  }

  function onPointerMove(page: number, event: React.PointerEvent<SVGSVGElement>): void {
    const size = pageSizes[page];
    if (!size) return;
    const point = getEventPoint(event, page);
    if (!point) return;

    if (interaction && interaction.page === page) {
      const startNorm = normalizePoint(interaction.startPoint, size.width, size.height);
      const currentNorm = normalizePoint(point, size.width, size.height);
      const dx = currentNorm.x - startNorm.x;
      const dy = currentNorm.y - startNorm.y;

      setAnnotations((prev) =>
        prev.map((annotation) => {
          if (annotation.id !== interaction.annotationId) return annotation;
          const initial = interaction.initialAnnotation;
          if (interaction.mode === "move") {
            if (annotation.type === "line" || annotation.type === "arrow") {
              if (initial.type !== "line" && initial.type !== "arrow") return annotation;
              return {
                ...annotation,
                start: movePoint(initial.start, dx, dy),
                end: movePoint(initial.end, dx, dy),
              };
            }
            if (annotation.type === "rect" || annotation.type === "cloud") {
              if (initial.type !== "rect" && initial.type !== "cloud") return annotation;
              return {
                ...annotation,
                start: movePoint(initial.start, dx, dy),
                end: movePoint(initial.end, dx, dy),
              };
            }
            if (annotation.type === "highlighter") {
              if (initial.type !== "highlighter") return annotation;
              return {
                ...annotation,
                points: initial.points.map((p) => movePoint(p, dx, dy)),
              };
            }
            if (annotation.type === "stamp") {
              if (initial.type !== "stamp") return annotation;
              return {
                ...annotation,
                position: movePoint(initial.position, dx, dy),
              };
            }
            if (annotation.type === "pin") {
              if (initial.type !== "pin") return annotation;
              return {
                ...annotation,
                position: movePoint(initial.position, dx, dy),
              };
            }
            if (annotation.type === "measure") {
              if (initial.type !== "measure") return annotation;
              return {
                ...annotation,
                start: movePoint(initial.start, dx, dy),
                end: movePoint(initial.end, dx, dy),
              };
            }
          }
          if (interaction.mode === "resize" && interaction.handle) {
            return resizeAnnotation(annotation, currentNorm, interaction.handle);
          }
          return annotation;
        }),
      );
      return;
    }

    if (!drawingState || drawingState.page !== page) return;
    setDrawingState((prev) => {
      if (!prev || prev.page !== page) return prev;
      if (tool === "highlighter") {
        return { ...prev, current: point, points: [...prev.points, point] };
      }
      return { ...prev, current: point };
    });
  }

  function onOverlayPointerUp(page: number): void {
    if (interaction && interaction.page === page) {
      setInteraction(null);
      return;
    }
    onPointerUp(page);
  }

  function renderAnnotation(annotation: Annotation, page: number): ReactElement | null {
    const size = pageSizes[page];
    if (!size) return null;

    const selected = selectedId === annotation.id;
    const dash = lineStyleToDash(annotation.lineStyle ?? "solid", annotation.strokeWidth);
    const commonProps = {
      onClick: (event: React.MouseEvent<SVGElement>) => {
        event.stopPropagation();
        if (tool === "select") {
          setSelectedId(annotation.id);
        }
      },
      onPointerDown: (event: React.PointerEvent<SVGElement>) => {
        beginInteraction(event, annotation, page, "move");
      },
      style: { cursor: tool === "select" ? "pointer" : "crosshair" },
      stroke: annotation.color,
      strokeDasharray: dash,
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
          strokeDasharray={dash}
          strokeWidth={annotation.strokeWidth}
          opacity={annotation.opacity}
          strokeLinecap="round"
          strokeLinejoin="round"
          onClick={commonProps.onClick}
          style={commonProps.style}
        />
      );
    }

    if (annotation.type === "measure") {
      const start = denormalizePoint(annotation.start, size.width, size.height);
      const end = denormalizePoint(annotation.end, size.width, size.height);
      if (annotation.measureKind === "distance") {
        const midX = (start.x + end.x) / 2;
        const midY = (start.y + end.y) / 2;
        return (
          <g key={annotation.id}>
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="#a3e635"
              strokeDasharray="6 4"
              strokeWidth={selected ? annotation.strokeWidth + 1 : annotation.strokeWidth}
              onClick={commonProps.onClick}
              onPointerDown={commonProps.onPointerDown}
              style={commonProps.style}
            />
            <text
              x={midX}
              y={midY - 6}
              textAnchor="middle"
              fontSize={12}
              fontWeight={700}
              fill="#a3e635"
              onClick={commonProps.onClick}
              style={commonProps.style}
            >
              {annotation.label}
            </text>
          </g>
        );
      }
      const rect = rectFromPoints(start, end);
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      return (
        <g key={annotation.id}>
          <rect
            x={rect.x}
            y={rect.y}
            width={Math.max(2, rect.w)}
            height={Math.max(2, rect.h)}
            fill="rgba(163,230,53,0.05)"
            stroke="#a3e635"
            strokeDasharray="6 4"
            strokeWidth={selected ? annotation.strokeWidth + 1 : annotation.strokeWidth}
            onClick={commonProps.onClick}
            onPointerDown={commonProps.onPointerDown}
            style={commonProps.style}
          />
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={12}
            fontWeight={700}
            fill="#a3e635"
            onClick={commonProps.onClick}
            style={commonProps.style}
          >
            {annotation.label}
          </text>
        </g>
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
            strokeDasharray={dash}
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

    if (annotation.type === "pin") {
      const position = denormalizePoint(annotation.position, size.width, size.height);
      const pinNumber = pinNumberById.get(annotation.id) ?? 0;
      const pinColor = PIN_STATUS_COLOR[annotation.status] ?? annotation.color;
      return (
        <g key={annotation.id} onClick={commonProps.onClick} onPointerDown={commonProps.onPointerDown} style={commonProps.style}>
          <circle
            cx={position.x}
            cy={position.y - 11}
            r={11}
            fill={pinColor}
            stroke={selected ? "#ffffff" : "#111827"}
            strokeWidth={selected ? 2.5 : 1.5}
          />
          <polygon
            points={`${position.x - 6},${position.y - 3} ${position.x + 6},${position.y - 3} ${position.x},${position.y + 10}`}
            fill={pinColor}
            stroke={selected ? "#ffffff" : "#111827"}
            strokeWidth={selected ? 2.5 : 1.5}
          />
          <text
            x={position.x}
            y={position.y - 11}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={10}
            fontWeight={700}
            fill="#ffffff"
          >
            {pinNumber}
          </text>
        </g>
      );
    }

    return null;
  }

  function renderSelectionHandles(annotation: Annotation, page: number): ReactElement | null {
    if (tool !== "select" || selectedId !== annotation.id) return null;
    const size = pageSizes[page];
    if (!size) return null;

    const handles: Array<{ key: string; point: Point }> = [];
    if (
      annotation.type === "line" ||
      annotation.type === "arrow" ||
      (annotation.type === "measure" && annotation.measureKind === "distance")
    ) {
      handles.push({
        key: "start",
        point: denormalizePoint(annotation.start, size.width, size.height),
      });
      handles.push({
        key: "end",
        point: denormalizePoint(annotation.end, size.width, size.height),
      });
    } else if (
      annotation.type === "rect" ||
      annotation.type === "cloud" ||
      (annotation.type === "measure" && annotation.measureKind === "area")
    ) {
      const start = denormalizePoint(annotation.start, size.width, size.height);
      const end = denormalizePoint(annotation.end, size.width, size.height);
      const rect = rectFromPoints(start, end);
      handles.push({ key: "nw", point: { x: rect.x, y: rect.y } });
      handles.push({ key: "ne", point: { x: rect.x + rect.w, y: rect.y } });
      handles.push({ key: "sw", point: { x: rect.x, y: rect.y + rect.h } });
      handles.push({ key: "se", point: { x: rect.x + rect.w, y: rect.y + rect.h } });
    } else if (annotation.type === "stamp") {
      const center = denormalizePoint(annotation.position, size.width, size.height);
      const halfW = (annotation.width * size.width) / 2;
      const halfH = (annotation.height * size.height) / 2;
      handles.push({ key: "nw", point: { x: center.x - halfW, y: center.y - halfH } });
      handles.push({ key: "ne", point: { x: center.x + halfW, y: center.y - halfH } });
      handles.push({ key: "sw", point: { x: center.x - halfW, y: center.y + halfH } });
      handles.push({ key: "se", point: { x: center.x + halfW, y: center.y + halfH } });
    } else {
      return null;
    }

    return (
      <g>
        {handles.map((handle) => (
          <rect
            key={`${annotation.id}-${handle.key}`}
            x={handle.point.x - 4}
            y={handle.point.y - 4}
            width={8}
            height={8}
            fill="#ffffff"
            stroke="#111827"
            strokeWidth={1}
            style={{ cursor: "nwse-resize" }}
            onPointerDown={(event) => beginInteraction(event, annotation, page, "resize", handle.key)}
          />
        ))}
      </g>
    );
  }

  function renderActiveShape(page: number): ReactElement | null {
    if (!drawingState || drawingState.page !== page) return null;
    const start = drawingState.start;
    const current = drawingState.current;

    if (tool === "line" || tool === "arrow" || tool === "calibrate" || tool === "measure-distance") {
      return (
        <line
          x1={start.x}
          y1={start.y}
          x2={current.x}
          y2={current.y}
          stroke={tool === "calibrate" ? "#22d3ee" : tool === "measure-distance" ? "#a3e635" : strokeColor}
          strokeDasharray={
            tool === "calibrate" || tool === "measure-distance" ? "6 4" : lineStyleToDash(lineStyle, strokeWidth)
          }
          strokeWidth={strokeWidth}
          markerEnd={tool === "arrow" ? `url(#arrow-${page})` : undefined}
          pointerEvents="none"
        />
      );
    }

    if (tool === "rect" || tool === "measure-area") {
      const rect = rectFromPoints(start, current);
      return (
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          fill="transparent"
          stroke={tool === "measure-area" ? "#a3e635" : strokeColor}
          strokeDasharray={tool === "measure-area" ? "6 4" : lineStyleToDash(lineStyle, strokeWidth)}
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
          stroke={highlighterColor}
          strokeDasharray={lineStyleToDash(lineStyle, highlighterWidth)}
          strokeWidth={highlighterWidth}
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
        {actionNotice ? <div className="actionNotice">{actionNotice}</div> : null}
        {batchDocuments.length > 1 ? (
          <div className="batchBar">
            <strong>Batch:</strong>
            {batchDocuments.map((document, index) => (
              <button
                key={document.id}
                type="button"
                className={document.id === activeBatchId ? "active" : ""}
                onClick={() => void switchBatchDocument(document.id)}
              >
                {index + 1}. {document.name}
              </button>
            ))}
          </div>
        ) : null}

        <div className="group">
          <button type="button" onClick={() => void triggerOpenDialog()}>
            Open
          </button>
          <label className="uploadLabel">
            Open Batch
            <input
              ref={openBatchInputRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={(event) => {
                void handleOpenBatch(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <input
            ref={openInputRef}
            type="file"
            accept=".pdf,.json,.pdfmaker.json,application/pdf,application/json"
            className="hiddenInput"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              void handleOpenFile(file);
              setPdfFileHandle(null);
              event.currentTarget.value = "";
            }}
          />
          <button type="button" onClick={() => void savePdf()} disabled={!pdfDoc}>
            Save
          </button>
          <button type="button" onClick={() => void savePdfAs()} disabled={!pdfDoc}>
            Save As
          </button>
          <label className="uploadLabel">
            Open Markups
            <input
              ref={loadMarkupInputRef}
              type="file"
              accept="application/json"
              onChange={(event) => {
                void loadMarkupJson(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label className="uploadLabel">
            Import PDF
            <input
              type="file"
              accept="application/pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handlePdfFile(file);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button type="button" onClick={saveMarkupJson} disabled={annotations.length === 0}>
            Save Markups
          </button>
          <button
            type="button"
            onClick={exportPinsJson}
            disabled={!annotations.some((annotation) => annotation.type === "pin")}
          >
            Export Pins JSON
          </button>
          <button
            type="button"
            onClick={exportPinsCsv}
            disabled={!annotations.some((annotation) => annotation.type === "pin")}
          >
            Export Pins CSV
          </button>
          <button type="button" onClick={() => void exportAnnotatedPngs()} disabled={!pdfDoc}>
            Export PNG
          </button>
          <button type="button" onClick={() => void exportFlattenedPdf()} disabled={!pdfDoc}>
            Export Flattened PDF
          </button>
        </div>

        <div className="group">
          {([
            "select",
            "line",
            "arrow",
            "rect",
            "cloud",
            "highlighter",
            "stamp",
            "pin",
            "calibrate",
            "measure-distance",
            "measure-area",
          ] as Tool[]).map((name) => (
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
            Line color
            <input type="color" value={strokeColor} onChange={(event) => setStrokeColor(event.target.value)} />
          </label>
          <label>
            Highlighter
            <input
              type="color"
              value={highlighterColor}
              onChange={(event) => setHighlighterColor(event.target.value)}
            />
          </label>
          <label>
            Line width
            <input
              type="range"
              min={1}
              max={12}
              value={strokeWidth}
              onChange={(event) => setStrokeWidth(Number(event.target.value))}
            />
          </label>
          <label>
            HL width
            <input
              type="range"
              min={2}
              max={24}
              value={highlighterWidth}
              onChange={(event) => setHighlighterWidth(Number(event.target.value))}
            />
          </label>
          <label>
            Line type
            <select value={lineStyle} onChange={(event) => setLineStyle(event.target.value as LineStyle)}>
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
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
          <button type="button" onClick={zoomOut}>
            Zoom -
          </button>
          <button type="button" onClick={zoomIn}>
            Zoom +
          </button>
          <button type="button" onClick={zoomReset}>
            Zoom 100%
          </button>
          <button
            type="button"
            onClick={() => {
              if (!activeCalibration) return;
              setCalibrationByPage((prev) => {
                const next = { ...prev };
                delete next[activePageForTools];
                return next;
              });
              notify(`Cleared calibration for page ${activePageForTools}.`);
            }}
            disabled={!activeCalibration}
          >
            Clear Calib
          </button>
          <span>{activeCalibration ? `Calib p${activePageForTools}: ${activeCalibration.toFixed(1)} mm/unit` : "Not calibrated"}</span>
          <button type="button" onClick={() => rotateSheet("ccw")} disabled={!pdfDoc}>
            Rotate Sheet Left
          </button>
          <button type="button" onClick={() => rotateSheet("cw")} disabled={!pdfDoc}>
            Rotate Sheet Right
          </button>
          <button type="button" onClick={() => rotateSelectedDrawing("ccw")} disabled={!lastRotatableAnnotation}>
            Rotate Left
          </button>
          <button type="button" onClick={() => rotateSelectedDrawing("cw")} disabled={!lastRotatableAnnotation}>
            Rotate Right
          </button>
        </div>

        <div className="group">
          <label>
            Standard stamp
            <select
              value={activeStampPresetId}
              onChange={(event) => {
                const selected = STAMP_PRESETS.find((preset) => preset.id === event.target.value);
                setActiveStampPresetId(event.target.value);
                if (selected) {
                  setStampLabel(selected.label);
                  setStrokeColor(selected.color);
                }
              }}
            >
              {STAMP_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stamp text
            <input type="text" value={stampLabel} onChange={(event) => setStampLabel(event.target.value)} />
          </label>
          <label className="uploadLabel">
            Add custom stamp
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result !== "string") return;
                  const trimmedName = file.name.replace(/\.[^.]+$/, "").trim();
                  const displayName = trimmedName.length > 0 ? trimmedName : `Custom ${customStamps.length + 1}`;
                  addCustomStamp(displayName, reader.result);
                };
                reader.readAsDataURL(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label>
            Custom stamp
            <select value={activeCustomStampId} onChange={(event) => setActiveCustomStampId(event.target.value)}>
              <option value="">Text stamp mode</option>
              {customStamps.map((stamp) => (
                <option key={stamp.id} value={stamp.id}>
                  {stamp.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={deleteActiveCustomStamp} disabled={!activeCustomStampId}>
            Delete custom
          </button>
          <button type="button" onClick={() => setActiveCustomStampId("")}>
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

        {selectedAnnotation ? (
          <div className="group">
            <strong>Selected</strong>
            {selectedAnnotation.type !== "pin" ? (
              <>
                <label>
                  Color
                  <input
                    type="color"
                    value={selectedAnnotation.color}
                    onChange={(event) =>
                      updateSelectedAnnotation((annotation) => ({ ...annotation, color: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Weight
                  <input
                    type="range"
                    min={1}
                    max={24}
                    value={selectedAnnotation.strokeWidth}
                    onChange={(event) =>
                      updateSelectedAnnotation((annotation) => ({
                        ...annotation,
                        strokeWidth: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label>
                  Type
                  <select
                    value={selectedAnnotation.lineStyle ?? "solid"}
                    onChange={(event) =>
                      updateSelectedAnnotation((annotation) => ({
                        ...annotation,
                        lineStyle: event.target.value as LineStyle,
                      }))
                    }
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </select>
                </label>
                {selectedAnnotation.type === "highlighter" ? (
                  <label>
                    Opacity
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={selectedAnnotation.opacity}
                      onChange={(event) =>
                        updateSelectedAnnotation((annotation) =>
                          annotation.type === "highlighter"
                            ? { ...annotation, opacity: Number(event.target.value) }
                            : annotation,
                        )
                      }
                    />
                  </label>
                ) : null}
              </>
            ) : (
              <>
                <span>Pin #{pinNumberById.get(selectedAnnotation.id) ?? "-"}</span>
                <label>
                  Title
                  <input
                    type="text"
                    value={selectedAnnotation.title}
                    onChange={(event) =>
                      updateSelectedAnnotation((annotation) =>
                        annotation.type === "pin" ? { ...annotation, title: event.target.value } : annotation,
                      )
                    }
                  />
                </label>
                <label>
                  Description
                  <input
                    type="text"
                    value={selectedAnnotation.description}
                    onChange={(event) =>
                      updateSelectedAnnotation((annotation) =>
                        annotation.type === "pin"
                          ? { ...annotation, description: event.target.value }
                          : annotation,
                      )
                    }
                  />
                </label>
                <label>
                  Status
                  <select value={selectedAnnotation.status} onChange={(event) => applyPinStatus(event.target.value as PinStatus)}>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="closed">Closed</option>
                  </select>
                </label>
                <label>
                  Scheduled
                  <input
                    type="date"
                    value={selectedAnnotation.scheduledFor}
                    onChange={(event) =>
                      updateSelectedAnnotation((annotation) =>
                        annotation.type === "pin"
                          ? { ...annotation, scheduledFor: event.target.value }
                          : annotation,
                      )
                    }
                  />
                </label>
                <label className="uploadLabel">
                  Pin photo
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        const result = reader.result;
                        if (typeof result !== "string") return;
                        updateSelectedAnnotation((annotation) =>
                          annotation.type === "pin"
                            ? { ...annotation, photoDataUrl: result }
                            : annotation,
                        );
                      };
                      reader.readAsDataURL(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    updateSelectedAnnotation((annotation) =>
                      annotation.type === "pin" ? { ...annotation, photoDataUrl: undefined } : annotation,
                    )
                  }
                >
                  Remove photo
                </button>
                {selectedAnnotation.photoDataUrl ? (
                  <img src={selectedAnnotation.photoDataUrl} alt="Pin attachment" className="pinPhotoPreview" />
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </header>

      <main className="viewer">
        {!pdfDoc ? (
          <div className="empty">Upload a PDF to start annotating.</div>
        ) : (
          <div className="workspaceLayout">
            <aside className="thumbRail">
              {pages.map((page) => (
                <button
                  key={`thumb-${page}`}
                  type="button"
                  className="thumbButton"
                  onClick={() => {
                    setActivePage(page);
                    pageRefs.current[page]?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  <span>Page {page}</span>
                  {thumbnails[page] ? <img src={thumbnails[page]} alt={`Page ${page} thumbnail`} /> : null}
                </button>
              ))}
            </aside>
            <section
              ref={pagesScrollRef}
              className={`pagesColumn ${isMiddlePanning ? "isPanning" : ""}`}
              onWheelCapture={onViewportWheel}
              onMouseDown={onViewportMouseDown}
              onMouseMove={onViewportMouseMove}
              onMouseUp={endViewportPan}
              onMouseLeave={endViewportPan}
              onTouchStart={onViewportTouchStart}
              onTouchMove={onViewportTouchMove}
              onTouchEnd={onViewportTouchEnd}
              onTouchCancel={onViewportTouchEnd}
            >
              {pages.map((page) => {
                const size = pageSizes[page];
                return (
                  <section
                    key={page}
                    ref={(el) => {
                      pageRefs.current[page] = el;
                    }}
                    className="pageSection"
                    onMouseEnter={() => setActivePage(page)}
                  >
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
                          onPointerUp={() => onOverlayPointerUp(page)}
                          onPointerLeave={() => onOverlayPointerUp(page)}
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
                            .map((annotation) => (
                              <g key={annotation.id}>
                                {renderAnnotation(annotation, page)}
                                {renderSelectionHandles(annotation, page)}
                              </g>
                            ))}
                          {renderActiveShape(page)}
                        </svg>
                      ) : null}
                    </div>
                  </section>
                );
              })}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
