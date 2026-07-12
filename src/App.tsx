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
import { hasSupabaseConfig, supabase } from "./lib/supabase";
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
type AppModule = "markup-studio" | "operations";
type Worker = { id: string; name: string; role: string };
type TimeEntry = {
  id: string;
  workerId: string;
  action: "clock_in" | "clock_out";
  at: string;
  note?: string;
};
type Project = {
  id: string;
  slug: string;
  name: string;
  code: string;
  status: "active" | "on_hold" | "completed" | "archived";
  address: string;
};
type FolderNode = { id: string; name: string; parentId: string | null };
type ProjectFile = {
  id: string;
  projectId: string | null;
  folderId: string | null;
  name: string;
  updatedAt: string;
  status: string;
  mimeType?: string;
  dataUrl?: string;
  uploadedBy?: string;
  version?: number;
};
type FormTemplate = { id: string; name: string; version: string; updatedAt: string };
type GpsSnapshot = {
  lat: number;
  lng: number;
  accuracyM: number;
  capturedAt: string;
  source: "device" | "entry";
};
type OpsRoute =
  | { name: "sign-in" }
  | { name: "sign-out" }
  | { name: "timesheets"; date?: string }
  | { name: "projects"; projectId?: string; section?: "files" }
  | { name: "forms"; formId?: string; submissionId?: string; mode?: "fill" | "view" | "export" };
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
const OPS_STORAGE_KEY = "mep-ops.local.v1";
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
const FORM_TEMPLATES: FormTemplate[] = [
  { id: "site-inspection", name: "Site Inspection", version: "v1.3", updatedAt: "09/07/2025" },
  { id: "daily-report", name: "Daily Site Report", version: "v2.1", updatedAt: "08/06/2025" },
  { id: "rams", name: "RAMS", version: "v1.0", updatedAt: "15/06/2025" },
  { id: "materials-delivery", name: "Materials Delivery", version: "v1.2", updatedAt: "10/06/2025" },
  { id: "handover-checklist", name: "Handover Checklist", version: "v1.1", updatedAt: "05/06/2025" },
];
const DEFAULT_PROJECTS: Project[] = [
  {
    id: "proj-1",
    slug: "new-street-square",
    name: "New Street Square",
    code: "NSS",
    status: "active",
    address: "London EC4A 3BZ",
  },
  {
    id: "proj-2",
    slug: "one-crown-place",
    name: "One Crown Place",
    code: "OCP",
    status: "active",
    address: "London EC2A 4AQ",
  },
];

function makeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatMinutes(totalMinutes: number): string {
  const safeMinutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function parseGpsNote(note?: string): { lat: number; lng: number; accuracyM: number } | null {
  if (!note || !note.startsWith("gps:")) return null;
  const payload = note.slice(4);
  const [latRaw, lngRaw, accuracyRaw] = payload.split("|");
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  const accuracyM = Number(accuracyRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracyM)) return null;
  return { lat, lng, accuracyM };
}

function isOpsPath(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname === "/sign-out" ||
    pathname === "/timesheets" ||
    /^\/timesheets\/[^/]+$/.test(pathname) ||
    pathname === "/projects" ||
    /^\/projects\/[^/]+$/.test(pathname) ||
    /^\/projects\/[^/]+\/files$/.test(pathname) ||
    pathname === "/forms" ||
    /^\/forms\/[^/]+\/fill$/.test(pathname) ||
    /^\/forms\/submissions\/[^/]+$/.test(pathname) ||
    /^\/forms\/submissions\/[^/]+\/export$/.test(pathname)
  );
}

function parseOpsRoute(pathname: string): OpsRoute {
  if (pathname === "/sign-out") return { name: "sign-out" };
  if (pathname === "/timesheets") return { name: "timesheets" };
  if (pathname.startsWith("/timesheets/")) return { name: "timesheets", date: pathname.split("/")[2] };
  if (pathname === "/projects") return { name: "projects" };
  if (/^\/projects\/[^/]+\/files$/.test(pathname)) {
    const parts = pathname.split("/");
    return { name: "projects", projectId: parts[2], section: "files" };
  }
  if (/^\/projects\/[^/]+$/.test(pathname)) return { name: "projects", projectId: pathname.split("/")[2] };
  if (pathname === "/forms") return { name: "forms" };
  if (/^\/forms\/[^/]+\/fill$/.test(pathname)) return { name: "forms", formId: pathname.split("/")[2], mode: "fill" };
  if (/^\/forms\/submissions\/[^/]+\/export$/.test(pathname)) {
    return { name: "forms", submissionId: pathname.split("/")[3], mode: "export" };
  }
  if (/^\/forms\/submissions\/[^/]+$/.test(pathname)) {
    return { name: "forms", submissionId: pathname.split("/")[3], mode: "view" };
  }
  return { name: "sign-in" };
}

function toMapEmbedUrl(gps: GpsSnapshot | null): string {
  if (!gps) {
    return "https://www.openstreetmap.org/export/embed.html?bbox=-0.17%2C51.49%2C-0.08%2C51.53&layer=mapnik";
  }
  const delta = 0.008;
  const minLng = gps.lng - delta;
  const maxLng = gps.lng + delta;
  const minLat = gps.lat - delta;
  const maxLat = gps.lat + delta;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${minLng}%2C${minLat}%2C${maxLng}%2C${maxLat}&layer=mapnik&marker=${gps.lat}%2C${gps.lng}`;
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
  const [activeModule, setActiveModule] = useState<AppModule>("markup-studio");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>(DEFAULT_PROJECTS);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(DEFAULT_PROJECTS[0]?.id ?? "");
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [newWorkerName, setNewWorkerName] = useState<string>("");
  const [newWorkerRole, setNewWorkerRole] = useState<string>("Technician");
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [newFileName, setNewFileName] = useState<string>("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [opsLoading, setOpsLoading] = useState<boolean>(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>("");
  const [opsProjectName, setOpsProjectName] = useState<string>("New Street Square");
  const [opsLocationName, setOpsLocationName] = useState<string>("London EC4A 3BZ");
  const [fileSearch, setFileSearch] = useState<string>("");
  const [activeFormId, setActiveFormId] = useState<string | null>(null);
  const [completedFormIds, setCompletedFormIds] = useState<string[]>([]);
  const [opsPathname, setOpsPathname] = useState<string>(() => window.location.pathname || "/sign-in");
  const [opsTimesheetWindow, setOpsTimesheetWindow] = useState<"day" | "week">("day");
  const [activeFormStep, setActiveFormStep] = useState<number>(1);
  const [liveGps, setLiveGps] = useState<GpsSnapshot | null>(null);
  const [selectedProjectFileId, setSelectedProjectFileId] = useState<string | null>(null);

  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const svgRefs = useRef<Record<number, SVGSVGElement | null>>({});
  const pageRefs = useRef<Record<number, HTMLElement | null>>({});
  const pagesScrollRef = useRef<HTMLElement | null>(null);
  const zoomAnchorRef = useRef<{ mouseX: number; mouseY: number; contentX: number; contentY: number } | null>(null);
  const openInputRef = useRef<HTMLInputElement | null>(null);
  const loadMarkupInputRef = useRef<HTMLInputElement | null>(null);
  const openBatchInputRef = useRef<HTMLInputElement | null>(null);
  const projectUploadInputRef = useRef<HTMLInputElement | null>(null);
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
  const activePageForTools = activePage;
  const activeCalibration = calibrationByPage[activePageForTools];
  const workerById = useMemo(
    () => Object.fromEntries(workers.map((worker) => [worker.id, worker])),
    [workers],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const latestEntryByWorker = useMemo(() => {
    const map: Record<string, TimeEntry> = {};
    for (const entry of timeEntries) {
      const current = map[entry.workerId];
      if (!current || new Date(entry.at).getTime() > new Date(current.at).getTime()) {
        map[entry.workerId] = entry;
      }
    }
    return map;
  }, [timeEntries]);
  const visibleFiles = useMemo(
    () =>
      projectFiles.filter((file) => {
        const matchesProject = !file.projectId || file.projectId === selectedProjectId;
        if (!matchesProject) return false;
        if (file.folderId !== selectedFolderId) return false;
        if (!fileSearch.trim()) return true;
        return file.name.toLowerCase().includes(fileSearch.trim().toLowerCase());
      }),
    [projectFiles, selectedFolderId, fileSearch, selectedProjectId],
  );
  const selectedProjectFile = useMemo(
    () => projectFiles.find((file) => file.id === selectedProjectFileId) ?? null,
    [projectFiles, selectedProjectFileId],
  );
  const opsRoute = useMemo(() => parseOpsRoute(opsPathname), [opsPathname]);
  const timeSummary = useMemo(() => {
    const sorted = [...timeEntries].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const openByWorker: Record<string, number | null> = {};
    const workerMinutes: Record<string, number> = {};
    const dayMinutes: Record<string, number> = {};
    for (const entry of sorted) {
      const timestamp = new Date(entry.at).getTime();
      if (Number.isNaN(timestamp)) continue;
      if (entry.action === "clock_in") {
        openByWorker[entry.workerId] = timestamp;
        continue;
      }
      const start = openByWorker[entry.workerId];
      if (start == null) continue;
      const minutes = Math.max(0, Math.round((timestamp - start) / 60000));
      workerMinutes[entry.workerId] = (workerMinutes[entry.workerId] ?? 0) + minutes;
      const dayKey = new Date(timestamp).toISOString().slice(0, 10);
      dayMinutes[dayKey] = (dayMinutes[dayKey] ?? 0) + minutes;
      openByWorker[entry.workerId] = null;
    }
    const workerBreakdown = Object.entries(workerMinutes)
      .sort((a, b) => b[1] - a[1])
      .map(([workerId, minutes]) => ({
        workerId,
        workerName: workerById[workerId]?.name ?? "Unknown worker",
        minutes,
      }));
    const recentDayBreakdown = Object.entries(dayMinutes)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 6)
      .map(([day, minutes]) => ({ day, minutes }));
    return {
      totalMinutes: Object.values(workerMinutes).reduce((sum, minutes) => sum + minutes, 0),
      workerBreakdown,
      recentDayBreakdown,
    };
  }, [timeEntries, workerById]);
  useEffect(() => {
    if (workers.length === 0) {
      setSelectedWorkerId("");
      return;
    }
    const stillExists = workers.some((worker) => worker.id === selectedWorkerId);
    if (!stillExists) {
      setSelectedWorkerId(workers[0].id);
    }
  }, [workers, selectedWorkerId]);

  useEffect(() => {
    if (projects.length === 0) return;
    const exists = projects.some((project) => project.id === selectedProjectId);
    if (!exists) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  useEffect(() => {
    if (!selectedProject) return;
    setOpsProjectName(selectedProject.name);
    setOpsLocationName(selectedProject.address);
  }, [selectedProject]);

  useEffect(() => {
    if (opsRoute.name !== "projects" || !opsRoute.projectId) return;
    const found = projects.find((project) => project.slug === opsRoute.projectId);
    if (found && found.id !== selectedProjectId) {
      setSelectedProjectId(found.id);
    }
  }, [opsRoute, projects, selectedProjectId]);

  useEffect(() => {
    function handlePopState(): void {
      setOpsPathname(window.location.pathname || "/sign-in");
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (isOpsPath(opsPathname)) {
      setActiveModule("operations");
    }
  }, [opsPathname]);

  useEffect(() => {
    if (activeModule !== "operations") return;
    if (opsRoute.name !== "sign-in" && opsRoute.name !== "sign-out") return;
    void refreshLiveGps();
  }, [activeModule, opsRoute.name]);

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
    async function loadOpsData(): Promise<void> {
      if (hasSupabaseConfig && supabase) {
        setOpsLoading(true);
        try {
          const [workersRes, entriesRes, foldersRes, filesRes] = await Promise.all([
            supabase.from("workers").select("id,name,role").order("created_at", { ascending: false }),
            supabase.from("time_entries").select("id,worker_id,action,at,note").order("at", { ascending: false }),
            supabase.from("folders").select("id,name,parent_id").order("created_at", { ascending: false }),
            supabase
              .from("project_files")
              .select("id,folder_id,name,status,updated_at")
              .order("updated_at", { ascending: false }),
          ]);
          if (workersRes.error) throw workersRes.error;
          if (entriesRes.error) throw entriesRes.error;
          if (foldersRes.error) throw foldersRes.error;
          if (filesRes.error) throw filesRes.error;
          const loadedWorkers = (workersRes.data ?? []).map((row) => ({
            id: row.id,
            name: row.name,
            role: row.role,
          }));
          const loadedEntries = (entriesRes.data ?? []).map((row) => ({
            id: row.id,
            workerId: row.worker_id,
            action: row.action as TimeEntry["action"],
            at: row.at,
            note: row.note ?? undefined,
          }));
          const loadedFolders = (foldersRes.data ?? []).map((row) => ({
            id: row.id,
            name: row.name,
            parentId: row.parent_id,
          }));
          const loadedFiles = (filesRes.data ?? []).map((row) => ({
            id: row.id,
            projectId: selectedProjectId || null,
            folderId: row.folder_id,
            name: row.name,
            status: row.status,
            updatedAt: row.updated_at,
            uploadedBy: "Current User",
            version: 1,
          }));
          setWorkers(loadedWorkers);
          setTimeEntries(loadedEntries);
          setFolders(loadedFolders);
          setProjectFiles(loadedFiles);
          setSelectedFolderId(loadedFolders[0]?.id ?? null);
        } catch (error) {
          notify(`Supabase load failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setOpsLoading(false);
        }
        return;
      }

      try {
        const raw = window.localStorage.getItem(OPS_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as {
          workers?: Worker[];
          timeEntries?: TimeEntry[];
          folders?: FolderNode[];
          projectFiles?: ProjectFile[];
        };
        setWorkers(Array.isArray(parsed.workers) ? parsed.workers : []);
        setTimeEntries(Array.isArray(parsed.timeEntries) ? parsed.timeEntries : []);
        const loadedFolders = Array.isArray(parsed.folders) ? parsed.folders : [];
        setFolders(loadedFolders);
        setProjectFiles(
          Array.isArray(parsed.projectFiles)
            ? parsed.projectFiles.map((file) => ({
                ...file,
                projectId: (file as ProjectFile).projectId ?? selectedProjectId ?? null,
                version: (file as ProjectFile).version ?? 1,
                uploadedBy: (file as ProjectFile).uploadedBy ?? "Current User",
              }))
            : [],
        );
        if (loadedFolders.length > 0) {
          setSelectedFolderId(loadedFolders[0].id);
        }
      } catch {
        // Keep app usable if ops storage was malformed.
      }
    }

    void loadOpsData();
  }, []);

  useEffect(() => {
    if (hasSupabaseConfig && supabase) return;
    window.localStorage.setItem(
      OPS_STORAGE_KEY,
      JSON.stringify({
        workers,
        timeEntries,
        folders,
        projectFiles,
      }),
    );
  }, [workers, timeEntries, folders, projectFiles]);

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
        if (entered === null) {
          notify("Calibration cancelled.");
        } else {
          const normalizedInput = entered.trim().replace(",", ".");
          const knownMm = Number(normalizedInput);
          if (!Number.isFinite(knownMm) || knownMm <= 0) {
            notify("Invalid calibration value. Enter a positive number in mm.");
          } else {
            const mmPerUnit = knownMm / distance;
            setCalibrationByPage((prev) => ({ ...prev, [page]: mmPerUnit }));
            setActivePage(page);
            notify(`Calibrated page ${page}: ${knownMm.toFixed(2)} mm.`);
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

  function canApplyClockAction(workerId: string, action: TimeEntry["action"]): { ok: boolean; reason?: string } {
    const latest = latestEntryByWorker[workerId];
    if (action === "clock_in" && latest?.action === "clock_in") {
      return { ok: false, reason: "Worker is already signed in." };
    }
    if (action === "clock_out" && (!latest || latest.action !== "clock_in")) {
      return { ok: false, reason: "Sign in is required before sign out." };
    }
    return { ok: true };
  }

  async function captureGpsNote(): Promise<string> {
    if (!("geolocation" in navigator)) {
      return "gps:unavailable";
    }
    return await new Promise<string>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          resolve(`gps:${latitude.toFixed(6)}|${longitude.toFixed(6)}|${Math.round(accuracy)}`);
        },
        () => {
          resolve("gps:denied");
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 },
      );
    });
  }

  async function refreshLiveGps(): Promise<void> {
    const note = await captureGpsNote();
    const parsed = parseGpsNote(note);
    if (!parsed) {
      notify("Live GPS unavailable. Check permissions/location settings.");
      return;
    }
    setLiveGps({
      lat: parsed.lat,
      lng: parsed.lng,
      accuracyM: parsed.accuracyM,
      capturedAt: new Date().toISOString(),
      source: "device",
    });
  }

  async function addWorker(): Promise<void> {
    const name = newWorkerName.trim();
    if (!name) {
      notify("Enter worker name.");
      return;
    }
    const role = newWorkerRole.trim() || "Technician";
    if (hasSupabaseConfig && supabase) {
      setOpsLoading(true);
      try {
        const { data, error } = await supabase
          .from("workers")
          .insert({ name, role })
          .select("id,name,role")
          .single();
        if (error) throw error;
        const worker: Worker = {
          id: data.id,
          name: data.name,
          role: data.role,
        };
        setWorkers((prev) => [worker, ...prev]);
        setNewWorkerName("");
        notify(`Added worker ${worker.name}.`);
      } catch (error) {
        notify(`Add worker failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setOpsLoading(false);
      }
      return;
    }
    const worker: Worker = {
      id: makeId(),
      name,
      role,
    };
    setWorkers((prev) => [worker, ...prev]);
    setNewWorkerName("");
    notify(`Added worker ${worker.name}.`);
  }

  async function addTimeEntry(workerId: string, action: "clock_in" | "clock_out"): Promise<void> {
    const worker = workerById[workerId];
    if (!worker) return;
    const actionCheck = canApplyClockAction(workerId, action);
    if (!actionCheck.ok) {
      notify(actionCheck.reason ?? "Invalid clock action.");
      return;
    }
    const gpsNote = await captureGpsNote();
    const gps = parseGpsNote(gpsNote);
    if (gps) {
      setLiveGps({
        lat: gps.lat,
        lng: gps.lng,
        accuracyM: gps.accuracyM,
        capturedAt: new Date().toISOString(),
        source: "entry",
      });
    }

    if (hasSupabaseConfig && supabase) {
      setOpsLoading(true);
      try {
        const { data, error } = await supabase
          .from("time_entries")
          .insert({ worker_id: workerId, action, at: new Date().toISOString(), note: gpsNote })
          .select("id,worker_id,action,at,note")
          .single();
        if (error) throw error;
        const entry: TimeEntry = {
          id: data.id,
          workerId: data.worker_id,
          action: data.action as TimeEntry["action"],
          at: data.at,
          note: data.note ?? undefined,
        };
        setTimeEntries((prev) => [entry, ...prev]);
        notify(
          `${worker.name} ${action === "clock_in" ? "clocked in" : "clocked out"}${
            gps ? ` (GPS ${gps.accuracyM}m)` : ""
          }.`,
        );
      } catch (error) {
        notify(`Clock event failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setOpsLoading(false);
      }
      return;
    }
    setTimeEntries((prev) => [
      {
        id: makeId(),
        workerId,
        action,
        at: new Date().toISOString(),
        note: gpsNote,
      },
      ...prev,
    ]);
    notify(
      `${worker.name} ${action === "clock_in" ? "clocked in" : "clocked out"}${
        gps ? ` (GPS ${gps.accuracyM}m)` : ""
      }.`,
    );
  }

  async function addFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (!name) {
      notify("Enter folder name.");
      return;
    }
    if (hasSupabaseConfig && supabase) {
      setOpsLoading(true);
      try {
        const { data, error } = await supabase
          .from("folders")
          .insert({ name, parent_id: null })
          .select("id,name,parent_id")
          .single();
        if (error) throw error;
        const folder: FolderNode = {
          id: data.id,
          name: data.name,
          parentId: data.parent_id,
        };
        setFolders((prev) => [folder, ...prev]);
        setNewFolderName("");
        if (!selectedFolderId) {
          setSelectedFolderId(folder.id);
        }
      } catch (error) {
        notify(`Add folder failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setOpsLoading(false);
      }
      return;
    }
    const folder: FolderNode = {
      id: makeId(),
      name,
      parentId: null,
    };
    setFolders((prev) => [folder, ...prev]);
    setNewFolderName("");
    if (!selectedFolderId) {
      setSelectedFolderId(folder.id);
    }
  }

  function toProjectSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function addProject(): void {
    const name = newProjectName.trim();
    if (!name) {
      notify("Enter project name.");
      return;
    }
    const slugBase = toProjectSlug(name) || "project";
    let slug = slugBase;
    let idx = 2;
    while (projects.some((project) => project.slug === slug)) {
      slug = `${slugBase}-${idx}`;
      idx += 1;
    }
    const project: Project = {
      id: makeId(),
      slug,
      name,
      code: slug.slice(0, 3).toUpperCase(),
      status: "active",
      address: opsLocationName,
    };
    setProjects((prev) => [project, ...prev]);
    setSelectedProjectId(project.id);
    setNewProjectName("");
    navigateOps(`/projects/${project.slug}`);
    notify(`Created project ${project.name}.`);
  }

  async function fileToDataUrl(file: File): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Could not read file content."));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error("Could not read selected file."));
      reader.readAsDataURL(file);
    });
  }

  async function addProjectFile(
    override?: { name: string; mimeType?: string; dataUrl?: string; uploadedBy?: string },
  ): Promise<void> {
    const name = (override?.name ?? newFileName).trim();
    if (!name) {
      notify("Enter file name.");
      return;
    }
    if (hasSupabaseConfig && supabase) {
      setOpsLoading(true);
      try {
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("project_files")
          .insert({
            folder_id: selectedFolderId,
            name,
            status: "Draft",
            updated_at: now,
          })
          .select("id,folder_id,name,status,updated_at")
          .single();
        if (error) throw error;
        const file: ProjectFile = {
          id: data.id,
          projectId: selectedProjectId,
          folderId: data.folder_id,
          name: data.name,
          status: data.status,
          updatedAt: data.updated_at,
          mimeType: override?.mimeType,
          dataUrl: override?.dataUrl,
          uploadedBy: override?.uploadedBy ?? "Current User",
          version: 1,
        };
        setProjectFiles((prev) => [file, ...prev]);
        setNewFileName("");
        notify(`Added file ${file.name}.`);
      } catch (error) {
        notify(`Add file failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setOpsLoading(false);
      }
      return;
    }
    const file: ProjectFile = {
      id: makeId(),
      projectId: selectedProjectId,
      folderId: selectedFolderId,
      name,
      updatedAt: new Date().toISOString(),
      status: "Draft",
      mimeType: override?.mimeType,
      dataUrl: override?.dataUrl,
      uploadedBy: override?.uploadedBy ?? "Current User",
      version: 1,
    };
    setProjectFiles((prev) => [file, ...prev]);
    setNewFileName("");
    notify(`Added file ${file.name}.`);
  }

  async function handleProjectFileUpload(file: File | null): Promise<void> {
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      await addProjectFile({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        dataUrl,
        uploadedBy: "Current User",
      });
    } catch (error) {
      notify(`Upload failed: ${getErrorMessage(error)}`);
    }
  }

  function deleteProjectFile(fileId: string): void {
    const file = projectFiles.find((item) => item.id === fileId);
    setProjectFiles((prev) => prev.filter((item) => item.id !== fileId));
    if (selectedProjectFileId === fileId) {
      setSelectedProjectFileId(null);
    }
    notify(file ? `Deleted ${file.name}.` : "File deleted.");
  }

  function downloadProjectFile(file: ProjectFile): void {
    if (!file.dataUrl) {
      notify("No file content is available for download yet.");
      return;
    }
    const bytes = dataUrlToBytes(file.dataUrl);
    const blob = new Blob([toArrayBuffer(bytes)], { type: file.mimeType ?? "application/octet-stream" });
    downloadBlob(blob, file.name);
  }

  async function openProjectFileInEditor(file: ProjectFile): Promise<void> {
    if (!(file.mimeType?.includes("pdf") || file.name.toLowerCase().endsWith(".pdf"))) {
      notify("Only PDF drawings can be opened in the PDF editor.");
      return;
    }
    if (!file.dataUrl) {
      notify("No source bytes available for this file.");
      return;
    }
    const bytes = dataUrlToBytes(file.dataUrl);
    const drawingFile = new File([toArrayBuffer(bytes)], file.name, { type: "application/pdf" });
    await handlePdfFile(drawingFile);
    window.history.pushState({}, "", "/");
    setActiveModule("markup-studio");
    notify(`Opened ${file.name} in PDF editor.`);
  }

  function exportTimesheetCsv(scope: "day" | "week"): void {
    const now = new Date();
    const minDate = new Date(now);
    if (scope === "day") {
      minDate.setHours(0, 0, 0, 0);
    } else {
      minDate.setDate(now.getDate() - 7);
    }
    const entries = [...timeEntries]
      .filter((entry) => new Date(entry.at).getTime() >= minDate.getTime())
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const rows = entries.map((entry) => {
      const worker = workerById[entry.workerId]?.name ?? "Unknown worker";
      const gps = parseGpsNote(entry.note);
      return [
        worker,
        entry.action === "clock_in" ? "Sign In" : "Sign Out",
        entry.at,
        gps ? gps.lat.toFixed(6) : "",
        gps ? gps.lng.toFixed(6) : "",
        gps ? String(gps.accuracyM) : "",
      ];
    });
    const header = ["worker", "action", "timestamp", "lat", "lng", "accuracy_m"];
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `timesheet-${scope}.csv`);
    notify(`Timesheet ${scope.toUpperCase()} CSV exported.`);
  }

  function navigateOps(path: string): void {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setOpsPathname(path);
    setActiveModule("operations");
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
            const path = buildCloudPath(0, 0, w, h, Math.max(10, annotation.strokeWidth * 3.2));
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
      const d = buildCloudPath(rect.x, rect.y, Math.max(rect.w, 8), Math.max(rect.h, 8), Math.max(10, annotation.strokeWidth * 3.2));
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
      const d = buildCloudPath(rect.x, rect.y, Math.max(rect.w, 8), Math.max(rect.h, 8), Math.max(10, strokeWidth * 3.2));
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

  function renderOperationsModule(): ReactElement {
    const route = opsRoute;
    const selectedWorker = workers.find((worker) => worker.id === selectedWorkerId) ?? null;
    const availableForms = FORM_TEMPLATES.filter((form) => !completedFormIds.includes(form.id));
    const currentFormId = route.name === "forms" ? route.formId : undefined;
    const activeForm = FORM_TEMPLATES.find((form) => form.id === (currentFormId ?? activeFormId ?? "")) ?? null;
    const signedInWorkers = workers
      .map((worker) => ({
        worker,
        lastEntry: latestEntryByWorker[worker.id],
      }))
      .filter((item) => item.lastEntry?.action === "clock_in");
    const activeNav = route.name === "projects" ? "projects" : route.name === "timesheets" ? "timesheets" : route.name === "forms" ? "forms" : "home";

    const navItems = [
      { key: "home", label: "Home", path: "/sign-in" },
      { key: "projects", label: "Projects", path: "/projects" },
      { key: "timesheets", label: "Timesheets", path: "/timesheets" },
      { key: "forms", label: "Forms", path: "/forms" },
      { key: "more", label: "More", path: "/sign-out" },
    ] as const;

    const selectedProjectSlug = selectedProject?.slug ?? (route.name === "projects" && route.projectId ? route.projectId : "project");
    const mapEmbedUrl = toMapEmbedUrl(liveGps);
    const mapLinkUrl = liveGps
      ? `https://www.openstreetmap.org/?mlat=${liveGps.lat}&mlon=${liveGps.lng}#map=18/${liveGps.lat}/${liveGps.lng}`
      : "https://www.openstreetmap.org";

    let pageTitle = "Sign In";
    let pageSubtitle = "Sign workers into the selected project";
    let content: ReactElement = <div />;

    if (route.name === "sign-out") {
      pageTitle = "GPS Sign Out";
      pageSubtitle = "Sign workers out from the selected project";
      content = (
        <div className="opsSignOutGrid">
          <section className="opsPanel">
            <h3>Project and location</h3>
            <div className="opsFields">
              <label>
                Project selector
                <input type="text" value={opsProjectName} onChange={(event) => setOpsProjectName(event.target.value)} />
              </label>
              <label>
                Site address
                <input type="text" value={opsLocationName} onChange={(event) => setOpsLocationName(event.target.value)} />
              </label>
              <label>
                GPS status
                <input type="text" value={liveGps ? `GPS ${liveGps.accuracyM}m accuracy` : "Live location capture enabled"} readOnly />
              </label>
              <p className="opsSubtle">
                Geofence status: {liveGps ? (liveGps.accuracyM <= 50 ? "within boundary" : "outside/low accuracy") : "awaiting GPS"} (50m
                threshold)
              </p>
              <div className="opsInline">
                <button type="button" onClick={() => void refreshLiveGps()}>
                  Refresh GPS
                </button>
                <a href={mapLinkUrl} target="_blank" rel="noreferrer">
                  Open map
                </a>
              </div>
              <div className="opsMapCard">
                <iframe title="Live site map" src={mapEmbedUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
              </div>
            </div>
          </section>

          <section className="opsPanel">
            <h3>Current signed-in workers</h3>
            <div className="opsList">
              {signedInWorkers.length === 0 ? (
                <p>No workers currently signed in.</p>
              ) : (
                signedInWorkers.map(({ worker, lastEntry }) => {
                  const signedAt = lastEntry ? new Date(lastEntry.at) : null;
                  const elapsedMinutes = signedAt ? Math.max(0, Math.round((Date.now() - signedAt.getTime()) / 60000)) : 0;
                  const gps = parseGpsNote(lastEntry?.note);
                  return (
                    <div key={worker.id} className="opsListRow">
                      <div>
                        <strong>{worker.name}</strong>
                        <small>Signed in: {signedAt ? signedAt.toLocaleString() : "-"}</small>
                        <small>Duration: {formatMinutes(elapsedMinutes)}</small>
                        <small>{gps ? `GPS ${gps.accuracyM}m` : "GPS unavailable"}</small>
                      </div>
                      <button
                        type="button"
                        className="btnWarning"
                        disabled={opsLoading}
                        onClick={() => {
                          setSelectedWorkerId(worker.id);
                          void addTimeEntry(worker.id, "clock_out");
                        }}
                      >
                        Sign Out
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      );
    } else if (route.name === "timesheets") {
      pageTitle = route.date ? `Timesheet ${route.date}` : "Timesheets";
      pageSubtitle = "Weekly and daily time summaries with project breakdown";
      const summaryMinutes =
        opsTimesheetWindow === "day"
          ? timeSummary.recentDayBreakdown[0]?.minutes ?? 0
          : timeSummary.recentDayBreakdown.reduce((sum, item) => sum + item.minutes, 0);
      content = (
        <div className="opsTimesheetLayout">
          <section className="opsSummaryGrid">
            <div className="opsSummaryCard">
              <h4>Total hours</h4>
              <strong>{formatMinutes(summaryMinutes)}</strong>
            </div>
            <div className="opsSummaryCard">
              <h4>Missing entries</h4>
              <strong>{workers.length - signedInWorkers.length}</strong>
            </div>
            <div className="opsSummaryCard">
              <h4>Export</h4>
              <div className="opsInline">
                <button type="button" onClick={() => exportTimesheetCsv(opsTimesheetWindow)}>
                  CSV
                </button>
                <button type="button" onClick={() => notify("PDF export queued.")}>
                  PDF
                </button>
              </div>
            </div>
          </section>
          <section className="opsPanel">
            <div className="opsInline">
              <button type="button" className={opsTimesheetWindow === "day" ? "active" : ""} onClick={() => setOpsTimesheetWindow("day")}>
                Day
              </button>
              <button type="button" className={opsTimesheetWindow === "week" ? "active" : ""} onClick={() => setOpsTimesheetWindow("week")}>
                Week
              </button>
              {timeSummary.recentDayBreakdown[0] ? (
                <button type="button" onClick={() => navigateOps(`/timesheets/${timeSummary.recentDayBreakdown[0].day}`)}>
                  Open latest date route
                </button>
              ) : null}
            </div>
            <table className="opsTable">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Hours</th>
                  <th>Project</th>
                  <th>Manual Adjust</th>
                </tr>
              </thead>
              <tbody>
                {timeSummary.workerBreakdown.map((row) => (
                  <tr key={row.workerId}>
                    <td>{row.workerName}</td>
                    <td>{formatMinutes(row.minutes)}</td>
                    <td>{opsProjectName}</td>
                    <td>
                      <button type="button" onClick={() => notify(`Manual adjustment queued for ${row.workerName}.`)}>
                        Adjust
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      );
    } else if (route.name === "projects") {
      pageTitle = route.section === "files" ? "Project Files" : "Projects";
      pageSubtitle = "Manage folders, versions, uploads and project file previews";
      content = (
        <div className="opsFilesLayout">
          <aside className="opsPanel">
            <h3>Project</h3>
            <div className="opsFields">
              <label>
                Select project
                <select
                  value={selectedProjectId}
                  onChange={(event) => {
                    const next = projects.find((project) => project.id === event.target.value);
                    if (!next) return;
                    setSelectedProjectId(next.id);
                    navigateOps(`/projects/${next.slug}`);
                  }}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="opsInline">
                <input
                  type="text"
                  placeholder="New project name"
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                />
                <button type="button" onClick={addProject}>
                  New Project
                </button>
              </div>
            </div>
            <h3>Folder tree</h3>
            <div className="opsFolderList">
              <button type="button" className={selectedFolderId === null ? "active" : ""} onClick={() => setSelectedFolderId(null)}>
                Root
              </button>
              {folders.map((folder) => (
                <button key={folder.id} type="button" className={selectedFolderId === folder.id ? "active" : ""} onClick={() => setSelectedFolderId(folder.id)}>
                  {folder.name}
                </button>
              ))}
            </div>
            <div className="opsInline">
              <input type="text" value={newFolderName} placeholder="New folder" onChange={(event) => setNewFolderName(event.target.value)} />
              <button type="button" onClick={() => void addFolder()} disabled={opsLoading}>
                Add
              </button>
            </div>
          </aside>
          <section className="opsPanel">
            <div className="opsInline">
              <button type="button" onClick={() => navigateOps(`/projects/${selectedProjectSlug}`)}>
                Open Project Route
              </button>
              <button type="button" onClick={() => navigateOps(`/projects/${selectedProjectSlug}/files`)}>
                Open Files Route
              </button>
              <input type="text" value={fileSearch} placeholder="Search files" onChange={(event) => setFileSearch(event.target.value)} />
              <label className="uploadLabel">
                Upload File
                <input
                  ref={projectUploadInputRef}
                  type="file"
                  onChange={(event) => {
                    void handleProjectFileUpload(event.target.files?.[0] ?? null);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
            <div className="opsList">
              {visibleFiles.map((file) => (
                <div
                  key={file.id}
                  className={`opsListRow ${selectedProjectFileId === file.id ? "opsRowActive" : ""}`}
                  onClick={() => setSelectedProjectFileId(file.id)}
                >
                  <div>
                    <strong>{file.name}</strong>
                    <small>
                      Version v{file.version ?? 1} • {file.status}
                    </small>
                    <small>
                      Uploaded {new Date(file.updatedAt).toLocaleString()} by {file.uploadedBy ?? "Current User"}
                    </small>
                  </div>
                  <div className="opsInline opsFileRowActions">
                    <button type="button" onClick={() => setSelectedProjectFileId(file.id)}>
                      Preview
                    </button>
                    <button type="button" onClick={() => downloadProjectFile(file)}>
                      Download
                    </button>
                    <button type="button" onClick={() => deleteProjectFile(file.id)}>
                      Delete
                    </button>
                    <button type="button" onClick={() => void openProjectFileInEditor(file)}>
                      Open in PDF Editor
                    </button>
                  </div>
                </div>
              ))}
              {visibleFiles.length === 0 ? <p>No files in this folder.</p> : null}
            </div>
            <div className="opsPanel opsFilePreview">
              <h3>File preview</h3>
              {selectedProjectFile ? (
                selectedProjectFile.dataUrl && (selectedProjectFile.mimeType?.includes("pdf") || selectedProjectFile.name.toLowerCase().endsWith(".pdf")) ? (
                  <iframe title={`Preview ${selectedProjectFile.name}`} src={selectedProjectFile.dataUrl} />
                ) : selectedProjectFile.dataUrl && selectedProjectFile.mimeType?.startsWith("image/") ? (
                  <img src={selectedProjectFile.dataUrl} alt={selectedProjectFile.name} />
                ) : (
                  <p>No embeddable preview for this file type.</p>
                )
              ) : (
                <p>Select a file to preview.</p>
              )}
            </div>
            <div className="opsInline">
              <input type="text" value={newFileName} placeholder="File name" onChange={(event) => setNewFileName(event.target.value)} />
              <button type="button" onClick={() => void addProjectFile()} disabled={opsLoading}>
                Upload
              </button>
            </div>
          </section>
        </div>
      );
    } else if (route.name === "forms") {
      if (route.mode === "fill") {
        pageTitle = activeForm ? `Form: ${activeForm.name}` : "Form Completion";
        pageSubtitle = "Complete sections, save draft, submit and attach site records";
        content = (
          <div className="opsFormFillLayout">
            <aside className="opsPanel">
              <h3>Sections</h3>
              <div className="opsList">
                {["General", "Safety", "Materials", "Photos", "Signatures"].map((section, idx) => (
                  <button
                    key={section}
                    type="button"
                    className={activeFormStep === idx + 1 ? "active" : ""}
                    onClick={() => setActiveFormStep(idx + 1)}
                  >
                    {idx + 1}. {section}
                  </button>
                ))}
              </div>
            </aside>
            <section className="opsPanel">
              <div className="opsProgressBlock">
                <small>Form progress</small>
                <div className="opsProgressBar">
                  <span style={{ width: `${(activeFormStep / 5) * 100}%` }} />
                </div>
              </div>
              <div className="opsFields">
                <label>
                  Text field
                  <input type="text" placeholder="Enter notes" />
                </label>
                <label>
                  Date
                  <input type="date" />
                </label>
                <label>
                  Dropdown
                  <select>
                    <option>Good</option>
                    <option>Needs action</option>
                  </select>
                </label>
                <label>
                  <input type="checkbox" /> Include photographic evidence
                </label>
                <label>
                  Signature
                  <input type="text" placeholder="Signed by" />
                </label>
              </div>
              <div className="opsInline">
                <button type="button" onClick={() => setActiveFormStep((prev) => Math.max(1, prev - 1))}>
                  Previous
                </button>
                <button type="button" onClick={() => setActiveFormStep((prev) => Math.min(5, prev + 1))}>
                  Next
                </button>
                <button type="button" onClick={() => notify("Draft saved locally.")}>
                  Save Draft
                </button>
                <button
                  type="button"
                  className="btnSuccess"
                  onClick={() => {
                    if (!route.formId) return;
                    setCompletedFormIds((prev) => (prev.includes(route.formId!) ? prev : [...prev, route.formId!]));
                    navigateOps(`/forms/submissions/${route.formId}`);
                  }}
                >
                  Submit
                </button>
              </div>
            </section>
          </div>
        );
      } else if (route.mode === "view") {
        pageTitle = "Form Submission";
        pageSubtitle = "Review completed fields and metadata";
        content = (
          <section className="opsPanel">
            <div className="opsSuccessCircle">OK</div>
            <h3>Submission completed</h3>
            <p className="opsSubtle">Submission ID: {route.submissionId}</p>
            <div className="opsInline">
              <button type="button" onClick={() => navigateOps(`/forms/submissions/${route.submissionId}/export`)}>
                Export
              </button>
              <button type="button" onClick={() => navigateOps("/forms")}>
                Back to Forms
              </button>
            </div>
          </section>
        );
      } else if (route.mode === "export") {
        pageTitle = "Export Form";
        pageSubtitle = "Export completed form in required formats";
        content = (
          <section className="opsPanel">
            <div className="opsList">
              <button type="button" className="opsListRow opsRowButton" onClick={() => notify("Exported PDF document.")}>
                <div>
                  <strong>PDF Document</strong>
                  <small>Best for printing and sharing</small>
                </div>
                <span>{">"}</span>
              </button>
              <button type="button" className="opsListRow opsRowButton" onClick={() => notify("Exported Excel spreadsheet.")}>
                <div>
                  <strong>Excel Spreadsheet</strong>
                  <small>Best for data analysis</small>
                </div>
                <span>{">"}</span>
              </button>
              <button type="button" className="opsListRow opsRowButton" onClick={() => notify("Exported CSV file.")}>
                <div>
                  <strong>CSV File</strong>
                  <small>Best for import workflows</small>
                </div>
                <span>{">"}</span>
              </button>
            </div>
          </section>
        );
      } else {
        pageTitle = "Forms Library";
        pageSubtitle = "Available, assigned, draft and submitted forms";
        content = (
          <section className="opsPanel">
            <div className="opsInline">
              <input type="text" placeholder="Search forms..." />
              <button type="button">Filter</button>
            </div>
            <div className="opsList">
              {availableForms.map((form) => (
                <div key={form.id} className="opsListRow">
                  <div>
                    <strong>{form.name}</strong>
                    <small>{form.version}</small>
                    <small>Updated {form.updatedAt}</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveFormId(form.id);
                      setActiveFormStep(1);
                      navigateOps(`/forms/${form.id}/fill`);
                    }}
                  >
                    Open form
                  </button>
                </div>
              ))}
              {availableForms.length === 0 ? <p>All forms submitted.</p> : null}
            </div>
          </section>
        );
      }
    } else {
      pageTitle = "GPS Sign In";
      pageSubtitle = "Capture project and worker attendance with geofence checks";
      const selectedWorkerLastAction = selectedWorker ? latestEntryByWorker[selectedWorker.id] : undefined;
      const selectedWorkerGps = parseGpsNote(selectedWorkerLastAction?.note);
      const clockInCheck = selectedWorker ? canApplyClockAction(selectedWorker.id, "clock_in") : { ok: false };
      content = (
        <div className="opsSignInGrid">
          <section className="opsPanel opsFields">
            <label>
              Project selector
              <input type="text" value={opsProjectName} onChange={(event) => setOpsProjectName(event.target.value)} />
            </label>
            <label>
              Site address
              <input type="text" value={opsLocationName} onChange={(event) => setOpsLocationName(event.target.value)} />
            </label>
            <label>
              Worker
              <select value={selectedWorkerId} onChange={(event) => setSelectedWorkerId(event.target.value)}>
                {workers.map((worker) => (
                  <option key={worker.id} value={worker.id}>
                    {worker.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="opsInline">
              <input type="text" placeholder="New worker name" value={newWorkerName} onChange={(event) => setNewWorkerName(event.target.value)} />
              <input type="text" placeholder="Role" value={newWorkerRole} onChange={(event) => setNewWorkerRole(event.target.value)} />
              <button type="button" onClick={() => void addWorker()}>
                Add Worker
              </button>
            </div>
            <p className="opsSubtle">
              GPS accuracy: {liveGps ? `${liveGps.accuracyM}m` : selectedWorkerGps ? `${selectedWorkerGps.accuracyM}m` : "not captured yet"} |
              Geofence: {(liveGps && liveGps.accuracyM <= 50) || (selectedWorkerGps && selectedWorkerGps.accuracyM <= 50) ? "inside" : "check location"}
            </p>
            <button
              type="button"
              className="btnSuccess"
              disabled={!selectedWorker || !clockInCheck.ok || opsLoading}
              onClick={() => selectedWorker && void addTimeEntry(selectedWorker.id, "clock_in")}
            >
              Sign In
            </button>
          </section>

          <section className="opsPanel">
            <h3>Live GPS Map</h3>
            <div className="opsMapCard">
              <iframe title="Sign in live map" src={mapEmbedUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
            </div>
            <div className="opsInline">
              <button type="button" onClick={() => void refreshLiveGps()}>
                Refresh GPS
              </button>
              <a href={mapLinkUrl} target="_blank" rel="noreferrer">
                Open map
              </a>
            </div>
            <p className="opsSubtle">
              {liveGps
                ? `Captured ${new Date(liveGps.capturedAt).toLocaleTimeString()} (${liveGps.source}).`
                : "Map will update when GPS is captured."}
            </p>
          </section>
        </div>
      );
    }

    return (
      <main className="opsAppRoot">
        <aside className="opsDesktopSidebar">
          <h2>MEP Ops</h2>
          <nav>
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={activeNav === item.key ? "active" : ""}
                onClick={() => navigateOps(item.path)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="opsAppMain">
          <header className="opsPageHeader">
            <div>
              <h1>{pageTitle}</h1>
              <p>{pageSubtitle}</p>
            </div>
            <div className="opsHeaderMeta">
              <span>Route: {opsPathname}</span>
              <span>{hasSupabaseConfig ? "Supabase" : "Local Storage"}</span>
            </div>
          </header>
          <section className="opsPageContent">{content}</section>
        </div>

        <nav className="opsMobileBottomNav">
          {navItems.map((item) => (
            <button key={`mobile-${item.key}`} type="button" className={activeNav === item.key ? "active" : ""} onClick={() => navigateOps(item.path)}>
              {item.label}
            </button>
          ))}
        </nav>
      </main>
    );
  }

  const pages = Array.from({ length: pageCount }, (_, idx) => idx + 1);

  return (
    <div className="app">
      <header className="appShellHeader">
        <div>
          <h1>MEP OPS Platform</h1>
          <p>Operational workspace with markup studio</p>
        </div>
        <div className="opsInline">
          <button
            type="button"
            className={activeModule === "markup-studio" ? "active" : ""}
            onClick={() => {
              window.history.pushState({}, "", "/");
              setActiveModule("markup-studio");
            }}
          >
            Markup Studio
          </button>
          <button
            type="button"
            className={activeModule === "operations" ? "active" : ""}
            onClick={() => navigateOps("/sign-in")}
          >
            Operations
          </button>
        </div>
      </header>
      {activeModule === "markup-studio" ? (
      <>
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

        <div className="toolbarGrid">
        <div className="group panel panel-files">
          <span className="panelTitle">File</span>
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

        <div className="group panel panel-tools">
          <span className="panelTitle">Tools</span>
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

        <div className="group panel panel-view">
          <span className="panelTitle">View & Measure</span>
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

        <div className="group panel panel-stamps">
          <span className="panelTitle">Stamps</span>
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

        <div className="group panel panel-edit">
          <span className="panelTitle">Edit</span>
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
          <div className="group panel panel-selected">
            <details className="selectedDetails">
              <summary>
                Selected Annotation
                <span className="selectedMeta">#{selectedAnnotation.id.slice(0, 6)}</span>
              </summary>
              <div className="selectedDetailsBody">
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
            </details>
          </div>
        ) : null}
        </div>
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
      </>
      ) : (
        renderOperationsModule()
      )}
    </div>
  );
}

export default App;
