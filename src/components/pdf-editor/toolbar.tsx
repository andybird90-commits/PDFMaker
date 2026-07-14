import type { LineStyle, Tool } from "./types";

type ToolbarProps = {
  tool: Tool;
  setTool: (tool: Tool) => void;
  readOnly: boolean;
  strokeColor: string;
  setStrokeColor: (value: string) => void;
  strokeWidth: number;
  setStrokeWidth: (value: number) => void;
  lineStyle: LineStyle;
  setLineStyle: (value: LineStyle) => void;
  stampLabel: string;
  setStampLabel: (value: string) => void;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onDeleteSelected: () => void;
  hasSelected: boolean;
  onSave?: () => void;
  saving: boolean;
  onClose?: () => void;
};

const DRAW_TOOLS: Tool[] = ["select", "line", "arrow", "rect", "cloud", "highlighter", "stamp"];

export function Toolbar({
  tool,
  setTool,
  readOnly,
  strokeColor,
  setStrokeColor,
  strokeWidth,
  setStrokeWidth,
  lineStyle,
  setLineStyle,
  stampLabel,
  setStampLabel,
  scale,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onDeleteSelected,
  hasSelected,
  onSave,
  saving,
  onClose,
}: ToolbarProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-slate-200 bg-white p-2">
      <div className="flex flex-wrap gap-1">
        {DRAW_TOOLS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTool(name)}
            disabled={readOnly}
            className={`rounded border px-2 py-1 text-xs font-medium ${
              tool === name ? "border-sky-500 bg-sky-500 text-white" : "border-slate-300 bg-slate-50 text-slate-700"
            } ${readOnly ? "opacity-60" : ""}`}
          >
            {name}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-1 text-xs text-slate-700">
        Color
        <input type="color" value={strokeColor} disabled={readOnly} onChange={(event) => setStrokeColor(event.target.value)} />
      </label>

      <label className="flex items-center gap-1 text-xs text-slate-700">
        Width
        <input
          type="range"
          min={1}
          max={16}
          value={strokeWidth}
          disabled={readOnly}
          onChange={(event) => setStrokeWidth(Number(event.target.value))}
        />
      </label>

      <label className="flex items-center gap-1 text-xs text-slate-700">
        Type
        <select
          value={lineStyle}
          disabled={readOnly}
          onChange={(event) => setLineStyle(event.target.value as LineStyle)}
          className="rounded border border-slate-300 px-1 py-0.5"
        >
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
        </select>
      </label>

      {tool === "stamp" ? (
        <label className="flex items-center gap-1 text-xs text-slate-700">
          Stamp
          <input
            type="text"
            value={stampLabel}
            disabled={readOnly}
            onChange={(event) => setStampLabel(event.target.value)}
            className="rounded border border-slate-300 px-1 py-0.5"
          />
        </label>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-1">
        <button type="button" onClick={onZoomOut} className="rounded border border-slate-300 px-2 py-1 text-xs">
          -
        </button>
        <span className="text-xs text-slate-700">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={onZoomIn} className="rounded border border-slate-300 px-2 py-1 text-xs">
          +
        </button>
        <button type="button" onClick={onZoomReset} className="rounded border border-slate-300 px-2 py-1 text-xs">
          100%
        </button>
        <button
          type="button"
          onClick={onDeleteSelected}
          disabled={readOnly || !hasSelected}
          className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 disabled:opacity-40"
        >
          Delete
        </button>
        {onSave ? (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded border border-emerald-600 bg-emerald-600 px-2 py-1 text-xs text-white disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        ) : null}
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-2 py-1 text-xs">
            Close
          </button>
        ) : null}
      </div>
    </div>
  );
}
