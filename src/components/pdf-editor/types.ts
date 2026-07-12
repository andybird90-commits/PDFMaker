export type PdfEditorSaveResult = {
  pdfBlob: Blob;
  annotations: PdfEditorAnnotations;
};

export type PdfEditorProps = {
  url: string;
  initialAnnotations?: unknown;
  readOnly?: boolean;
  onSave?: (result: PdfEditorSaveResult) => void | Promise<void>;
  onClose?: () => void;
};

export type Tool = "select" | "line" | "arrow" | "rect" | "cloud" | "highlighter" | "stamp";

export type LineStyle = "solid" | "dashed" | "dotted";

export type Point = {
  x: number;
  y: number;
};

type BaseAnnotation = {
  id: string;
  page: number;
  color: string;
  strokeWidth: number;
  lineStyle: LineStyle;
};

export type LineAnnotation = BaseAnnotation & {
  type: "line" | "arrow";
  start: Point;
  end: Point;
};

export type RectAnnotation = BaseAnnotation & {
  type: "rect";
  start: Point;
  end: Point;
};

export type CloudAnnotation = BaseAnnotation & {
  type: "cloud";
  start: Point;
  end: Point;
};

export type HighlighterAnnotation = BaseAnnotation & {
  type: "highlighter";
  points: Point[];
  opacity: number;
};

export type StampAnnotation = BaseAnnotation & {
  type: "stamp";
  position: Point;
  width: number;
  height: number;
  label: string;
  opacity: number;
};

export type Annotation =
  | LineAnnotation
  | RectAnnotation
  | CloudAnnotation
  | HighlighterAnnotation
  | StampAnnotation;

export type PdfEditorAnnotations = {
  schemaVersion: 1;
  annotations: Annotation[];
};

export type PageSize = {
  width: number;
  height: number;
};

export type DrawingState =
  | {
      page: number;
      start: Point;
      current: Point;
      points: Point[];
    }
  | null;
