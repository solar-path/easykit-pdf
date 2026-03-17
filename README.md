# @easykit/pdf

Zero-dependency HTML→PDF generation for Bun via Chromium CDP (Chrome DevTools Protocol).

No puppeteer. No playwright. Just Chromium + fetch.

## Install

```bash
# via git dependency
bun add github:solar-path/easykit-pdf
```

**Requires Chromium/Chrome installed** on the system. The library auto-detects common install locations on macOS, Linux, and Docker.

## Usage

```ts
import { generatePdf } from "@easykit/pdf";

// Simple HTML to PDF
const pdfBuffer = await generatePdf({
  html: "<h1>Hello World</h1><p>Generated with @easykit/pdf</p>",
});

await Bun.write("output.pdf", pdfBuffer);

// With full options
const report = await generatePdf({
  html: reportHtml,
  header: '<div style="font-size:10px;text-align:center">Company Report</div>',
  footer: '<div style="font-size:10px;text-align:center">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  pageNumbers: true,
  orientation: "landscape",
  format: "A4",
  margins: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
});
```

## API

### `generatePdf(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `html` | `string` | **required** | HTML content to convert |
| `header` | `string` | `undefined` | HTML template for page header |
| `footer` | `string` | `undefined` | HTML template for page footer |
| `pageNumbers` | `boolean` | `false` | Auto-generate footer with page numbers |
| `toc` | `boolean` | `false` | Generate table of contents from headings |
| `orientation` | `"portrait" \| "landscape"` | `"portrait"` | Page orientation |
| `format` | `string` | `"A4"` | Paper format (A4, Letter, Legal, A3, etc.) |
| `margins` | `object` | `{ top: "10mm", ... }` | Page margins (top, right, bottom, left) |
| `timeout` | `number` | `30000` | Timeout in ms for the entire operation |
| `chromiumPath` | `string` | auto-detect | Path to Chromium binary |

### `findChromium()`

Returns the path to a detected Chromium binary, or `null` if not found.

## How It Works

1. Launches Chromium with `--headless --remote-debugging-port`
2. Connects directly to Chrome DevTools Protocol via WebSocket
3. Navigates to the HTML content and calls `Page.printToPDF`
4. Kills the browser process and returns the PDF buffer
5. All operations have timeouts — Chromium crashes cannot hang the caller
