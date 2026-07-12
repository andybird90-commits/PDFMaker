export type Tool =
  | "select"
  | "line"
  | "arrow"
  | "rect"
  | "cloud"
  | "highlighter"
  | "stamp";

export type Point = {
  x: number;
  y: number;
};

export type NormalizedPoint = Point;

export type LineStyle = "solid" | "dashed" | "dotted";

export type BaseAnnotation = {
  id: string;
  page: number;
  color: string;
  strokeWidth: number;
  lineStyle: LineStyle;
};

export type LineAnnotation = BaseAnnotation & {
  type: "line" | "arrow";
  start: NormalizedPoint;
  end: NormalizedPoint;
};

export type RectAnnotation = BaseAnnotation & {
  type: "rect";
  start: NormalizedPoint;
  end: NormalizedPoint;
  fillColor?: string;
};

export type CloudAnnotation = BaseAnnotation & {
  type: "cloud";
  start: NormalizedPoint;
  end: NormalizedPoint;
};

export type HighlighterAnnotation = BaseAnnotation & {
  type: "highlighter";
  points: NormalizedPoint[];
  opacity: number;
};

export type StampAnnotation = BaseAnnotation & {
  type: "stamp";
  position: NormalizedPoint;
  width: number;
  height: number;
  stampKind: "text" | "image";
  label?: string;
  imageDataUrl?: string;
  opacity: number;
};

export type Annotation =
  | LineAnnotation
  | RectAnnotation
  | CloudAnnotation
  | HighlighterAnnotation
  | StampAnnotation;

export type MarkupDocument = {
  schemaVersion: 1;
  fileName: string;
  createdAt: string;
  annotations: Annotation[];
};

export type EditorProjectDocument = {
  schemaVersion: 1;
  kind: "pdfmaker-project";
  fileName: string;
  createdAt: string;
  pdfData: string;
  annotations: Annotation[];
};
