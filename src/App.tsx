import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import type { Session } from "@supabase/supabase-js";
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
  client: string;
  manager: string;
  status: "active" | "on_hold" | "completed" | "archived";
  address: string;
  startDate: string;
  targetDate: string;
  description: string;
};
type ProjectPermission = {
  viewFiles: boolean;
  uploadFiles: boolean;
  editFiles: boolean;
  deleteFiles: boolean;
  usePdfMarkup: boolean;
  manageFolders: boolean;
  manageTeam: boolean;
  editProjectSettings: boolean;
};
type ProjectMember = {
  id: string;
  projectId: string;
  name: string;
  email: string;
  role: "Owner" | "Manager" | "Engineer" | "Viewer";
  status: "active" | "invited";
  dateAdded: string;
  permission: ProjectPermission;
};
type ProjectActivity = {
  id: string;
  projectId: string;
  user: string;
  action: string;
  item: string;
  at: string;
};
type ProjectFileVersion = {
  id: string;
  fileId: string;
  projectId: string;
  version: number;
  dataUrl?: string;
  fileSize?: number;
  uploadedBy: string;
  uploadedAt: string;
  changeNote?: string;
};
type FolderNode = { id: string; projectId: string; name: string; parentId: string | null };
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
  annotations?: unknown;
};
type FormTemplate = {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  fileName: string;
  assetPath: string;
};
type CommissioningFieldType = "text" | "textarea" | "date" | "number" | "checkbox";
type CommissioningField = {
  id: string;
  label: string;
  type: CommissioningFieldType;
  placeholder?: string;
};
type CommissioningSection = {
  id: string;
  title: string;
  fields: CommissioningField[];
};
type CommissioningSubmission = {
  id: string;
  projectId: string;
  templateId: string;
  templateName: string;
  values: Record<string, string>;
  status: "draft" | "completed";
  updatedAt: string;
  createdBy: string;
};
type GpsSnapshot = {
  lat: number;
  lng: number;
  accuracyM: number;
  capturedAt: string;
  source: "device" | "entry";
};
type WeatherSnapshot = {
  weatherCode: number;
  temperatureC: number;
  condition: string;
  rainChancePct: number | null;
  windMph: number | null;
  highC: number | null;
  lowC: number | null;
  updatedAt: string;
};
type OpsRoute =
  | { name: "home" }
  | { name: "sign-in" }
  | { name: "sign-out" }
  | { name: "timesheets"; date?: string }
  | { name: "projects"; projectId?: string; section?: "files" | "file-open"; fileId?: string }
  | { name: "forms"; formId?: string; submissionId?: string; mode?: "fill" | "view" | "export" };
type BatchDocument = {
  id: string;
  name: string;
  bytes: Uint8Array;
  annotations: Annotation[];
  calibrationByPage: Record<number, number>;
  rotationByPage: Record<number, number>;
};
type ToolbarPanel = "file" | "tools" | "view" | "stamps" | "edit" | "selected";
type AuthMode = "login" | "signup" | "forgot" | "reset";
type ProjectEditorContext = {
  projectId: string;
  fileId: string;
  fileName: string;
};

const DEFAULT_STROKE_WIDTH = 2;
const DEFAULT_HIGHLIGHTER_WIDTH = 14;
const DEFAULT_HIGHLIGHTER_COLOR = "#ffe45e";
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const CUSTOM_STAMPS_STORAGE_KEY = "pdfmaker.customStamps.v1";
const OPS_STORAGE_KEY = "mep-ops.local.v1";
const DAILY_INTRO_VIDEO_PATH = "/replicate-prediction-f9s42e48m9rmw0cxz73ag0gahr.mp4";
const DAILY_INTRO_SEEN_KEY_PREFIX = "mep-ops.daily-intro.v1";
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
  {
    id: "split-commissioning",
    name: "Split Commissioning",
    version: "v1.0",
    updatedAt: "13/07/2026",
    fileName: "Job Name - Area - LAC - Split Commissioning.pdf",
    assetPath: "/Job_Name_-_Area_-_LAC_-_Split_Commissioning_fb77.pdf",
  },
  {
    id: "hvrf-log-book",
    name: "HVRF Log Book",
    version: "v1.0",
    updatedAt: "13/07/2026",
    fileName: "Job Name - Area - LAC - HVRF Log Book.pdf",
    assetPath: "/Job_Name_-_Area_-_LAC_-_HVRF_Log_Book_8d76.pdf",
  },
  {
    id: "10-fcu-commissioning-vrf",
    name: "10 FCU Commissioning VRF",
    version: "v1.0",
    updatedAt: "13/07/2026",
    fileName: "Job Name - Area - LAC - 10 FCU Commissioning VRF.pdf",
    assetPath: "/Job_Name_-_Area_-_LAC_-_10_FCU_Commissioning_VRF_bc3f.pdf",
  },
  {
    id: "20-fcu-commissioning-vrf",
    name: "20 FCU Commissioning VRF",
    version: "v1.0",
    updatedAt: "13/07/2026",
    fileName: "Job Name - Area - LAC - 20 FCU Commissioning VRF.pdf",
    assetPath: "/Job_Name_-_Area_-_LAC_-_20_FCU_Commissioning_VRF_f4f9.pdf",
  },
  {
    id: "30-fcu-commissioning-vrf",
    name: "30 FCU Commissioning VRF",
    version: "v1.0",
    updatedAt: "13/07/2026",
    fileName: "Job Name - Area - LAC - 30 FCU Commissioning VRF.pdf",
    assetPath: "/Job_Name_-_Area_-_LAC_-_30_FCU_Commissioning_VRF_817a.pdf",
  },
  {
    id: "40-fcu-commissioning-vrf",
    name: "40 FCU Commissioning VRF",
    version: "v1.0",
    updatedAt: "13/07/2026",
    fileName: "Job Name - Area - LAC - 40 FCU Commissioning VRF.pdf",
    assetPath: "/Job_Name_-_Area_-_LAC_-_40_FCU_Commissioning_VRF_4129.pdf",
  },
];

function buildFcuCommissioningSections(count: number): CommissioningSection[] {
  return [
    {
      id: "system-details",
      title: "System Details",
      fields: [
        { id: "project", label: "Project", type: "text" },
        { id: "area", label: "Area", type: "text" },
        { id: "lac-ref", label: "LAC Reference", type: "text" },
        { id: "engineer", label: "Commissioning Engineer", type: "text" },
        { id: "test-date", label: "Date of Test", type: "date" },
      ],
    },
    {
      id: "condenser-and-refrigerant",
      title: "Condenser / Refrigerant",
      fields: [
        { id: "condenser-model", label: "Condenser Model", type: "text" },
        { id: "condenser-serial", label: "Condenser Serial", type: "text" },
        { id: "system-refrigerant", label: "System Refrigerant", type: "text" },
        { id: "manufacturer-charge-kg", label: "Manufacturer Charge (kg)", type: "number" },
        { id: "additional-charge-kg", label: "Additional Charge (kg)", type: "number" },
      ],
    },
    {
      id: "fcu-readings",
      title: `FCU Readings (${count} units)`,
      fields: [
        { id: "fcu-summary", label: "FCU Readings Summary", type: "textarea", placeholder: "Enter per-unit FCU readings and notes" },
        { id: "fcu-checklist", label: "FCU Checklist Summary", type: "textarea", placeholder: "Filter condition, condensate type, fresh air checks" },
      ],
    },
    {
      id: "pressure-vacuum-drain",
      title: "Pressure / Vacuum / Drain Tests",
      fields: [
        { id: "strength-test-bar", label: "Strength Test (bar)", type: "number" },
        { id: "leak-test-bar", label: "Leak Test (bar)", type: "number" },
        { id: "vacuum-test-torr", label: "Vacuum Test (torr)", type: "number" },
        { id: "drain-test-complete", label: "Drain Test Complete", type: "checkbox" },
      ],
    },
    {
      id: "handover",
      title: "Handover",
      fields: [
        { id: "controller-model-serial", label: "Controller Model / Serial", type: "text" },
        { id: "bms-interface-complete", label: "BMS Interface Complete", type: "checkbox" },
        { id: "fire-interface-complete", label: "Fire Alarm Interface Complete", type: "checkbox" },
        { id: "handover-comments", label: "Handover Comments", type: "textarea" },
      ],
    },
  ];
}

const COMMISSIONING_TEMPLATE_SECTIONS: Record<string, CommissioningSection[]> = {
  "split-commissioning": [
    {
      id: "system-details",
      title: "System Details",
      fields: [
        { id: "project", label: "Project", type: "text" },
        { id: "area", label: "Area", type: "text" },
        { id: "lac-ref", label: "LAC Reference", type: "text" },
        { id: "customer", label: "Customer", type: "text" },
        { id: "test-engineer", label: "Test Engineer", type: "text" },
        { id: "test-date", label: "Date of Test", type: "date" },
      ],
    },
    {
      id: "condenser",
      title: "Condenser & Refrigerant",
      fields: [
        { id: "condenser-model", label: "Condenser Model", type: "text" },
        { id: "condenser-serial", label: "Condenser Serial", type: "text" },
        { id: "system-refrigerant", label: "System Refrigerant", type: "text" },
        { id: "manufacturer-charge-kg", label: "Manufacturer Charge (kg)", type: "number" },
        { id: "additional-charge-kg", label: "Additional Charge (kg)", type: "number" },
      ],
    },
    {
      id: "test-certificates",
      title: "Test Certificates",
      fields: [
        { id: "strength-test-bar", label: "Strength Test (bar)", type: "number" },
        { id: "leak-test-bar", label: "Leak Test (bar)", type: "number" },
        { id: "vacuum-test-torr", label: "Vacuum Test (torr)", type: "number" },
        { id: "drain-test-complete", label: "Drain Test Complete", type: "checkbox" },
      ],
    },
    {
      id: "handover",
      title: "Handover Information",
      fields: [
        { id: "controller-model-serial", label: "Central Controller Model / Serial", type: "text" },
        { id: "time-schedule-set", label: "Time Schedule Set", type: "checkbox" },
        { id: "bms-interface-complete", label: "BMS Interface Complete", type: "checkbox" },
        { id: "fire-interface-complete", label: "Fire Alarm Interface Complete", type: "checkbox" },
        { id: "handover-comments", label: "Comments", type: "textarea" },
      ],
    },
  ],
  "hvrf-log-book": [
    {
      id: "contractor-site",
      title: "Contractor & Site Details",
      fields: [
        { id: "project", label: "Project", type: "text" },
        { id: "site-address", label: "Site Address", type: "text" },
        { id: "installation-contractor", label: "Installation Contractor", type: "text" },
        { id: "commissioning-engineer", label: "Commissioning Engineer", type: "text" },
        { id: "test-date", label: "Date", type: "date" },
      ],
    },
    {
      id: "outdoor-system",
      title: "Outdoor System Details",
      fields: [
        { id: "outdoor-location", label: "Outdoor Location", type: "text" },
        { id: "system-reference", label: "System Reference", type: "text" },
        { id: "system-model", label: "System Model", type: "text" },
        { id: "outdoor-serial", label: "Outdoor Unit Serial", type: "text" },
      ],
    },
    {
      id: "hbc-and-pipework",
      title: "HBC / Pipework",
      fields: [
        { id: "hbc-main-model", label: "HBC Controller Main Model", type: "text" },
        { id: "hbc-main-serial", label: "HBC Controller Main Serial", type: "text" },
        { id: "pipework-summary", label: "Pipework Summary", type: "textarea", placeholder: "Diameter, length, type and charge calculations" },
      ],
    },
    {
      id: "readings-and-handover",
      title: "Readings & Handover",
      fields: [
        { id: "operating-readings", label: "Operating Readings Summary", type: "textarea" },
        { id: "controller-password", label: "Controller Password", type: "text" },
        { id: "handover-comments", label: "Comments", type: "textarea" },
      ],
    },
  ],
  "10-fcu-commissioning-vrf": buildFcuCommissioningSections(10),
  "20-fcu-commissioning-vrf": buildFcuCommissioningSections(20),
  "30-fcu-commissioning-vrf": buildFcuCommissioningSections(30),
  "40-fcu-commissioning-vrf": buildFcuCommissioningSections(40),
};
const DEFAULT_PROJECTS: Project[] = [
  {
    id: "proj-1",
    slug: "new-street-square",
    name: "New Street Square",
    code: "NSS",
    client: "Example Developments Ltd",
    manager: "Andy Bird",
    status: "active",
    address: "London EC4A 3BZ",
    startDate: "2025-03-12",
    targetDate: "2026-11-30",
    description: "City-centre mixed-use development.",
  },
  {
    id: "proj-2",
    slug: "one-crown-place",
    name: "One Crown Place",
    code: "OCP",
    client: "Urban Estates",
    manager: "Sarah Johnson",
    status: "active",
    address: "London EC2A 4AQ",
    startDate: "2025-01-20",
    targetDate: "2026-07-15",
    description: "Commercial fit-out and services package.",
  },
];
type ProjectFolderTemplate = {
  name: string;
  children?: ProjectFolderTemplate[];
};

const DEFAULT_PROJECT_FOLDER_TEMPLATE: ProjectFolderTemplate[] = [
  {
    name: "01. Health and Safety",
    children: ["01. Inductions", "02. RAMS", "03. Weekly Pack - Subby", "04. SHE Management Reports"].map((name) => ({
      name,
    })),
  },
  {
    name: "02. Handover Documentation",
    children: ["01. Drawings", "02. Schematics", "03. Tech Subs", "04. Spec"].map((name) => ({
      name,
    })),
  },
  {
    name: "03. Marked Up Drawings - Bi-Weekly",
  },
  {
    name: "04. Variation Substantiation - NO COST",
    children: [
      "VO01 - Common Brackets - Closed",
      "VO02 - Additional supports",
      "VO03 - Remove Mock up and Reinstall",
      "VO04 - Level 2 Tray and pipe alterations",
    ].map((name) => ({ name })),
  },
  {
    name: "05. Commissioning Documentation",
    children: [{ name: "System Ref -" }],
  },
];
const OWNER_PERMISSION: ProjectPermission = {
  viewFiles: true,
  uploadFiles: true,
  editFiles: true,
  deleteFiles: true,
  usePdfMarkup: true,
  manageFolders: true,
  manageTeam: true,
  editProjectSettings: true,
};
const CURRENT_USER = {
  name: "Andy Bird",
  email: "andy.bird@rdmande.uk",
};
const OWNER_EMAIL = "andy.bird@rdmande.uk";

function makeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildDefaultFoldersForProject(projectId: string): FolderNode[] {
  const seededFolders: FolderNode[] = [];
  const appendTemplate = (nodes: ProjectFolderTemplate[], parentId: string | null): void => {
    for (const node of nodes) {
      const id = makeId();
      seededFolders.push({
        id,
        projectId,
        name: node.name,
        parentId,
      });
      if (node.children?.length) {
        appendTemplate(node.children, id);
      }
    }
  };
  appendTemplate(DEFAULT_PROJECT_FOLDER_TEMPLATE, null);
  return seededFolders;
}

function formatMinutes(totalMinutes: number): string {
  const safeMinutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

function formatDateUk(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB");
}

function formatDateTimeUk(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatTimeUk(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatLongDateUk(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function getLocalDayKey(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "invalid-date";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weatherCodeToLabel(code: number): string {
  if (code === 0) return "Clear sky";
  if ([1, 2].includes(code)) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([61, 63, 65, 66, 67].includes(code)) return "Rain";
  if ([71, 73, 75, 77].includes(code)) return "Snow";
  if ([80, 81, 82].includes(code)) return "Rain showers";
  if ([85, 86].includes(code)) return "Snow showers";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return "Weather update";
}

function weatherCodeToIcon(code: number): string {
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "⛅";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌤️";
}

function getGreetingForHour(hour24: number): string {
  if (hour24 < 12) return "Good morning";
  if (hour24 < 18) return "Good afternoon";
  return "Good evening";
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
    pathname === "/" ||
    pathname === "/home" ||
    pathname === "/sign-in" ||
    pathname === "/sign-out" ||
    pathname === "/timesheets" ||
    /^\/timesheets\/[^/]+$/.test(pathname) ||
    pathname === "/projects" ||
    /^\/projects\/[^/]+$/.test(pathname) ||
    /^\/projects\/[^/]+\/files$/.test(pathname) ||
    /^\/projects\/[^/]+\/files\/[^/]+$/.test(pathname) ||
    pathname === "/forms" ||
    /^\/forms\/[^/]+\/fill$/.test(pathname) ||
    /^\/forms\/submissions\/[^/]+$/.test(pathname) ||
    /^\/forms\/submissions\/[^/]+\/export$/.test(pathname)
  );
}

function parseOpsRoute(pathname: string): OpsRoute {
  if (pathname === "/" || pathname === "/home") return { name: "home" };
  if (pathname === "/sign-in") return { name: "sign-in" };
  if (pathname === "/sign-out") return { name: "sign-out" };
  if (pathname === "/timesheets") return { name: "timesheets" };
  if (pathname.startsWith("/timesheets/")) return { name: "timesheets", date: pathname.split("/")[2] };
  if (pathname === "/projects") return { name: "projects" };
  if (/^\/projects\/[^/]+\/files$/.test(pathname)) {
    const parts = pathname.split("/");
    return { name: "projects", projectId: parts[2], section: "files" };
  }
  if (/^\/projects\/[^/]+\/files\/[^/]+$/.test(pathname)) {
    const parts = pathname.split("/");
    return { name: "projects", projectId: parts[2], section: "file-open", fileId: decodeURIComponent(parts[4]) };
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
  return { name: "home" };
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
  const [activeModule, setActiveModule] = useState<AppModule>("operations");
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>(DEFAULT_PROJECTS);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(DEFAULT_PROJECTS[0]?.id ?? "");
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [projectActivities, setProjectActivities] = useState<ProjectActivity[]>([]);
  const [projectFileVersions, setProjectFileVersions] = useState<ProjectFileVersion[]>([]);
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [newProjectCode, setNewProjectCode] = useState<string>("");
  const [newProjectClient, setNewProjectClient] = useState<string>("");
  const [newProjectAddress, setNewProjectAddress] = useState<string>("");
  const [newProjectStart, setNewProjectStart] = useState<string>("");
  const [newProjectTarget, setNewProjectTarget] = useState<string>("");
  const [newProjectManager, setNewProjectManager] = useState<string>("Andy Bird");
  const [newProjectDescription, setNewProjectDescription] = useState<string>("");
  const [newProjectStatus, setNewProjectStatus] = useState<Project["status"]>("active");
  const [showNewProjectModal, setShowNewProjectModal] = useState<boolean>(false);
  const [projectSearch, setProjectSearch] = useState<string>("");
  const [projectStatusFilter, setProjectStatusFilter] = useState<Project["status"] | "all">("all");
  const [projectWorkspaceTab, setProjectWorkspaceTab] = useState<"overview" | "files" | "team" | "forms" | "activity" | "settings">("files");
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [newFileName, setNewFileName] = useState<string>("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [opsLoading, setOpsLoading] = useState<boolean>(false);
  const [fileSearch, setFileSearch] = useState<string>("");
  const [activeFormId, setActiveFormId] = useState<string | null>(null);
  const [completedFormIds, setCompletedFormIds] = useState<string[]>([]);
  const [commissioningSubmissions, setCommissioningSubmissions] = useState<CommissioningSubmission[]>([]);
  const [activeCommissioningSubmissionId, setActiveCommissioningSubmissionId] = useState<string | null>(null);
  const [activeCommissioningValues, setActiveCommissioningValues] = useState<Record<string, string>>({});
  const [opsPathname, setOpsPathname] = useState<string>(() => window.location.pathname || "/home");
  const [opsTimesheetWindow, setOpsTimesheetWindow] = useState<"day" | "week">("day");
  const [liveGps, setLiveGps] = useState<GpsSnapshot | null>(null);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherLoading, setWeatherLoading] = useState<boolean>(false);
  const [weatherError, setWeatherError] = useState<string>("");
  const [selectedProjectFileId, setSelectedProjectFileId] = useState<string | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, boolean>>({});
  const [versionHistoryFileId, setVersionHistoryFileId] = useState<string | null>(null);
  const [versionUploadTargetId, setVersionUploadTargetId] = useState<string | null>(null);
  const [projectEditorContext, setProjectEditorContext] = useState<ProjectEditorContext | null>(null);
  const [openFileNeedsSaveWarning, setOpenFileNeedsSaveWarning] = useState<boolean>(false);
  const [isCompactToolbar, setIsCompactToolbar] = useState<boolean>(() => window.innerWidth <= 1280);
  const [activeToolbarPanel, setActiveToolbarPanel] = useState<ToolbarPanel>("tools");
  const [authSession, setAuthSession] = useState<Session | null>(null);
  const [authInitializing, setAuthInitializing] = useState<boolean>(hasSupabaseConfig);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authEmail, setAuthEmail] = useState<string>(OWNER_EMAIL);
  const [authPassword, setAuthPassword] = useState<string>("");
  const [authConfirmPassword, setAuthConfirmPassword] = useState<string>("");
  const [authMessage, setAuthMessage] = useState<string>("");
  const [authBusy, setAuthBusy] = useState<boolean>(false);
  const [authDiagnosticsBusy, setAuthDiagnosticsBusy] = useState<boolean>(false);
  const [authDiagnosticsOutput, setAuthDiagnosticsOutput] = useState<string>("");
  const [showDailyIntroVideo, setShowDailyIntroVideo] = useState<boolean>(false);
  const opsStorageWarnedRef = useRef<boolean>(false);

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
  const selectedProjectMembers = useMemo(
    () => projectMembers.filter((member) => member.projectId === selectedProjectId),
    [projectMembers, selectedProjectId],
  );
  const currentUser = useMemo(() => {
    const email = authSession?.user?.email ?? CURRENT_USER.email;
    const metadataName = String(authSession?.user?.user_metadata?.full_name ?? "").trim();
    const fallbackName = email.toLowerCase() === OWNER_EMAIL ? "Andy Bird" : email.split("@")[0] || CURRENT_USER.name;
    return {
      name: metadataName || fallbackName,
      email,
    };
  }, [authSession]);
  const authWorkerId = authSession?.user?.id ?? "";
  const authWorker = useMemo(
    () => (authWorkerId ? workers.find((worker) => worker.id === authWorkerId) ?? null : null),
    [workers, authWorkerId],
  );
  const currentProjectMember = useMemo(
    () =>
      selectedProjectMembers.find((member) => member.email.toLowerCase() === currentUser.email.toLowerCase()) ??
      selectedProjectMembers.find((member) => member.role === "Owner") ??
      null,
    [selectedProjectMembers, currentUser.email],
  );
  const projectPermission = currentProjectMember?.permission ?? OWNER_PERMISSION;
  const filteredProjects = useMemo(
    () =>
      projects.filter((project) => {
        if (projectStatusFilter !== "all" && project.status !== projectStatusFilter) return false;
        if (!projectSearch.trim()) return true;
        const q = projectSearch.toLowerCase();
        return (
          project.name.toLowerCase().includes(q) ||
          project.code.toLowerCase().includes(q) ||
          project.address.toLowerCase().includes(q)
        );
      }),
    [projects, projectSearch, projectStatusFilter],
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
  const selectedProjectActivity = useMemo(
    () =>
      projectActivities
        .filter((entry) => entry.projectId === selectedProjectId)
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [projectActivities, selectedProjectId],
  );
  const selectedFileVersions = useMemo(
    () => projectFileVersions.filter((version) => version.fileId === (versionHistoryFileId ?? selectedProjectFileId)),
    [projectFileVersions, selectedProjectFileId, versionHistoryFileId],
  );
  const activeCommissioningSubmission = useMemo(
    () => commissioningSubmissions.find((item) => item.id === activeCommissioningSubmissionId) ?? null,
    [commissioningSubmissions, activeCommissioningSubmissionId],
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
    if (projects.length === 0) return;
    if (folders.length === 0) {
      const seededFolders: FolderNode[] = [];
      for (const project of projects) {
        seededFolders.push(...buildDefaultFoldersForProject(project.id));
      }
      setFolders(seededFolders);
    }
    if (projectMembers.length === 0) {
      setProjectMembers(
        projects.map((project) => ({
          id: makeId(),
          projectId: project.id,
          name: project.manager || currentUser.name,
          email: currentUser.email,
          role: "Owner",
          status: "active",
          dateAdded: new Date().toISOString(),
          permission: OWNER_PERMISSION,
        })),
      );
    }
  }, [projects, folders.length, projectMembers.length, currentUser.email, currentUser.name]);

  useEffect(() => {
    if (projects.length === 0) return;
    const exists = projects.some((project) => project.id === selectedProjectId);
    if (!exists) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

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
    if (isOpsPath(opsPathname) && !projectEditorContext) {
      setActiveModule("operations");
    }
  }, [opsPathname, projectEditorContext]);

  useEffect(() => {
    if (!hasSupabaseConfig || !supabase) {
      setAuthInitializing(false);
      return;
    }
    let mounted = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setAuthSession(data.session);
      })
      .catch(() => {
        if (!mounted) return;
        setAuthSession(null);
      })
      .finally(() => {
        if (!mounted) return;
        setAuthInitializing(false);
      });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setAuthSession(session);
      if (event === "PASSWORD_RECOVERY") {
        setAuthMode("reset");
        setAuthMessage("Set your new password to finish account recovery.");
      }
      if (event === "SIGNED_OUT") {
        setAuthMode("login");
        setAuthPassword("");
        setAuthConfirmPassword("");
      }
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (activeModule !== "operations") return;
    if (opsRoute.name !== "sign-in" && opsRoute.name !== "sign-out") return;
    void refreshLiveGps();
  }, [activeModule, opsRoute.name]);

  useEffect(() => {
    if (activeModule !== "operations" || opsRoute.name !== "home") return;
    void refreshWeatherSnapshot();
    const handle = window.setInterval(() => {
      void refreshWeatherSnapshot();
    }, 15 * 60 * 1000);
    return () => window.clearInterval(handle);
  }, [activeModule, opsRoute.name]);

  useEffect(() => {
    function onResize(): void {
      setIsCompactToolbar(window.innerWidth <= 1280);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (opsRoute.name !== "projects" || !opsRoute.projectId) return;
    if (opsRoute.section === "files") {
      setProjectWorkspaceTab("files");
    } else {
      setProjectWorkspaceTab("files");
    }
  }, [opsRoute]);

  useEffect(() => {
    if (opsRoute.name === "projects" && opsRoute.section === "file-open" && opsRoute.fileId) {
      setSelectedProjectFileId(opsRoute.fileId);
      setOpenFileNeedsSaveWarning(true);
      return;
    }
    setOpenFileNeedsSaveWarning(false);
  }, [opsRoute]);

  useEffect(() => {
    if (opsRoute.name !== "forms" || opsRoute.mode !== "fill" || !opsRoute.formId || !selectedProject) return;
    const template = FORM_TEMPLATES.find((item) => item.id === opsRoute.formId);
    if (!template) return;

    const activeMatchesRoute =
      activeCommissioningSubmission &&
      activeCommissioningSubmission.projectId === selectedProject.id &&
      activeCommissioningSubmission.templateId === template.id;
    if (activeMatchesRoute) return;

    const existing = commissioningSubmissions.find(
      (item) => item.projectId === selectedProject.id && item.templateId === template.id,
    );
    if (existing) {
      openCommissioningSubmission(existing);
      return;
    }

    const created: CommissioningSubmission = {
      id: makeId(),
      projectId: selectedProject.id,
      templateId: template.id,
      templateName: template.name,
      values: buildInitialCommissioningValues(template),
      status: "draft",
      updatedAt: new Date().toISOString(),
      createdBy: currentUser.name,
    };
    setCommissioningSubmissions((prev) => [created, ...prev]);
    openCommissioningSubmission(created);
  }, [
    opsRoute,
    selectedProject,
    commissioningSubmissions,
    activeCommissioningSubmission,
    currentUser.name,
  ]);

  useEffect(() => {
    if (activeModule === "markup-studio") return;
    if (opsRoute.name !== "projects" || opsRoute.section !== "file-open" || !opsRoute.fileId) return;
    const file = projectFiles.find((item) => item.id === opsRoute.fileId);
    if (!file) return;
    if (projectEditorContext?.fileId === file.id) return;
    void openProjectFileInEditor(file);
  }, [activeModule, opsRoute, projectFiles, projectEditorContext]);

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
      if (!authSession) return;
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
            projectId: selectedProjectId || DEFAULT_PROJECTS[0].id,
            name: row.name,
            parentId: row.parent_id,
          }));
          const loadedFiles = (filesRes.data ?? []).map((row) => ({
            id: row.id,
            projectId: selectedProjectId || DEFAULT_PROJECTS[0].id,
            folderId: row.folder_id,
            name: row.name,
            status: row.status,
            updatedAt: row.updated_at,
            uploadedBy: currentUser.name,
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
          projects?: Project[];
          projectMembers?: ProjectMember[];
          projectActivities?: ProjectActivity[];
          projectFileVersions?: ProjectFileVersion[];
          folders?: FolderNode[];
          projectFiles?: ProjectFile[];
          commissioningSubmissions?: CommissioningSubmission[];
        };
        setWorkers(Array.isArray(parsed.workers) ? parsed.workers : []);
        setTimeEntries(Array.isArray(parsed.timeEntries) ? parsed.timeEntries : []);
        setProjects(Array.isArray(parsed.projects) && parsed.projects.length > 0 ? parsed.projects : DEFAULT_PROJECTS);
        setProjectMembers(Array.isArray(parsed.projectMembers) ? parsed.projectMembers : []);
        setProjectActivities(Array.isArray(parsed.projectActivities) ? parsed.projectActivities : []);
        setProjectFileVersions(Array.isArray(parsed.projectFileVersions) ? parsed.projectFileVersions : []);
        const loadedFolders = Array.isArray(parsed.folders)
          ? parsed.folders.map((folder) => ({
              ...folder,
              projectId: (folder as FolderNode).projectId ?? selectedProjectId ?? DEFAULT_PROJECTS[0].id,
            }))
          : [];
        setFolders(loadedFolders);
        setProjectFiles(
          Array.isArray(parsed.projectFiles)
            ? parsed.projectFiles.map((file) => ({
                ...file,
                projectId: (file as ProjectFile).projectId ?? selectedProjectId ?? DEFAULT_PROJECTS[0].id,
                version: (file as ProjectFile).version ?? 1,
                uploadedBy: (file as ProjectFile).uploadedBy ?? currentUser.name,
              }))
            : [],
        );
        setCommissioningSubmissions(Array.isArray(parsed.commissioningSubmissions) ? parsed.commissioningSubmissions : []);
        if (loadedFolders.length > 0) {
          setSelectedFolderId(loadedFolders[0].id);
        }
      } catch {
        // Keep app usable if ops storage was malformed.
      }
    }

    void loadOpsData();
  }, [authSession, currentUser.name, selectedProjectId]);

  useEffect(() => {
    if (!authSession) return;
    if (hasSupabaseConfig && supabase) return;
    try {
      window.localStorage.setItem(
        OPS_STORAGE_KEY,
        JSON.stringify({
          workers,
          timeEntries,
          projects,
          projectMembers,
          projectActivities,
          projectFileVersions,
          folders,
          projectFiles,
          commissioningSubmissions,
        }),
      );
    } catch (error) {
      if (!opsStorageWarnedRef.current) {
        opsStorageWarnedRef.current = true;
        notify(`Local storage is full. Uploaded files still exist in this session only. (${getErrorMessage(error)})`);
      }
    }
  }, [
    authSession,
    workers,
    timeEntries,
    projects,
    projectMembers,
    projectActivities,
    projectFileVersions,
    folders,
    projectFiles,
    commissioningSubmissions,
  ]);

  useEffect(() => {
    if (!authSession || !authWorkerId) return;
    if (authWorker) {
      if (authWorker.name !== currentUser.name || authWorker.role !== "Technician") {
        setWorkers((prev) =>
          prev.map((worker) =>
            worker.id === authWorkerId
              ? {
                  ...worker,
                  name: currentUser.name,
                  role: worker.role || "Technician",
                }
              : worker,
          ),
        );
      }
      return;
    }

    const nextWorker: Worker = {
      id: authWorkerId,
      name: currentUser.name,
      role: "Technician",
    };

    if (hasSupabaseConfig && supabase) {
      let cancelled = false;
      void (async () => {
        try {
          const { error } = await supabase.from("workers").upsert(
            {
              id: nextWorker.id,
              name: nextWorker.name,
              role: nextWorker.role,
            },
            { onConflict: "id" },
          );
          if (error) throw error;
          if (cancelled) return;
          setWorkers((prev) => [nextWorker, ...prev.filter((worker) => worker.id !== nextWorker.id)]);
        } catch (error) {
          if (cancelled) return;
          setWorkers((prev) => [nextWorker, ...prev.filter((worker) => worker.id !== nextWorker.id)]);
          notify(`Could not sync your worker profile to Supabase, using local profile. (${getErrorMessage(error)})`);
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    setWorkers((prev) => [nextWorker, ...prev.filter((worker) => worker.id !== nextWorker.id)]);
  }, [authSession, authWorkerId, authWorker, currentUser.name]);

  useEffect(() => {
    if (!authSession) {
      setShowDailyIntroVideo(false);
      return;
    }
    const identity = authSession.user?.email?.trim().toLowerCase() || authSession.user?.id || currentUser.email.toLowerCase();
    if (!identity) return;
    const todayKey = getLocalDayKey(new Date());
    const storageKey = `${DAILY_INTRO_SEEN_KEY_PREFIX}:${identity}`;
    const seenToday = window.localStorage.getItem(storageKey);
    if (seenToday === todayKey) {
      setShowDailyIntroVideo(false);
      return;
    }
    window.localStorage.setItem(storageKey, todayKey);
    setShowDailyIntroVideo(true);
  }, [authSession, currentUser.email]);

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

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
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

  async function refreshWeatherSnapshot(): Promise<void> {
    if (typeof window === "undefined") return;
    const fallbackCoords = { lat: 51.5072, lng: -0.1276 };
    setWeatherLoading(true);
    setWeatherError("");
    try {
      const coords = await new Promise<{ lat: number; lng: number }>((resolve) => {
        if (!("geolocation" in navigator)) {
          resolve(fallbackCoords);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (position) =>
            resolve({
              lat: position.coords.latitude,
              lng: position.coords.longitude,
            }),
          () => resolve(fallbackCoords),
          { enableHighAccuracy: false, maximumAge: 15 * 60 * 1000, timeout: 4500 },
        );
      });

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Weather fetch failed: ${response.status}`);
      }
      const payload = (await response.json()) as {
        current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
        daily?: {
          temperature_2m_max?: number[];
          temperature_2m_min?: number[];
          precipitation_probability_max?: number[];
        };
      };
      const tempC = payload.current?.temperature_2m;
      if (typeof tempC !== "number") {
        throw new Error("Missing weather temperature data");
      }
      const weatherCode = payload.current?.weather_code ?? 0;
      const windRaw = payload.current?.wind_speed_10m;
      const windMph = typeof windRaw === "number" ? Math.round(windRaw * 0.621371) : null;
      setWeather({
        weatherCode,
        temperatureC: Math.round(tempC),
        condition: weatherCodeToLabel(weatherCode),
        rainChancePct:
          typeof payload.daily?.precipitation_probability_max?.[0] === "number"
            ? Math.round(payload.daily.precipitation_probability_max[0] ?? 0)
            : null,
        windMph,
        highC:
          typeof payload.daily?.temperature_2m_max?.[0] === "number" ? Math.round(payload.daily.temperature_2m_max[0] ?? 0) : null,
        lowC:
          typeof payload.daily?.temperature_2m_min?.[0] === "number" ? Math.round(payload.daily.temperature_2m_min[0] ?? 0) : null,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      setWeatherError("Weather unavailable right now.");
    } finally {
      setWeatherLoading(false);
    }
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
        const fallbackEntry: TimeEntry = {
          id: makeId(),
          workerId,
          action,
          at: new Date().toISOString(),
          note: gpsNote,
        };
        setTimeEntries((prev) => [fallbackEntry, ...prev]);
        notify(
          `Cloud clock event failed (${getErrorMessage(error)}). ` +
            `${worker.name} ${action === "clock_in" ? "clocked in" : "clocked out"} locally instead${
              gps ? ` (GPS ${gps.accuracyM}m)` : ""
            }.`,
        );
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

  async function addFolder(options?: { name?: string; parentId?: string | null }): Promise<void> {
    if (!projectPermission.manageFolders) {
      notify("You do not have permission to manage folders.");
      return;
    }
    const fallbackName = window.prompt("Folder name", "")?.trim() ?? "";
    const preferredName = options?.name ?? newFolderName.trim();
    const name = (preferredName || fallbackName).trim();
    const parentId = options?.parentId ?? selectedFolderId;
    if (!name) {
      notify("Enter folder name.");
      return;
    }
    if (hasSupabaseConfig && supabase) {
      setOpsLoading(true);
      try {
        const { data, error } = await supabase
          .from("folders")
          .insert({ name, parent_id: parentId })
          .select("id,name,parent_id")
          .single();
        if (error) throw error;
        const folder: FolderNode = {
          id: data.id,
          projectId: selectedProjectId,
          name: data.name,
          parentId: data.parent_id,
        };
        setFolders((prev) => [folder, ...prev]);
        setNewFolderName("");
        if (!parentId) {
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
      projectId: selectedProjectId,
      name,
      parentId,
    };
    setFolders((prev) => [folder, ...prev]);
    setNewFolderName("");
    if (!parentId) {
      setSelectedFolderId(folder.id);
    }
    logProjectActivity("folder created", folder.name, selectedProjectId);
  }

  function toggleFolderExpanded(folderId: string): void {
    setExpandedFolderIds((prev) => ({ ...prev, [folderId]: !prev[folderId] }));
  }

  function renameFolder(folderId: string): void {
    if (!projectPermission.manageFolders) {
      notify("You do not have permission to rename folders.");
      return;
    }
    const target = folders.find((folder) => folder.id === folderId);
    if (!target) return;
    const nextName = window.prompt("Rename folder", target.name)?.trim();
    if (!nextName) return;
    setFolders((prev) => prev.map((folder) => (folder.id === folderId ? { ...folder, name: nextName } : folder)));
    logProjectActivity("folder renamed", `${target.name} -> ${nextName}`, selectedProjectId);
  }

  function deleteFolder(folderId: string): void {
    if (!projectPermission.manageFolders) {
      notify("You do not have permission to delete folders.");
      return;
    }
    const target = folders.find((folder) => folder.id === folderId);
    if (!target) return;
    if (!window.confirm(`Delete folder "${target.name}"?`)) return;
    const descendantIds = new Set<string>();
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      descendantIds.add(current);
      for (const child of folders) {
        if (child.parentId === current) {
          queue.push(child.id);
        }
      }
    }
    setFolders((prev) => prev.filter((folder) => !descendantIds.has(folder.id)));
    setProjectFiles((prev) => prev.filter((file) => !file.folderId || !descendantIds.has(file.folderId)));
    if (selectedFolderId && descendantIds.has(selectedFolderId)) {
      setSelectedFolderId(null);
    }
    logProjectActivity("folder deleted", target.name, selectedProjectId);
  }

  function moveFolder(folderId: string): void {
    if (!projectPermission.manageFolders) {
      notify("You do not have permission to move folders.");
      return;
    }
    const target = folders.find((folder) => folder.id === folderId);
    if (!target) return;
    const destinationName = window.prompt("Move folder to parent folder name (leave blank for root):", "");
    if (destinationName === null) return;
    if (!destinationName.trim()) {
      setFolders((prev) => prev.map((folder) => (folder.id === folderId ? { ...folder, parentId: null } : folder)));
      logProjectActivity("folder moved", `${target.name} -> Root`, selectedProjectId);
      return;
    }
    const destination = folders.find(
      (folder) => folder.projectId === selectedProjectId && folder.name.toLowerCase() === destinationName.trim().toLowerCase(),
    );
    if (!destination) {
      notify("Destination folder not found.");
      return;
    }
    setFolders((prev) => prev.map((folder) => (folder.id === folderId ? { ...folder, parentId: destination.id } : folder)));
    logProjectActivity("folder moved", `${target.name} -> ${destination.name}`, selectedProjectId);
  }

  function toProjectSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function logProjectActivity(action: string, item: string, projectId: string): void {
    const entry: ProjectActivity = {
      id: makeId(),
      projectId,
      user: currentUser.name,
      action,
      item,
      at: new Date().toISOString(),
    };
    setProjectActivities((prev) => [entry, ...prev]);
  }

  async function createDefaultProjectFolders(projectId: string): Promise<void> {
    const records = buildDefaultFoldersForProject(projectId);
    setFolders((prev) => [...records, ...prev]);
    if (hasSupabaseConfig && supabase) {
      for (const folder of records) {
        await supabase.from("folders").insert({ id: folder.id, name: folder.name, parent_id: folder.parentId });
      }
    }
  }

  async function addProject(): Promise<void> {
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
      code: newProjectCode.trim() || slug.slice(0, 3).toUpperCase(),
      client: newProjectClient.trim() || "Client",
      manager: newProjectManager.trim() || currentUser.name,
      status: newProjectStatus,
      address: newProjectAddress.trim() || selectedProject?.address || "",
      startDate: newProjectStart || new Date().toISOString().slice(0, 10),
      targetDate: newProjectTarget || "",
      description: newProjectDescription.trim(),
    };
    setProjects((prev) => [project, ...prev]);
    setProjectMembers((prev) => [
      {
        id: makeId(),
        projectId: project.id,
        name: newProjectManager.trim() || currentUser.name,
        email: currentUser.email,
        role: "Owner",
        status: "active",
        dateAdded: new Date().toISOString(),
        permission: OWNER_PERMISSION,
      },
      ...prev,
    ]);
    await createDefaultProjectFolders(project.id);
    setSelectedProjectId(project.id);
    setNewProjectName("");
    setNewProjectCode("");
    setNewProjectClient("");
    setNewProjectAddress("");
    setNewProjectStart("");
    setNewProjectTarget("");
    setNewProjectManager(currentUser.name);
    setNewProjectDescription("");
    setNewProjectStatus("active");
    setShowNewProjectModal(false);
    logProjectActivity("project created", project.name, project.id);
    navigateOps(`/projects/${project.slug}/files`);
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
    override?: {
      name: string;
      mimeType?: string;
      dataUrl?: string;
      uploadedBy?: string;
      fileSize?: number;
      replaceFileId?: string;
      changeNote?: string;
      folderId?: string | null;
    },
  ): Promise<ProjectFile | null> {
    if (!projectPermission.uploadFiles) {
      notify("You do not have permission to upload files.");
      return null;
    }
    const name = (override?.name ?? newFileName).trim();
    const targetFolderId = override?.folderId ?? selectedFolderId;
    if (!name) {
      notify("Enter file name.");
      return null;
    }
    const replaceTarget = override?.replaceFileId ? projectFiles.find((file) => file.id === override.replaceFileId) : null;
    if (replaceTarget) {
      const currentVersion = replaceTarget.version ?? 1;
      const versionEntry: ProjectFileVersion = {
        id: makeId(),
        fileId: replaceTarget.id,
        projectId: selectedProjectId,
        version: currentVersion,
        dataUrl: replaceTarget.dataUrl,
        fileSize: override?.fileSize,
        uploadedBy: replaceTarget.uploadedBy ?? currentUser.name,
        uploadedAt: replaceTarget.updatedAt,
        changeNote: override?.changeNote ?? "Superseded by new version",
      };
      setProjectFileVersions((prev) => [versionEntry, ...prev]);
      setProjectFiles((prev) =>
        prev.map((file) =>
          file.id === replaceTarget.id
            ? {
                ...file,
                name,
                mimeType: override?.mimeType ?? file.mimeType,
                dataUrl: override?.dataUrl ?? file.dataUrl,
                updatedAt: new Date().toISOString(),
                uploadedBy: override?.uploadedBy ?? currentUser.name,
                version: currentVersion + 1,
                status: "Current",
              }
            : file,
        ),
      );
      logProjectActivity("new version uploaded", name, selectedProjectId);
      notify(`Uploaded v${currentVersion + 1} for ${name}.`);
      return {
        ...replaceTarget,
        name,
        mimeType: override?.mimeType ?? replaceTarget.mimeType,
        dataUrl: override?.dataUrl ?? replaceTarget.dataUrl,
        updatedAt: new Date().toISOString(),
        uploadedBy: override?.uploadedBy ?? currentUser.name,
        version: currentVersion + 1,
        status: "Current",
      };
    }

    if (hasSupabaseConfig && supabase) {
      setOpsLoading(true);
      try {
        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("project_files")
          .insert({
            folder_id: targetFolderId,
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
          uploadedBy: override?.uploadedBy ?? currentUser.name,
          version: 1,
        };
        setProjectFiles((prev) => [file, ...prev]);
        setNewFileName("");
        logProjectActivity("file uploaded", file.name, selectedProjectId);
        notify(`Added file ${file.name}.`);
        return file;
      } catch (error) {
        const fallbackFile: ProjectFile = {
          id: makeId(),
          projectId: selectedProjectId,
          folderId: targetFolderId,
          name,
          updatedAt: new Date().toISOString(),
          status: "Draft",
          mimeType: override?.mimeType,
          dataUrl: override?.dataUrl,
          uploadedBy: override?.uploadedBy ?? currentUser.name,
          version: 1,
        };
        setProjectFiles((prev) => [fallbackFile, ...prev]);
        setNewFileName("");
        logProjectActivity("file uploaded", fallbackFile.name, selectedProjectId);
        notify(
          `Cloud upload unavailable (${error instanceof Error ? error.message : String(error)}). ` +
            `File saved locally for this session.`,
        );
        return fallbackFile;
      } finally {
        setOpsLoading(false);
      }
      return null;
    }
    const file: ProjectFile = {
      id: makeId(),
      projectId: selectedProjectId,
      folderId: targetFolderId,
      name,
      updatedAt: new Date().toISOString(),
      status: "Draft",
      mimeType: override?.mimeType,
      dataUrl: override?.dataUrl,
      uploadedBy: override?.uploadedBy ?? currentUser.name,
      version: 1,
    };
    setProjectFiles((prev) => [file, ...prev]);
    setNewFileName("");
    logProjectActivity("file uploaded", file.name, selectedProjectId);
    notify(`Added file ${file.name}.`);
    return file;
  }

  function getProjectFormsFolderId(projectId: string): string | null {
    const preferred = folders.find(
      (folder) =>
        folder.projectId === projectId &&
        folder.parentId === null &&
        folder.name.trim().toLowerCase() === "06_forms",
    );
    if (preferred) return preferred.id;
    const fallback = folders.find(
      (folder) => folder.projectId === projectId && folder.name.toLowerCase().includes("form"),
    );
    return fallback?.id ?? null;
  }

  function makeUniqueProjectFileName(baseName: string, projectId: string): string {
    const normalizedBase = baseName.trim() || "Form.pdf";
    if (!projectFiles.some((file) => file.projectId === projectId && file.name.toLowerCase() === normalizedBase.toLowerCase())) {
      return normalizedBase;
    }
    const extensionIndex = normalizedBase.lastIndexOf(".");
    const namePart = extensionIndex > 0 ? normalizedBase.slice(0, extensionIndex) : normalizedBase;
    const extPart = extensionIndex > 0 ? normalizedBase.slice(extensionIndex) : "";
    let index = 2;
    while (true) {
      const candidate = `${namePart} (${index})${extPart}`;
      const exists = projectFiles.some((file) => file.projectId === projectId && file.name.toLowerCase() === candidate.toLowerCase());
      if (!exists) return candidate;
      index += 1;
    }
  }

  function getTemplateSections(templateId: string): CommissioningSection[] {
    return COMMISSIONING_TEMPLATE_SECTIONS[templateId] ?? [];
  }

  function buildInitialCommissioningValues(template: FormTemplate): Record<string, string> {
    const values: Record<string, string> = {};
    for (const section of getTemplateSections(template.id)) {
      for (const field of section.fields) {
        values[field.id] = "";
      }
    }
    values.project = selectedProject?.name ?? "";
    values["site-address"] = selectedProject?.address ?? "";
    values["lac-ref"] = selectedProject?.code ?? "";
    values["test-engineer"] = currentUser.name;
    values["commissioning-engineer"] = currentUser.name;
    values["test-date"] = new Date().toISOString().slice(0, 10);
    return values;
  }

  function openCommissioningSubmission(submission: CommissioningSubmission): void {
    setActiveCommissioningSubmissionId(submission.id);
    setActiveFormId(submission.templateId);
    setActiveCommissioningValues(submission.values);
  }

  function saveCommissioningSubmission(status: "draft" | "completed" = "draft"): CommissioningSubmission | null {
    if (!activeCommissioningSubmissionId || !activeFormId) {
      notify("Start a commissioning form first.");
      return null;
    }
    const template = FORM_TEMPLATES.find((item) => item.id === activeFormId);
    if (!template) {
      notify("Template not found.");
      return null;
    }
    const submission: CommissioningSubmission = {
      id: activeCommissioningSubmissionId,
      projectId: selectedProjectId,
      templateId: activeFormId,
      templateName: template.name,
      values: activeCommissioningValues,
      status,
      updatedAt: new Date().toISOString(),
      createdBy: currentUser.name,
    };
    setCommissioningSubmissions((prev) => {
      const idx = prev.findIndex((item) => item.id === submission.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = submission;
        return next;
      }
      return [submission, ...prev];
    });
    if (status === "completed") {
      setCompletedFormIds((prev) => (prev.includes(activeFormId) ? prev : [...prev, activeFormId]));
    }
    return submission;
  }

  async function downloadFormTemplate(template: FormTemplate): Promise<void> {
    try {
      const response = await fetch(template.assetPath);
      if (!response.ok) throw new Error(`Template fetch failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      downloadBlob(new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }), template.fileName);
      notify(`Downloaded template ${template.name}.`);
    } catch (error) {
      notify(`Could not download template: ${getErrorMessage(error)}`);
    }
  }

  async function startProjectFormFromTemplate(template: FormTemplate): Promise<void> {
    if (!selectedProject) return;
    const submission: CommissioningSubmission = {
      id: makeId(),
      projectId: selectedProject.id,
      templateId: template.id,
      templateName: template.name,
      values: buildInitialCommissioningValues(template),
      status: "draft",
      updatedAt: new Date().toISOString(),
      createdBy: currentUser.name,
    };
    setCommissioningSubmissions((prev) => [submission, ...prev]);
    openCommissioningSubmission(submission);
    notify(`Started ${template.name} form.`);
    navigateOps(`/forms/${template.id}/fill`);
  }

  async function exportCommissioningSubmission(submission: CommissioningSubmission): Promise<void> {
    const template = FORM_TEMPLATES.find((item) => item.id === submission.templateId);
    if (!template) {
      notify("Template not found.");
      return;
    }

    const pdf = await PDFDocument.create();
    const pageWidth = 595;
    const pageHeight = 842;
    const margin = 28;
    const contentWidth = pageWidth - margin * 2;
    const labelWidth = 190;
    const valueWidth = contentWidth - labelWidth - 14;
    const headerHeight = 72;

    function wrapText(input: string, maxChars = 62): string[] {
      const source = input.trim();
      if (!source) return ["-"];
      const words = source.split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length <= maxChars) {
          line = next;
          continue;
        }
        if (line) lines.push(line);
        line = word;
      }
      if (line) lines.push(line);
      return lines.length > 0 ? lines : ["-"];
    }

    let pageNumber = 1;
    let page = pdf.addPage([pageWidth, pageHeight]);

    const drawLondonAcLogo = (targetPage: typeof page, x: number, y: number): void => {
      targetPage.drawText("LONDON", { x, y, size: 18, color: rgb(0.97, 0.99, 1) });
      targetPage.drawRectangle({ x, y: y - 3, width: 98, height: 2, color: rgb(0.97, 0.99, 1) });
      targetPage.drawText("AC LTD", { x: x + 58, y: y - 16, size: 8, color: rgb(0.9, 0.95, 1) });
    };

    const drawHeader = (targetPage: typeof page): number => {
      const topY = pageHeight - margin;
      const headerBottom = topY - headerHeight;
      targetPage.drawRectangle({
        x: margin,
        y: headerBottom,
        width: contentWidth,
        height: headerHeight,
        color: rgb(0.08, 0.18, 0.33),
      });
      targetPage.drawText("London AC Ltd - Commissioning Form", {
        x: margin + 12,
        y: headerBottom + 46,
        size: 13,
        color: rgb(1, 1, 1),
      });
      targetPage.drawText(template.name, {
        x: margin + 12,
        y: headerBottom + 29,
        size: 11,
        color: rgb(0.85, 0.91, 1),
      });
      targetPage.drawText(`Project: ${selectedProject?.name ?? submission.values.project ?? "-"}`, {
        x: margin + 12,
        y: headerBottom + 14,
        size: 9,
        color: rgb(0.95, 0.97, 1),
      });
      targetPage.drawText(`Updated: ${formatDateTimeUk(submission.updatedAt)}`, {
        x: margin + 290,
        y: headerBottom + 14,
        size: 9,
        color: rgb(0.95, 0.97, 1),
      });
      targetPage.drawText(`Page ${pageNumber}`, {
        x: pageWidth - margin - 52,
        y: headerBottom + 14,
        size: 9,
        color: rgb(0.95, 0.97, 1),
      });
      drawLondonAcLogo(targetPage, pageWidth - margin - 106, headerBottom + 42);
      return headerBottom - 16;
    };

    const addNewPage = (): number => {
      page = pdf.addPage([pageWidth, pageHeight]);
      pageNumber += 1;
      return drawHeader(page);
    };

    let y = drawHeader(page);

    for (const section of getTemplateSections(submission.templateId)) {
      const estimatedSectionHeight = 28 + section.fields.length * 30;
      if (y - estimatedSectionHeight < margin + 26) {
        y = addNewPage();
      }

      page.drawRectangle({
        x: margin,
        y: y - 20,
        width: contentWidth,
        height: 22,
        color: rgb(0.86, 0.91, 0.98),
      });
      page.drawText(section.title, {
        x: margin + 8,
        y: y - 13,
        size: 11,
        color: rgb(0.08, 0.16, 0.29),
      });
      y -= 28;

      for (const field of section.fields) {
        const rawValue = submission.values[field.id] ?? "";
        const fieldValue =
          field.type === "checkbox" ? (rawValue === "true" ? "Yes" : "No") : rawValue || "-";
        const valueLines = wrapText(String(fieldValue), field.type === "textarea" ? 60 : 68);
        const rowHeight = Math.max(24, valueLines.length * 12 + 10);

        if (y - rowHeight < margin + 20) {
          y = addNewPage();
        }

        page.drawRectangle({
          x: margin,
          y: y - rowHeight,
          width: contentWidth,
          height: rowHeight,
          borderColor: rgb(0.84, 0.88, 0.95),
          borderWidth: 1,
          color: rgb(0.98, 0.99, 1),
        });
        page.drawText(field.label, {
          x: margin + 8,
          y: y - 15,
          size: 9,
          color: rgb(0.2, 0.28, 0.39),
        });

        let lineY = y - 15;
        for (const line of valueLines) {
          page.drawText(line, {
            x: margin + labelWidth,
            y: lineY,
            size: 9,
            color: rgb(0.05, 0.11, 0.2),
            maxWidth: valueWidth,
          });
          lineY -= 11;
        }

        y -= rowHeight + 6;
      }
      y -= 4;
    }

    const bytes = await pdf.save();
    const safeBytes = Uint8Array.from(bytes);
    const exportName = makeUniqueProjectFileName(`${template.name} - Completed.pdf`, submission.projectId);
    const formsFolderId = getProjectFormsFolderId(submission.projectId);
    await addProjectFile({
      name: exportName,
      mimeType: "application/pdf",
      dataUrl: `data:application/pdf;base64,${bytesToBase64(safeBytes)}`,
      uploadedBy: currentUser.name,
      fileSize: safeBytes.byteLength,
      folderId: formsFolderId,
    });
    downloadBlob(new Blob([toArrayBuffer(safeBytes)], { type: "application/pdf" }), exportName);
    notify(`Exported ${template.name}.`);
  }

  async function handleProjectFileUpload(files: FileList | File[] | null, targetFileId?: string): Promise<void> {
    if (!files || files.length === 0) return;
    if (!projectPermission.uploadFiles) {
      notify("You do not have permission to upload files.");
      return;
    }
    const queue = Array.from(files);
    notify(`Uploading ${queue.length} file${queue.length === 1 ? "" : "s"}...`);
    let uploadedCount = 0;
    for (const file of queue) {
      try {
        const dataUrl = await fileToDataUrl(file);
        const existing =
          (targetFileId ? projectFiles.find((fileItem) => fileItem.id === targetFileId) : null) ??
          projectFiles.find(
          (projectFile) =>
            projectFile.projectId === selectedProjectId &&
            projectFile.folderId === selectedFolderId &&
            projectFile.name.toLowerCase() === file.name.toLowerCase(),
        );
        if (existing) {
          const mode = window.prompt(
            `A file named "${file.name}" already exists.\nType "version" to upload a new version, "keep" to keep both, or "cancel".`,
            "version",
          );
          if (mode === null || mode.toLowerCase() === "cancel") {
            continue;
          }
          if (mode.toLowerCase() === "version") {
            await addProjectFile({
              name: file.name,
              mimeType: file.type || "application/octet-stream",
              dataUrl,
              uploadedBy: currentUser.name,
              fileSize: file.size,
              replaceFileId: existing.id,
              changeNote: "Uploaded from files workspace",
            });
            continue;
          }
          if (mode.toLowerCase() !== "keep") {
            notify(`Skipped ${file.name}.`);
            continue;
          }
        }
        await addProjectFile({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          dataUrl,
          uploadedBy: currentUser.name,
          fileSize: file.size,
        });
        uploadedCount += 1;
      } catch (error) {
        notify(`Upload failed: ${getErrorMessage(error)}`);
      }
    }
    setVersionUploadTargetId(null);
    if (uploadedCount > 0) {
      notify(`Uploaded ${uploadedCount} file${uploadedCount === 1 ? "" : "s"} successfully.`);
    }
  }

  function deleteProjectFile(fileId: string): void {
    if (!projectPermission.deleteFiles) {
      notify("You do not have permission to delete files.");
      return;
    }
    const file = projectFiles.find((item) => item.id === fileId);
    setProjectFiles((prev) => prev.filter((item) => item.id !== fileId));
    if (selectedProjectFileId === fileId) {
      setSelectedProjectFileId(null);
    }
    if (file) logProjectActivity("file deleted", file.name, selectedProjectId);
    notify(file ? `Deleted ${file.name}.` : "File deleted.");
  }

  function renameProjectFile(fileId: string): void {
    if (!projectPermission.editFiles) {
      notify("You do not have permission to rename files.");
      return;
    }
    const file = projectFiles.find((item) => item.id === fileId);
    if (!file) return;
    const nextName = window.prompt("Rename file", file.name)?.trim();
    if (!nextName) return;
    setProjectFiles((prev) => prev.map((item) => (item.id === fileId ? { ...item, name: nextName, updatedAt: new Date().toISOString() } : item)));
    logProjectActivity("file renamed", `${file.name} -> ${nextName}`, selectedProjectId);
  }

  function moveProjectFile(fileId: string): void {
    if (!projectPermission.editFiles) {
      notify("You do not have permission to move files.");
      return;
    }
    const file = projectFiles.find((item) => item.id === fileId);
    if (!file) return;
    const destinationName = window.prompt("Move to folder name", "");
    if (destinationName === null) return;
    const destination = folders.find(
      (folder) => folder.projectId === selectedProjectId && folder.name.toLowerCase() === destinationName.trim().toLowerCase(),
    );
    if (!destination && destinationName.trim()) {
      notify("Destination folder not found.");
      return;
    }
    setProjectFiles((prev) =>
      prev.map((item) =>
        item.id === fileId
          ? { ...item, folderId: destination?.id ?? null, updatedAt: new Date().toISOString() }
          : item,
      ),
    );
    logProjectActivity("file moved", `${file.name} -> ${destination?.name ?? "Root"}`, selectedProjectId);
  }

  function copyProjectFile(fileId: string): void {
    const file = projectFiles.find((item) => item.id === fileId);
    if (!file) return;
    const copy: ProjectFile = {
      ...file,
      id: makeId(),
      name: `${file.name.replace(/(\.[^.]+)?$/, " (Copy)$1")}`,
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    setProjectFiles((prev) => [copy, ...prev]);
    logProjectActivity("file copied", file.name, selectedProjectId);
  }

  function downloadProjectFile(file: ProjectFile): void {
    if (!file.dataUrl) {
      notify("No file content is available for download yet.");
      return;
    }
    const bytes = dataUrlToBytes(file.dataUrl);
    const blob = new Blob([toArrayBuffer(bytes)], { type: file.mimeType ?? "application/octet-stream" });
    downloadBlob(blob, file.name);
    logProjectActivity("file downloaded", file.name, selectedProjectId);
  }

  async function openProjectFileInEditor(file: ProjectFile): Promise<void> {
    if (!projectPermission.usePdfMarkup) {
      notify("You do not have permission to use PDF markup.");
      return;
    }
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
    setProjectEditorContext({
      projectId: selectedProjectId,
      fileId: file.id,
      fileName: file.name,
    });
    setActiveModule("markup-studio");
    await handlePdfFile(drawingFile);
    logProjectActivity("open in pdf editor", file.name, selectedProjectId);
    notify(`Opened ${file.name} in PDF editor.`);
  }

  async function openProjectFileFullView(file: ProjectFile, projectSlug: string): Promise<void> {
    if (!projectPermission.usePdfMarkup) {
      notify("You do not have permission to use PDF markup.");
      return;
    }
    setProjectEditorContext({
      projectId: selectedProjectId,
      fileId: file.id,
      fileName: file.name,
    });
    const targetPath = `/projects/${projectSlug}/files/${encodeURIComponent(file.id)}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, "", targetPath);
    }
    setOpsPathname(targetPath);
    await openProjectFileInEditor(file);
  }

  async function saveCurrentMarkupStudioToProject(): Promise<boolean> {
    if (!projectEditorContext) return false;
    const bytes = await buildFlattenedPdfBytes();
    if (!bytes) {
      notify("Open a PDF before saving.");
      return true;
    }
    const fileId = projectEditorContext.fileId;
    const target = projectFiles.find((item) => item.id === fileId);
    if (!target) {
      notify("Project file record was not found.");
      return true;
    }
    const currentVersion = target.version ?? 1;
    const nextDataUrl = `data:application/pdf;base64,${bytesToBase64(bytes)}`;
    setProjectFileVersions((prev) => [
      {
        id: makeId(),
        fileId,
        projectId: projectEditorContext.projectId,
        version: currentVersion,
        dataUrl: target.dataUrl,
        uploadedBy: target.uploadedBy ?? currentUser.name,
        uploadedAt: target.updatedAt,
        changeNote: "Before markup save from full editor",
      },
      ...prev,
    ]);
    setProjectFiles((prev) =>
      prev.map((item) =>
        item.id === fileId
          ? {
              ...item,
              dataUrl: nextDataUrl,
              updatedAt: new Date().toISOString(),
              version: currentVersion + 1,
              status: "Marked Up",
              annotations: {
                schemaVersion: 1,
                annotations,
              },
              uploadedBy: currentUser.name,
            }
          : item,
      ),
    );
    setOpenFileNeedsSaveWarning(false);
    logProjectActivity("markup saved", target.name, projectEditorContext.projectId);
    notify(`Saved ${target.name} back to project (v${currentVersion + 1}).`);
    return true;
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

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!supabase || !hasSupabaseConfig) {
      setAuthMessage("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
      return;
    }
    const email = authEmail.trim().toLowerCase();
    if (!email) {
      setAuthMessage("Enter your email address.");
      return;
    }

    if (authMode === "forgot") {
      setAuthBusy(true);
      setAuthMessage("");
      try {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/`,
        });
        if (error) throw error;
        setAuthMessage("Password reset link sent. Check your email inbox.");
      } catch (error) {
        setAuthMessage(`Password reset failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    if (authPassword.length < 8) {
      setAuthMessage("Password must be at least 8 characters.");
      return;
    }

    if (authMode === "signup" || authMode === "reset") {
      if (authPassword !== authConfirmPassword) {
        setAuthMessage("Passwords do not match.");
        return;
      }
    }

    setAuthBusy(true);
    setAuthMessage("");
    try {
      if (authMode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
        if (error) throw error;
        setAuthPassword("");
        setAuthConfirmPassword("");
        return;
      }

      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: authPassword,
          options: {
            data: {
              full_name: email === OWNER_EMAIL ? "Andy Bird" : undefined,
            },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setAuthMessage("Account created. Check your email to confirm before signing in.");
          setAuthMode("login");
        } else {
          setAuthMessage("Account created and signed in.");
        }
        setAuthPassword("");
        setAuthConfirmPassword("");
        return;
      }

      const { error } = await supabase.auth.updateUser({ password: authPassword });
      if (error) throw error;
      setAuthMessage("Password updated. You are now signed in.");
      setAuthMode("login");
      setAuthPassword("");
      setAuthConfirmPassword("");
    } catch (error) {
      setAuthMessage(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    if (!supabase || !hasSupabaseConfig) return;
    setAuthBusy(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setAuthBusy(false);
    }
  }

  async function runAuthDiagnostics(): Promise<void> {
    const urlRaw = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
    const keyRaw = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
    const lines: string[] = [];
    lines.push(`Time: ${new Date().toISOString()}`);
    lines.push(`Origin: ${window.location.origin}`);
    lines.push(`Supabase URL present: ${urlRaw.length > 0 ? "yes" : "no"}`);
    lines.push(`Supabase anon key present: ${keyRaw.length > 0 ? "yes" : "no"}`);
    lines.push(`Supabase anon key length: ${keyRaw.length}`);
    if (keyRaw.length > 12) {
      lines.push(`Supabase anon key preview: ${keyRaw.slice(0, 12)}...${keyRaw.slice(-6)}`);
    }

    if (!urlRaw || !keyRaw) {
      lines.push("Result: missing environment values.");
      setAuthDiagnosticsOutput(lines.join("\n"));
      return;
    }

    let normalizedUrl = "";
    try {
      normalizedUrl = new URL(urlRaw).toString().replace(/\/$/, "");
      lines.push(`Supabase URL valid: yes (${normalizedUrl})`);
    } catch (error) {
      lines.push(`Supabase URL valid: no (${error instanceof Error ? error.message : String(error)})`);
      setAuthDiagnosticsOutput(lines.join("\n"));
      return;
    }

    setAuthDiagnosticsBusy(true);
    try {
      try {
        const noKeyResponse = await fetch(`${normalizedUrl}/auth/v1/settings`, { method: "GET" });
        lines.push(`GET /auth/v1/settings (no key): HTTP ${noKeyResponse.status}`);
      } catch (error) {
        lines.push(`GET /auth/v1/settings (no key): NETWORK ERROR (${error instanceof Error ? error.message : String(error)})`);
      }

      try {
        const withKeyResponse = await fetch(`${normalizedUrl}/auth/v1/settings`, {
          method: "GET",
          headers: {
            apikey: keyRaw,
          },
        });
        lines.push(`GET /auth/v1/settings (with key): HTTP ${withKeyResponse.status}`);
      } catch (error) {
        lines.push(`GET /auth/v1/settings (with key): NETWORK ERROR (${error instanceof Error ? error.message : String(error)})`);
      }

      try {
        const probeEmail = `diagnostic-${Date.now()}@example.invalid`;
        const probeResponse = await fetch(`${normalizedUrl}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: {
            apikey: keyRaw,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: probeEmail,
            password: "not-a-real-password",
          }),
        });
        lines.push(`POST /auth/v1/token probe: HTTP ${probeResponse.status}`);
        let bodySnippet = "";
        try {
          bodySnippet = await probeResponse.text();
        } catch {
          bodySnippet = "";
        }
        if (bodySnippet) {
          lines.push(`Probe response snippet: ${bodySnippet.slice(0, 220)}`);
        }
      } catch (error) {
        lines.push(`POST /auth/v1/token probe: NETWORK ERROR (${error instanceof Error ? error.message : String(error)})`);
      }
    } finally {
      setAuthDiagnosticsBusy(false);
      setAuthDiagnosticsOutput(lines.join("\n"));
    }
  }

  function navigateOps(path: string): void {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setOpsPathname(path);
    setProjectEditorContext(null);
    setActiveModule("operations");
  }

  function leaveOpenFileView(projectSlug: string): void {
    if (openFileNeedsSaveWarning) {
      const confirmed = window.confirm("If you go back now, unsaved changes may be lost. Continue?");
      if (!confirmed) return;
    }
    navigateOps(`/projects/${projectSlug}/files`);
  }

  function exitProjectMarkupStudio(): void {
    if (openFileNeedsSaveWarning) {
      const confirmed = window.confirm("If you go back now, unsaved changes may be lost. Continue?");
      if (!confirmed) return;
    }
    if (!projectEditorContext) {
      navigateOps("/projects");
      return;
    }
    const project = projects.find((item) => item.id === projectEditorContext.projectId);
    if (project) {
      setSelectedProjectId(project.id);
      setSelectedProjectFileId(projectEditorContext.fileId);
      navigateOps(`/projects/${project.slug}/files`);
      return;
    }
    navigateOps("/projects");
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
      const savedToProject = await saveCurrentMarkupStudioToProject();
      if (savedToProject) {
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
      if (projectEditorContext) {
        const saveAsName = window.prompt("Save As file name", `${pdfName.replace(/\.pdf$/i, "")}-copy.pdf`)?.trim();
        if (!saveAsName) return;
        await addProjectFile({
          name: saveAsName.toLowerCase().endsWith(".pdf") ? saveAsName : `${saveAsName}.pdf`,
          mimeType: "application/pdf",
          dataUrl: `data:application/pdf;base64,${bytesToBase64(bytes)}`,
          uploadedBy: currentUser.name,
          fileSize: bytes.byteLength,
        });
        notify("Saved As new project PDF.");
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
    const selectedWorker = authWorker;
    const availableForms = FORM_TEMPLATES.filter((form) => !completedFormIds.includes(form.id));
    const signedInWorkers = workers
      .map((worker) => ({
        worker,
        lastEntry: latestEntryByWorker[worker.id],
      }))
      .filter((item) => item.lastEntry?.action === "clock_in");
    const activeNav = route.name === "projects" ? "projects" : route.name === "timesheets" ? "timesheets" : route.name === "forms" ? "forms" : "home";

    const navItems = [
      { key: "home", label: "Home", path: "/home" },
      { key: "projects", label: "Projects", path: "/projects" },
      { key: "timesheets", label: "Timesheets", path: "/timesheets" },
      { key: "forms", label: "Forms", path: "/forms" },
      { key: "more", label: "More", path: "/sign-out" },
    ] as const;

    const mapEmbedUrl = toMapEmbedUrl(liveGps);
    const mapLinkUrl = liveGps
      ? `https://www.openstreetmap.org/?mlat=${liveGps.lat}&mlon=${liveGps.lng}#map=18/${liveGps.lat}/${liveGps.lng}`
      : "https://www.openstreetmap.org";

    let pageTitle = "Operations Home";
    let pageSubtitle = "Choose where you want to go";
    let content: ReactElement = <div />;

    if (route.name === "home") {
      pageTitle = "Operations Home";
      pageSubtitle = "Choose a module";
      const now = new Date();
      const greeting = getGreetingForHour(now.getHours());
      const weatherIcon = weather ? weatherCodeToIcon(weather.weatherCode) : "⛅";
      content = (
        <div className="opsHomeStack">
          <section className="opsWeatherWidget">
            <div className="opsWeatherLeft">
              <div className="opsWeatherPrimary">
                <p>
                  {greeting}, {currentUser.name}
                </p>
                <strong>{formatTimeUk(now)}</strong>
                <span>{formatLongDateUk(now)}</span>
              </div>
              <div className="opsWeatherStats">
                <div className="opsWeatherMetric">
                  <strong>{weather ? `${weather.temperatureC}°C` : "—"}</strong>
                  <span>Temperature</span>
                </div>
                <div className="opsWeatherMetric">
                  <strong>{weather?.rainChancePct != null ? `${weather.rainChancePct}%` : "—"}</strong>
                  <span>Chance of rain</span>
                </div>
                <div className="opsWeatherMetric">
                  <strong>{weather?.windMph != null ? `${weather.windMph} mph` : "—"}</strong>
                  <span>Wind</span>
                </div>
              </div>
            </div>
            <div className="opsWeatherRight">
              <div className="opsWeatherVisual" aria-hidden="true">
                {weatherIcon}
              </div>
              <strong>{weatherLoading ? "Loading weather…" : weather?.condition ?? "Weather unavailable"}</strong>
              <span>{weather && weather.highC != null && weather.lowC != null ? `High ${weather.highC}° • Low ${weather.lowC}°` : " "}</span>
            </div>
            <small className="opsSubtle">
              {weatherError || (weather?.updatedAt ? `Updated ${formatTimeUk(weather.updatedAt)}` : "Weather refreshes automatically on this page.")}
            </small>
          </section>
          <div className="opsLandingTiles">
            <button type="button" className="opsLandingTile" onClick={() => navigateOps("/sign-in")}>
              <strong>Clock In / Out</strong>
              <span>Open GPS attendance</span>
            </button>
            <button type="button" className="opsLandingTile" onClick={() => navigateOps("/projects")}>
              <strong>Projects</strong>
              <span>Open project overview</span>
            </button>
            <button type="button" className="opsLandingTile" onClick={() => navigateOps("/timesheets")}>
              <strong>My Timesheet</strong>
              <span>Open your timesheet summary</span>
            </button>
          </div>
        </div>
      );
    } else if (route.name === "sign-out") {
      pageTitle = "GPS Sign Out";
      pageSubtitle = "Securely sign yourself out from the selected project";
      content = (
        <div className="opsSignOutGrid">
          <section className="opsPanel">
            <div className="opsInline opsClockToggle">
              <button type="button" onClick={() => navigateOps("/sign-in")}>
                Clock In
              </button>
              <button type="button" className="active" onClick={() => navigateOps("/sign-out")}>
                Clock Out
              </button>
            </div>
            <h3>Project and location</h3>
            <div className="opsFields">
              <label>
                Project selector
                <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name} ({project.code})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Site address
                <input type="text" value={selectedProject?.address ?? "No site address set for this project"} readOnly />
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
            <h3>Your current sign-in status</h3>
            <div className="opsList">
              {!selectedWorker ? (
                <p>Preparing your worker profile…</p>
              ) : latestEntryByWorker[selectedWorker.id]?.action !== "clock_in" ? (
                <p>You are not currently signed in.</p>
              ) : (
                (() => {
                  const lastEntry = latestEntryByWorker[selectedWorker.id];
                  const signedAt = lastEntry ? new Date(lastEntry.at) : null;
                  const elapsedMinutes = signedAt ? Math.max(0, Math.round((Date.now() - signedAt.getTime()) / 60000)) : 0;
                  const gps = parseGpsNote(lastEntry?.note);
                  return (
                    <div key={selectedWorker.id} className="opsListRow">
                      <div>
                        <strong>{selectedWorker.name}</strong>
                        <small>Signed in: {signedAt ? formatDateTimeUk(signedAt) : "-"}</small>
                        <small>Duration: {formatMinutes(elapsedMinutes)}</small>
                        <small>{gps ? `GPS ${gps.accuracyM}m` : "GPS unavailable"}</small>
                      </div>
                      <button
                        type="button"
                        className="btnWarning"
                        disabled={opsLoading}
                        onClick={() => {
                          void addTimeEntry(selectedWorker.id, "clock_out");
                        }}
                      >
                        Sign Out
                      </button>
                    </div>
                  );
                })()
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
                    <td>{selectedProject?.name ?? "-"}</td>
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
      if (!route.projectId) {
        pageTitle = "Projects";
        pageSubtitle = "Manage projects, create new workspaces and open project document hubs.";
        content = (
          <div className="opsProjectsListLayout">
            <section className="opsPanel">
              <div className="opsInline">
                <input
                  type="text"
                  placeholder="Search projects..."
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                />
                <select value={projectStatusFilter} onChange={(event) => setProjectStatusFilter(event.target.value as Project["status"] | "all")}>
                  <option value="all">All</option>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="on_hold">On hold</option>
                  <option value="archived">Archived</option>
                </select>
                <button type="button" className="btnWarning" onClick={() => setShowNewProjectModal(true)}>
                  New Project
                </button>
              </div>
            </section>

            <section className="opsPanel">
              <div className="opsProjectTable">
                <div className="opsProjectTableHead">
                  <span>Project</span>
                  <span>Client</span>
                  <span>Code</span>
                  <span>Address</span>
                  <span>Manager</span>
                  <span>Status</span>
                  <span>Last activity</span>
                  <span>Files</span>
                  <span>Team</span>
                </div>
                {filteredProjects.map((project) => {
                  const filesCount = projectFiles.filter((file) => file.projectId === project.id).length;
                  const teamCount = projectMembers.filter((member) => member.projectId === project.id).length;
                  const lastActivity = projectActivities.find((activity) => activity.projectId === project.id);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className="opsProjectTableRow"
                      onClick={() => {
                        setSelectedProjectId(project.id);
                        navigateOps(`/projects/${project.slug}/files`);
                      }}
                    >
                      <span className="opsProjectCell opsProjectCellProject" data-label="Project">
                        {project.name}
                      </span>
                      <span className="opsProjectCell" data-label="Client">
                        {project.client}
                      </span>
                      <span className="opsProjectCell" data-label="Code">
                        {project.code}
                      </span>
                      <span className="opsProjectCell" data-label="Address">
                        {project.address}
                      </span>
                      <span className="opsProjectCell" data-label="Manager">
                        {project.manager}
                      </span>
                      <span className="opsProjectCell" data-label="Status">
                        {project.status}
                      </span>
                      <span className="opsProjectCell" data-label="Last activity">
                        {lastActivity ? formatDateTimeUk(lastActivity.at) : "-"}
                      </span>
                      <span className="opsProjectCell" data-label="Files">
                        {filesCount}
                      </span>
                      <span className="opsProjectCell" data-label="Team">
                        {teamCount}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {showNewProjectModal ? (
              <section className="opsModalBackdrop" onClick={() => setShowNewProjectModal(false)}>
                <div className="opsModalCard" onClick={(event) => event.stopPropagation()}>
                  <h3>New Project</h3>
                  <div className="opsFields">
                    <label>
                      Project name
                      <input type="text" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} />
                    </label>
                    <label>
                      Project code
                      <input type="text" value={newProjectCode} onChange={(event) => setNewProjectCode(event.target.value)} />
                    </label>
                    <label>
                      Client
                      <input type="text" value={newProjectClient} onChange={(event) => setNewProjectClient(event.target.value)} />
                    </label>
                    <label>
                      Site address
                      <input type="text" value={newProjectAddress} onChange={(event) => setNewProjectAddress(event.target.value)} />
                    </label>
                    <label>
                      Start date
                      <input type="date" value={newProjectStart} onChange={(event) => setNewProjectStart(event.target.value)} />
                    </label>
                    <label>
                      Target completion date
                      <input type="date" value={newProjectTarget} onChange={(event) => setNewProjectTarget(event.target.value)} />
                    </label>
                    <label>
                      Project manager
                      <input type="text" value={newProjectManager} onChange={(event) => setNewProjectManager(event.target.value)} />
                    </label>
                    <label>
                      Description
                      <input type="text" value={newProjectDescription} onChange={(event) => setNewProjectDescription(event.target.value)} />
                    </label>
                    <label>
                      Status
                      <select value={newProjectStatus} onChange={(event) => setNewProjectStatus(event.target.value as Project["status"])}>
                        <option value="active">Active</option>
                        <option value="on_hold">On Hold</option>
                        <option value="completed">Completed</option>
                        <option value="archived">Archived</option>
                      </select>
                    </label>
                  </div>
                  <div className="opsInline">
                    <button type="button" onClick={() => void addProject()}>
                      Save Project
                    </button>
                    <button type="button" onClick={() => setShowNewProjectModal(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        );
      } else {
        const workspaceProject = projects.find((project) => project.slug === route.projectId) ?? selectedProject;
        const workspaceProjectId = workspaceProject?.id ?? selectedProjectId;
        const workspaceFolders = folders.filter((folder) => folder.projectId === workspaceProjectId);
        const workspaceFormsFolderIds = workspaceFolders
          .filter((folder) => folder.name.toLowerCase().includes("form"))
          .map((folder) => folder.id);
        const projectFormFiles = projectFiles
          .filter((file) => {
            if (file.projectId !== workspaceProjectId) return false;
            if (file.mimeType && !file.mimeType.includes("pdf")) return false;
            if (workspaceFormsFolderIds.includes(file.folderId ?? "")) return true;
            const fileName = file.name.toLowerCase();
            return FORM_TEMPLATES.some((template) => fileName === template.fileName.toLowerCase() || fileName.includes(template.id));
          })
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const projectCommissioningSubmissions = commissioningSubmissions
          .filter((item) => item.projectId === workspaceProjectId)
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const activeTemplate = activeFormId ? FORM_TEMPLATES.find((template) => template.id === activeFormId) ?? null : null;
        const activeTemplateSections = activeTemplate ? getTemplateSections(activeTemplate.id) : [];
        const projectTabItems: Array<{ id: typeof projectWorkspaceTab; label: string }> = [
          { id: "overview", label: "Overview" },
          { id: "files", label: "Files" },
          { id: "team", label: "Team" },
          { id: "forms", label: "Forms" },
          { id: "activity", label: "Activity" },
          { id: "settings", label: "Settings" },
        ];

        const renderFolderTree = (parentId: string | null, depth = 0): ReactElement[] => {
          const nodes = workspaceFolders
            .filter((folder) => folder.parentId === parentId)
            .sort((a, b) => a.name.localeCompare(b.name));
          return nodes.flatMap((folder) => {
            const children = workspaceFolders.filter((child) => child.parentId === folder.id);
            const fileCount = projectFiles.filter((file) => file.projectId === workspaceProjectId && file.folderId === folder.id).length;
            const expanded = expandedFolderIds[folder.id] ?? depth < 1;
            return [
              <div key={folder.id} className={`opsFolderTreeRow ${selectedFolderId === folder.id ? "active" : ""}`} style={{ paddingLeft: `${depth * 14}px` }}>
                <button type="button" className="opsFolderTreeToggle" onClick={() => toggleFolderExpanded(folder.id)}>
                  {children.length > 0 ? (expanded ? "▼" : "▶") : "•"}
                </button>
                <button
                  type="button"
                  className="opsFolderTreeName"
                  onClick={() => {
                    setSelectedFolderId(folder.id);
                    setExpandedFolderIds((prev) => ({ ...prev, [folder.id]: true }));
                  }}
                >
                  {folder.name} <span>({fileCount})</span>
                </button>
                <div className="opsFolderTreeActions">
                  <button
                    type="button"
                    title="Create subfolder"
                    onClick={() => {
                      const subfolderName = window.prompt(`New subfolder inside "${folder.name}"`, "")?.trim();
                      if (!subfolderName) return;
                      void addFolder({ name: subfolderName, parentId: folder.id });
                      setExpandedFolderIds((prev) => ({ ...prev, [folder.id]: true }));
                    }}
                  >
                    Sub
                  </button>
                  <button type="button" title="Rename folder" onClick={() => renameFolder(folder.id)}>
                    Rename
                  </button>
                  <button type="button" title="Move folder" onClick={() => moveFolder(folder.id)}>
                    Move
                  </button>
                  <button type="button" title="Delete folder" onClick={() => deleteFolder(folder.id)}>
                    Delete
                  </button>
                </div>
              </div>,
              ...(expanded ? renderFolderTree(folder.id, depth + 1) : []),
            ];
          });
        };

        pageTitle = workspaceProject ? workspaceProject.name : "Project Workspace";
        pageSubtitle = workspaceProject
          ? `${workspaceProject.client} • ${workspaceProject.code} • ${workspaceProject.address}`
          : "Project document-management workspace";

        let workspaceContent: ReactElement = <div />;
        if (route.section === "file-open" && route.fileId) {
          const openFile = projectFiles.find((file) => file.id === route.fileId) ?? null;
          workspaceContent = (
            <section className="opsPanel opsOpenFileView">
              <div className="opsInline">
                <button type="button" onClick={() => leaveOpenFileView(workspaceProject?.slug ?? "project")}>
                  Back to Files
                </button>
                <strong>{openFile?.name ?? "File"}</strong>
                <span className="opsSubtle">
                  {openFileNeedsSaveWarning ? "Unsaved changes warning is active." : "Changes saved."}
                </span>
              </div>
              {openFile ? (
                openFile.mimeType?.includes("pdf") || openFile.name.toLowerCase().endsWith(".pdf") ? (
                  <div className="opsFileDetails">
                    <p>Opening full markup editor for this drawing...</p>
                    <button type="button" onClick={() => void openProjectFileInEditor(openFile)}>
                      Re-open Editor
                    </button>
                  </div>
                ) : openFile.mimeType?.startsWith("image/") && openFile.dataUrl ? (
                  <img src={openFile.dataUrl} alt={openFile.name} className="opsPreviewImage" />
                ) : (
                  <div className="opsFileDetails">
                    <p>Preview is not supported for this file type.</p>
                    <button type="button" onClick={() => downloadProjectFile(openFile)}>
                      Download
                    </button>
                  </div>
                )
              ) : (
                <p>File not found.</p>
              )}
            </section>
          );
        } else if (projectWorkspaceTab === "files") {
          const activeFolderName =
            selectedFolderId === null ? "All folders" : workspaceFolders.find((folder) => folder.id === selectedFolderId)?.name ?? "Folder";
          workspaceContent = (
            <div className="opsWorkspace3Col">
              <aside className="opsPanel opsWorkspacePanel">
                <h3>Folders</h3>
                <p className="opsSubtle">Choose a folder to filter files. Use "Sub" to create a child folder.</p>
                <div className="opsInline">
                  <button type="button" className={selectedFolderId === null ? "active" : ""} onClick={() => setSelectedFolderId(null)}>
                    All Files
                  </button>
                  <button type="button" onClick={() => void addFolder()} disabled={!projectPermission.manageFolders}>
                    Create Folder
                  </button>
                </div>
                <div className="opsFolderTree">{renderFolderTree(null)}</div>
              </aside>

              <section
                className="opsPanel opsWorkspacePanel"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void handleProjectFileUpload(event.dataTransfer.files);
                }}
              >
                <h3>Files in: {activeFolderName}</h3>
                <p className="opsSubtle">Tap a file name to select it. PDFs open in the full markup editor.</p>
                <div className="opsInline">
                  <button
                    type="button"
                    onClick={() => projectUploadInputRef.current?.click()}
                    disabled={!projectPermission.uploadFiles}
                  >
                    Upload Files
                  </button>
                  {!projectPermission.uploadFiles ? <small className="opsSubtle">Upload disabled by project permission</small> : null}
                  <button type="button" onClick={() => void addFolder()} disabled={!projectPermission.manageFolders}>
                    Create Folder
                  </button>
                  <input type="text" value={fileSearch} placeholder="Search files..." onChange={(event) => setFileSearch(event.target.value)} />
                  <select>
                    <option>Type: All files</option>
                    <option>PDF</option>
                    <option>Images</option>
                    <option>Docs</option>
                  </select>
                  <select>
                    <option>Sort by: Modified date</option>
                    <option>Name</option>
                    <option>Size</option>
                  </select>
                  <input
                    ref={projectUploadInputRef}
                    type="file"
                    multiple
                    className="hiddenInput"
                    onChange={(event) => {
                      void handleProjectFileUpload(event.target.files, versionUploadTargetId ?? undefined);
                      event.currentTarget.value = "";
                    }}
                  />
                </div>
                <p className="opsSubtle">Drag and drop files here to upload.</p>
                <div className="opsList opsFileRows">
                  {visibleFiles.map((file) => (
                    <div key={file.id} className={`opsListRow ${selectedProjectFileId === file.id ? "opsRowActive" : ""}`}>
                      <button
                        type="button"
                        className="opsFilePrimary"
                        onClick={() => {
                          setSelectedProjectFileId(file.id);
                          if (file.mimeType?.includes("pdf") || file.name.toLowerCase().endsWith(".pdf")) {
                            void openProjectFileFullView(file, workspaceProject?.slug ?? "project");
                          }
                        }}
                      >
                        <strong>{file.name}</strong>
                        <small>
                          Version {file.version ?? 1} • {file.mimeType ?? "Unknown"} • Updated{" "}
                          {formatDateUk(file.updatedAt)} • By {file.uploadedBy ?? currentUser.name}
                        </small>
                      </button>
                      <div className="opsInline opsFileRowActions">
                        <button
                          type="button"
                          onClick={() => void openProjectFileFullView(file, workspaceProject?.slug ?? "project")}
                        >
                          {file.mimeType?.includes("pdf") || file.name.toLowerCase().endsWith(".pdf") ? "Open Editor" : "Open"}
                        </button>
                        <button type="button" onClick={() => downloadProjectFile(file)}>
                          Download
                        </button>
                        <button type="button" onClick={() => renameProjectFile(file.id)}>
                          Rename
                        </button>
                        <button type="button" onClick={() => moveProjectFile(file.id)}>
                          Move
                        </button>
                        <button type="button" onClick={() => copyProjectFile(file.id)}>
                          Copy
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setVersionUploadTargetId(file.id);
                            projectUploadInputRef.current?.click();
                          }}
                        >
                          New Version
                        </button>
                        <button type="button" onClick={() => setVersionHistoryFileId(file.id)}>
                          History
                        </button>
                        <button type="button" onClick={() => notify(`Share link prepared for ${file.name}.`)}>
                          Share
                        </button>
                        <button type="button" onClick={() => deleteProjectFile(file.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                  {visibleFiles.length === 0 ? <p>No files in this folder.</p> : null}
                </div>
              </section>

              <section className="opsPanel opsWorkspacePanel">
                <h3>Preview & Editor</h3>
                {selectedProjectFile ? (
                  selectedProjectFile.mimeType?.includes("pdf") || selectedProjectFile.name.toLowerCase().endsWith(".pdf") ? (
                    <div className="opsFileDetails">
                      <p>This is a PDF drawing. Open it in the full markup editor to review and add markups.</p>
                      <div className="opsInline">
                        <button type="button" onClick={() => void openProjectFileFullView(selectedProjectFile, workspaceProject?.slug ?? "project")}>
                          Open Full Editor
                        </button>
                        <button type="button" onClick={() => downloadProjectFile(selectedProjectFile)}>
                          Download
                        </button>
                      </div>
                    </div>
                  ) : selectedProjectFile.mimeType?.startsWith("image/") && selectedProjectFile.dataUrl ? (
                    <img src={selectedProjectFile.dataUrl} alt={selectedProjectFile.name} className="opsPreviewImage" />
                  ) : (
                    <div className="opsFileDetails">
                      <p>Preview not supported for this file type.</p>
                      <p>Name: {selectedProjectFile.name}</p>
                      <p>Type: {selectedProjectFile.mimeType ?? "Unknown"}</p>
                      <button type="button" onClick={() => downloadProjectFile(selectedProjectFile)}>
                        Download
                      </button>
                    </div>
                  )
                ) : (
                  <p>Select a file from the middle column to preview or open it in the editor.</p>
                )}

                {versionHistoryFileId ? (
                  <div className="opsPanel opsVersionHistory">
                    <div className="opsInline">
                      <h4>Version History</h4>
                      <button type="button" onClick={() => setVersionHistoryFileId(null)}>
                        Close
                      </button>
                    </div>
                    <div className="opsList">
                      {selectedFileVersions.map((version) => (
                        <div key={version.id} className="opsListRow">
                          <div>
                            <strong>v{version.version}</strong>
                            <small>{formatDateTimeUk(version.uploadedAt)}</small>
                            <small>{version.uploadedBy}</small>
                            <small>{version.changeNote ?? "-"}</small>
                          </div>
                          <div className="opsInline">
                            <button
                              type="button"
                              onClick={() => {
                                if (!version.dataUrl) return;
                                const target = projectFiles.find((file) => file.id === version.fileId);
                                if (!target) return;
                                setProjectFiles((prev) =>
                                  prev.map((file) =>
                                    file.id === target.id
                                      ? {
                                          ...file,
                                          dataUrl: version.dataUrl,
                                          version: version.version + 1,
                                          updatedAt: new Date().toISOString(),
                                          status: "Restored",
                                        }
                                      : file,
                                  ),
                                );
                                logProjectActivity("version restored", target.name, selectedProjectId);
                              }}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      ))}
                      {selectedFileVersions.length === 0 ? <p>No previous versions.</p> : null}
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          );
        } else if (projectWorkspaceTab === "overview") {
          workspaceContent = (
            <div className="opsOverviewGrid">
              <section className="opsPanel">
                <h3>Project Details</h3>
                <p>Manager: {workspaceProject?.manager}</p>
                <p>Status: {workspaceProject?.status}</p>
                <p>Start: {workspaceProject?.startDate}</p>
                <p>Target: {workspaceProject?.targetDate || "-"}</p>
                <p>{workspaceProject?.description || "No description."}</p>
              </section>
              <section className="opsPanel">
                <h3>Summary</h3>
                <p>Files: {projectFiles.filter((file) => file.projectId === workspaceProjectId).length}</p>
                <p>Forms: {projectFormFiles.length + projectCommissioningSubmissions.length}</p>
                <p>Timesheet hours: {formatMinutes(timeSummary.totalMinutes)}</p>
              </section>
            </div>
          );
        } else if (projectWorkspaceTab === "team") {
          workspaceContent = (
            <section className="opsPanel">
              <table className="opsTable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Permission</th>
                    <th>Date added</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedProjectMembers.map((member) => (
                    <tr key={member.id}>
                      <td>{member.name}</td>
                      <td>{member.email}</td>
                      <td>{member.role}</td>
                      <td>{member.permission.manageTeam ? "Manage" : "Limited"}</td>
                      <td>{formatDateUk(member.dateAdded)}</td>
                      <td>{member.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        } else if (projectWorkspaceTab === "forms") {
          workspaceContent = (
            <div className="opsOverviewGrid">
              <section className="opsPanel">
                <h3>Commissioning Templates</h3>
                <p className="opsSubtle">Start a new project form from your common commissioning templates.</p>
                <div className="opsList">
                  {FORM_TEMPLATES.map((form) => (
                    <div key={form.id} className="opsListRow">
                      <div>
                        <strong>{form.name}</strong>
                        <small>
                          {form.version} • Updated {form.updatedAt}
                        </small>
                      </div>
                      <div className="opsInline">
                        <button type="button" onClick={() => void startProjectFormFromTemplate(form)}>
                          Start Form
                        </button>
                        <button type="button" onClick={() => void downloadFormTemplate(form)}>
                          Download Blank
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="opsPanel">
                <h3>Project Form Register</h3>
                <p className="opsSubtle">Open/edit boxed forms and export branded PDFs.</p>
                <div className="opsList">
                  {projectCommissioningSubmissions.map((submission) => (
                    <div key={submission.id} className="opsListRow">
                      <div>
                        <strong>{submission.templateName}</strong>
                        <small>
                          {submission.status === "completed" ? "Completed" : "Draft"} • Updated {formatDateTimeUk(submission.updatedAt)}
                        </small>
                        <small>{submission.createdBy}</small>
                      </div>
                      <div className="opsInline">
                        <button
                          type="button"
                          onClick={() => {
                            openCommissioningSubmission(submission);
                            navigateOps(`/forms/${submission.templateId}/fill`);
                          }}
                        >
                          Open Boxes
                        </button>
                        <button type="button" onClick={() => void exportCommissioningSubmission(submission)}>
                          Export PDF
                        </button>
                      </div>
                    </div>
                  ))}
                  {projectCommissioningSubmissions.length === 0 ? <p>No boxed project forms created yet.</p> : null}
                </div>
              </section>
              {activeTemplate && activeCommissioningSubmission ? (
                <section className="opsPanel opsCommissioningEditor">
                  <h3>{activeTemplate.name} - Boxed Form</h3>
                  <p className="opsSubtle">Complete each box then save draft or export final branded PDF.</p>
                  {activeTemplateSections.map((section) => (
                    <div key={section.id} className="opsCommissioningSection">
                      <h4>{section.title}</h4>
                      <div className="opsFields">
                        {section.fields.map((field) => (
                          <label key={field.id}>
                            {field.label}
                            {field.type === "textarea" ? (
                              <textarea
                                value={activeCommissioningValues[field.id] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(event) =>
                                  setActiveCommissioningValues((prev) => ({
                                    ...prev,
                                    [field.id]: event.target.value,
                                  }))
                                }
                              />
                            ) : field.type === "checkbox" ? (
                              <input
                                type="checkbox"
                                checked={activeCommissioningValues[field.id] === "true"}
                                onChange={(event) =>
                                  setActiveCommissioningValues((prev) => ({
                                    ...prev,
                                    [field.id]: String(event.target.checked),
                                  }))
                                }
                              />
                            ) : (
                              <input
                                type={field.type}
                                value={activeCommissioningValues[field.id] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(event) =>
                                  setActiveCommissioningValues((prev) => ({
                                    ...prev,
                                    [field.id]: event.target.value,
                                  }))
                                }
                              />
                            )}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div className="opsInline">
                    <button
                      type="button"
                      onClick={() => {
                        const saved = saveCommissioningSubmission("draft");
                        if (saved) notify("Form draft saved.");
                      }}
                    >
                      Save Draft
                    </button>
                    <button
                      type="button"
                      className="btnSuccess"
                      onClick={() => {
                        const saved = saveCommissioningSubmission("completed");
                        if (saved) void exportCommissioningSubmission(saved);
                      }}
                    >
                      Export Final PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveCommissioningSubmissionId(null);
                        setActiveFormId(null);
                        setActiveCommissioningValues({});
                      }}
                    >
                      Close Form
                    </button>
                  </div>
                </section>
              ) : null}
            </div>
          );
        } else if (projectWorkspaceTab === "activity") {
          workspaceContent = (
            <section className="opsPanel">
              <div className="opsList">
                {selectedProjectActivity.map((entry) => (
                  <div key={entry.id} className="opsListRow">
                    <div>
                      <strong>{entry.action}</strong>
                      <small>{entry.item}</small>
                      <small>{entry.user}</small>
                    </div>
                    <span>{formatDateTimeUk(entry.at)}</span>
                  </div>
                ))}
                {selectedProjectActivity.length === 0 ? <p>No project activity yet.</p> : null}
              </div>
            </section>
          );
        } else {
          workspaceContent = (
            <section className="opsPanel">
              <h3>Settings</h3>
              <p>Project permissions and configuration controls are managed here.</p>
            </section>
          );
        }

        content = (
          <div className="opsProjectWorkspace">
            <section className="opsPanel opsProjectWorkspaceHeader">
              <div className="opsProjectMeta">
                <h3>{workspaceProject?.name ?? "Project"}</h3>
                <p>
                  {workspaceProject?.client} • {workspaceProject?.code} • {workspaceProject?.address}
                </p>
                <p>
                  Status: {workspaceProject?.status} • Manager: {workspaceProject?.manager} • Start: {workspaceProject?.startDate}
                </p>
              </div>
              <div className="opsInline">
                <button type="button" onClick={() => setShowNewProjectModal(true)}>
                  Edit Project
                </button>
                <button type="button" onClick={() => notify("More project actions opened.")}>
                  More actions
                </button>
              </div>
            </section>
            <section className="opsProjectTabs">
              {projectTabItems.map((tab) => (
                <button key={tab.id} type="button" className={projectWorkspaceTab === tab.id ? "active" : ""} onClick={() => setProjectWorkspaceTab(tab.id)}>
                  {tab.label}
                </button>
              ))}
            </section>
            {workspaceContent}
          </div>
        );
      }
    } else if (route.name === "forms") {
      if (route.mode === "fill") {
        const editingTemplate = route.formId ? FORM_TEMPLATES.find((item) => item.id === route.formId) ?? null : null;
        const editingSections = editingTemplate ? getTemplateSections(editingTemplate.id) : [];
        pageTitle = editingTemplate ? `Form: ${editingTemplate.name}` : "Form Completion";
        pageSubtitle = "Complete commissioning boxes and export branded PDF.";
        content = (
          <section className="opsPanel opsCommissioningEditor">
            {editingTemplate && activeCommissioningSubmission ? (
              <>
                {editingSections.map((section) => (
                  <div key={section.id} className="opsCommissioningSection">
                    <h4>{section.title}</h4>
                    <div className="opsFields">
                      {section.fields.map((field) => (
                        <label key={field.id}>
                          {field.label}
                          {field.type === "textarea" ? (
                            <textarea
                              value={activeCommissioningValues[field.id] ?? ""}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                setActiveCommissioningValues((prev) => ({
                                  ...prev,
                                  [field.id]: event.target.value,
                                }))
                              }
                            />
                          ) : field.type === "checkbox" ? (
                            <input
                              type="checkbox"
                              checked={activeCommissioningValues[field.id] === "true"}
                              onChange={(event) =>
                                setActiveCommissioningValues((prev) => ({
                                  ...prev,
                                  [field.id]: String(event.target.checked),
                                }))
                              }
                            />
                          ) : (
                            <input
                              type={field.type}
                              value={activeCommissioningValues[field.id] ?? ""}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                setActiveCommissioningValues((prev) => ({
                                  ...prev,
                                  [field.id]: event.target.value,
                                }))
                              }
                            />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="opsInline">
                  <button
                    type="button"
                    onClick={() => {
                      const saved = saveCommissioningSubmission("draft");
                      if (saved) notify("Form draft saved.");
                    }}
                  >
                    Save Draft
                  </button>
                  <button
                    type="button"
                    className="btnSuccess"
                    onClick={() => {
                      const saved = saveCommissioningSubmission("completed");
                      if (saved) void exportCommissioningSubmission(saved);
                    }}
                  >
                    Export Final PDF
                  </button>
                  <button type="button" onClick={() => navigateOps("/forms")}>
                    Back to Forms
                  </button>
                </div>
              </>
            ) : (
              <p>Select a commissioning template to start.</p>
            )}
          </section>
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
    } else if (route.name === "sign-in") {
      pageTitle = "GPS Sign In";
      pageSubtitle = "Capture project and your attendance with geofence checks";
      const selectedWorkerLastAction = selectedWorker ? latestEntryByWorker[selectedWorker.id] : undefined;
      const selectedWorkerGps = parseGpsNote(selectedWorkerLastAction?.note);
      const clockInCheck = selectedWorker ? canApplyClockAction(selectedWorker.id, "clock_in") : { ok: false };
      content = (
        <div className="opsSignInGrid">
          <section className="opsPanel opsFields">
            <div className="opsInline opsClockToggle">
              <button type="button" className="active" onClick={() => navigateOps("/sign-in")}>
                Clock In
              </button>
              <button type="button" onClick={() => navigateOps("/sign-out")}>
                Clock Out
              </button>
            </div>
            <label>
              Project selector
              <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ({project.code})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Site address
              <input type="text" value={selectedProject?.address ?? "No site address set for this project"} readOnly />
            </label>
            <label>
              Logged in user
              <input type="text" value={`${currentUser.name} (${currentUser.email})`} readOnly />
            </label>
            <p className="opsSubtle">Attendance is locked to your authenticated account. You cannot sign in as another worker.</p>
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
                ? `Captured ${formatTimeUk(liveGps.capturedAt)} (${liveGps.source}).`
                : "Map will update when GPS is captured."}
            </p>
          </section>
        </div>
      );
    } else {
      pageTitle = "Operations Home";
      pageSubtitle = "Choose where you want to go";
      content = (
        <section className="opsPanel">
          <button type="button" onClick={() => navigateOps("/home")}>
            Open Home
          </button>
        </section>
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
              <span>{formatDateUk(new Date())}</span>
              <span>{currentUser.name}</span>
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

  function renderAuthGate(): ReactElement {
    if (!hasSupabaseConfig || !supabase) {
      return (
        <main className="authGate">
          <section className="authCard">
            <h2>Authentication setup required</h2>
            <p>Add Supabase environment variables to enable secure sign-in:</p>
            <ul>
              <li>VITE_SUPABASE_URL</li>
              <li>VITE_SUPABASE_ANON_KEY</li>
            </ul>
          </section>
        </main>
      );
    }

    if (authInitializing) {
      return (
        <main className="authGate">
          <section className="authCard">
            <h2>Checking session…</h2>
            <p>Please wait while we verify your account.</p>
          </section>
        </main>
      );
    }

    const titleMap: Record<AuthMode, string> = {
      login: "Sign in to MEP OPS",
      signup: "Create your account",
      forgot: "Reset your password",
      reset: "Set a new password",
    };

    const submitLabel: Record<AuthMode, string> = {
      login: "Sign In",
      signup: "Create Account",
      forgot: "Send Reset Link",
      reset: "Update Password",
    };

    return (
      <main className="authGate">
        <section className="authCard">
          <h2>{titleMap[authMode]}</h2>
          <p className="authHint">
            First owner account: <strong>{OWNER_EMAIL}</strong>. Use Sign Up on first access, then sign in normally.
          </p>
          <form className="authForm" onSubmit={(event) => void handleAuthSubmit(event)}>
            <label>
              Email
              <input
                type="email"
                value={authEmail}
                autoComplete="email"
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder={OWNER_EMAIL}
                required
              />
            </label>
            {authMode !== "forgot" ? (
              <label>
                Password
                <input
                  type="password"
                  value={authPassword}
                  autoComplete={authMode === "login" ? "current-password" : "new-password"}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  required
                />
              </label>
            ) : null}
            {authMode === "signup" || authMode === "reset" ? (
              <label>
                Confirm password
                <input
                  type="password"
                  value={authConfirmPassword}
                  autoComplete="new-password"
                  onChange={(event) => setAuthConfirmPassword(event.target.value)}
                  required
                />
              </label>
            ) : null}
            {authMessage ? <p className="authMessage">{authMessage}</p> : null}
            <button type="submit" disabled={authBusy}>
              {authBusy ? "Please wait..." : submitLabel[authMode]}
            </button>
          </form>

          <div className="authSwitches">
            {authMode !== "login" ? (
              <button
                type="button"
                onClick={() => {
                  setAuthMode("login");
                  setAuthMessage("");
                }}
              >
                Back to sign in
              </button>
            ) : null}
            {authMode !== "signup" ? (
              <button
                type="button"
                onClick={() => {
                  setAuthMode("signup");
                  setAuthMessage("");
                }}
              >
                Create account
              </button>
            ) : null}
            {authMode !== "forgot" ? (
              <button
                type="button"
                onClick={() => {
                  setAuthMode("forgot");
                  setAuthMessage("");
                }}
              >
                Forgot password
              </button>
            ) : null}
          </div>
          <section className="authDiagnostics">
            <div className="authDiagnosticsHeader">
              <strong>Connection test</strong>
              <button type="button" onClick={() => void runAuthDiagnostics()} disabled={authDiagnosticsBusy}>
                {authDiagnosticsBusy ? "Testing..." : "Run Auth Connection Test"}
              </button>
            </div>
            <p className="authHint">Runs live checks against your Supabase Auth endpoint and shows exact status/error output.</p>
            {authDiagnosticsOutput ? <pre className="authDiagnosticsOutput">{authDiagnosticsOutput}</pre> : null}
          </section>
        </section>
      </main>
    );
  }

  const pages = Array.from({ length: pageCount }, (_, idx) => idx + 1);

  if (!authSession) {
    return renderAuthGate();
  }

  if (showDailyIntroVideo) {
    return (
      <main className="dailyIntroScreen" aria-label="Daily intro loading screen">
        <section className="dailyIntroShell">
          <button type="button" className="dailyIntroClose" onClick={() => setShowDailyIntroVideo(false)}>
            Enter app
          </button>
          <video className="dailyIntroVideo" autoPlay playsInline controls onEnded={() => setShowDailyIntroVideo(false)}>
            <source src={DAILY_INTRO_VIDEO_PATH} type="video/mp4" />
            Your browser does not support MP4 playback.
          </video>
        </section>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="appShellHeader">
        <div className="appBrand">
          <div className="appBrandLogoMark" aria-label="London AC Ltd logo">
            <strong>LONDON</strong>
            <span>AC LTD</span>
          </div>
        </div>
        <div className="opsInline">
          {activeModule === "markup-studio" ? (
            <button type="button" onClick={exitProjectMarkupStudio}>
              Back to Project Files
            </button>
          ) : null}
          <button
            type="button"
            className={activeModule === "operations" ? "active" : ""}
            onClick={() => navigateOps("/home")}
          >
            Operations
          </button>
          <button type="button" onClick={() => void handleSignOut()} disabled={authBusy}>
            {authBusy ? "Signing out..." : "Sign Out"}
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

        <div className={`toolbarPanelPicker ${isCompactToolbar ? "isVisible" : ""}`}>
          <button type="button" className={activeToolbarPanel === "file" ? "active" : ""} onClick={() => setActiveToolbarPanel("file")}>
            File
          </button>
          <button type="button" className={activeToolbarPanel === "tools" ? "active" : ""} onClick={() => setActiveToolbarPanel("tools")}>
            Tools
          </button>
          <button type="button" className={activeToolbarPanel === "view" ? "active" : ""} onClick={() => setActiveToolbarPanel("view")}>
            View
          </button>
          <button type="button" className={activeToolbarPanel === "stamps" ? "active" : ""} onClick={() => setActiveToolbarPanel("stamps")}>
            Stamps
          </button>
          <button type="button" className={activeToolbarPanel === "edit" ? "active" : ""} onClick={() => setActiveToolbarPanel("edit")}>
            Edit
          </button>
          {selectedAnnotation ? (
            <button
              type="button"
              className={activeToolbarPanel === "selected" ? "active" : ""}
              onClick={() => setActiveToolbarPanel("selected")}
            >
              Selected
            </button>
          ) : null}
        </div>

        <div className="toolbarGrid">
        <div className={`group panel panel-files toolbarPanel ${isCompactToolbar && activeToolbarPanel !== "file" ? "isHidden" : ""}`}>
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

        <div className={`group panel panel-tools toolbarPanel ${isCompactToolbar && activeToolbarPanel !== "tools" ? "isHidden" : ""}`}>
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

        <div className={`group panel panel-view toolbarPanel ${isCompactToolbar && activeToolbarPanel !== "view" ? "isHidden" : ""}`}>
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

        <div className={`group panel panel-stamps toolbarPanel ${isCompactToolbar && activeToolbarPanel !== "stamps" ? "isHidden" : ""}`}>
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

        <div className={`group panel panel-edit toolbarPanel ${isCompactToolbar && activeToolbarPanel !== "edit" ? "isHidden" : ""}`}>
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
          <div
            className={`group panel panel-selected toolbarPanel ${isCompactToolbar && activeToolbarPanel !== "selected" ? "isHidden" : ""}`}
          >
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
