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
- Select + delete annotations
- Undo last annotation and clear all
- Zoom support
- Save markups as JSON
- Load markups from JSON
- Export annotated pages as PNG snapshots

## Run locally

```bash
npm install
npm run dev
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
