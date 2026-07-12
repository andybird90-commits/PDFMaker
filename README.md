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
- Select + drag existing annotations
- Resize handles for line endpoints, rectangles, clouds, and stamps
- Undo last annotation and clear all
- Zoom support
- Page thumbnails with click-to-scroll navigation
- Mouse controls:
  - wheel scroll zooms in/out
  - middle mouse button drag pans around the document viewport
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
- Save markups as JSON
- Load markups from JSON
- Full file workflow:
  - Open (PDF, project JSON, or markup JSON)
  - Save (writes annotated flattened `.pdf`)
  - Save As (writes annotated flattened `.pdf`)
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
