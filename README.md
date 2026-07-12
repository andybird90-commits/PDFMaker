# PDFMaker

PDFMaker is a browser-based PDF annotation editor built with PDF.js and React.

## Features

- PDF page rendering via `pdfjs-dist`
- Overlay markup tools:
  - line
  - arrow
  - square/rectangle
  - cloud callout
  - highlighter
  - custom stamps (text stamps and uploaded image stamps)
  - pins with status/scheduling/photo metadata
  - calibration + measurement tools (mm)
- Select + drag existing annotations
- Resize handles for line endpoints, rectangles, clouds, and stamps
- Undo last annotation and clear all
- Zoom support
- Page thumbnails with click-to-scroll navigation
- Mouse controls:
  - wheel zoom is cursor-anchored (no concurrent page drift while zooming)
  - middle mouse button drag pans around the document viewport
- Bluebeam-inspired dark operator UI skin (toolbar + side rail)
- Tool-first top ribbon (no dropdown menus)
- Styling controls:
  - line/highlighter color
  - line/highlighter weight
  - line type (solid, dashed, dotted)
  - selected annotation style editing (including highlighter opacity)
- Standard stamp presets:
  - APPROVED
  - CONSTRUCTION
  - STATUS A
  - STATUS B
  - STATUS C
- Custom stamps:
  - upload image stamps to add them to your default stamp list
  - stored locally for reuse between sessions
  - selectable from the custom stamp dropdown
  - removable with delete action
- Save markups as JSON
- Load markups from JSON
- Pin workflow:
  - drop pins on any page
  - add title, description, scheduled date, and photo attachment
  - update pin status (Open, In progress, Scheduled, Closed)
  - export pin report as JSON or CSV
- Full file workflow:
  - Open (PDF, project JSON, or markup JSON)
  - Open Batch (multi-PDF batch list with per-document switching)
  - Save (writes annotated flattened `.pdf`)
  - Save As (writes annotated flattened `.pdf`)
- Rotate drawing controls for selected annotations (left/right)
- Calibrate & measure workflow:
  - calibrate page scale in millimeters by drawing a known-length line
  - measure distance (mm) and rectangular area (mm²)
- Export annotated pages as PNG snapshots
- Export a flattened PDF with markups burned in

## Run locally

```bash
npm install
npm run dev
```

Run with automatic browser open:

```bash
npm run dev:open
```

Build for production:

```bash
npm run build
npm run preview
```

## Annotation data format

Saved markup JSON includes:

- `schemaVersion`
- `fileName`
- `createdAt`
- `annotations[]` with normalized (0..1) coordinates per page

This lets annotations stay correctly aligned when zoom changes.
