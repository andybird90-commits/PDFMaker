# PdfEditor Component

Drop-in PDF editor component for React 18 + Vite + TypeScript + Tailwind apps.

## Usage

```tsx
import { PdfEditor } from "@/components/pdf-editor";

export function Example() {
  return (
    <div className="h-[80vh] w-full">
      <PdfEditor
        url="https://example.com/signed/document.pdf"
        initialAnnotations={undefined}
        onSave={async ({ pdfBlob, annotations }) => {
          // Host app owns persistence and uploads.
          console.log(pdfBlob, annotations);
        }}
        onClose={() => {
          console.log("closed");
        }}
      />
    </div>
  );
}
```

## Props

- `url: string` — signed URL to the source PDF.
- `initialAnnotations?: unknown` — previous value returned from `onSave`.
- `readOnly?: boolean` — disables editing tools when true.
- `onSave?: (result: { pdfBlob: Blob; annotations: unknown }) => void | Promise<void>` — called with flattened PDF + raw annotations.
- `onClose?: () => void` — optional close callback.
