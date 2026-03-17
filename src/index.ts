// @easykit/pdf — Zero-dependency HTML→PDF via Chromium CDP
// Direct Chrome DevTools Protocol over WebSocket — no puppeteer, no playwright

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PdfMargins {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export type PaperFormat = "A3" | "A4" | "A5" | "Legal" | "Letter" | "Tabloid";
export type Orientation = "portrait" | "landscape";

export interface GeneratePdfOptions {
  /** HTML content to convert to PDF */
  html: string;
  /** HTML template for page header */
  header?: string;
  /** HTML template for page footer */
  footer?: string;
  /** Auto-generate footer with page numbers */
  pageNumbers?: boolean;
  /** Generate table of contents from headings */
  toc?: boolean;
  /** Page orientation (default: "portrait") */
  orientation?: Orientation;
  /** Paper format (default: "A4") */
  format?: PaperFormat;
  /** Page margins */
  margins?: PdfMargins;
  /** Timeout in ms for the entire operation (default: 30000) */
  timeout?: number;
  /** Path to Chromium binary (auto-detected if not provided) */
  chromiumPath?: string;
}

// ─── Paper Sizes (inches) ────────────────────────────────────────────────────

const PAPER_SIZES: Record<PaperFormat, { width: number; height: number }> = {
  A3: { width: 11.69, height: 16.54 },
  A4: { width: 8.27, height: 11.69 },
  A5: { width: 5.83, height: 8.27 },
  Legal: { width: 8.5, height: 14 },
  Letter: { width: 8.5, height: 11 },
  Tabloid: { width: 11, height: 17 },
};

// ─── Chromium Discovery ──────────────────────────────────────────────────────

const CHROMIUM_PATHS = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  // Docker / Alpine
  "/usr/lib/chromium/chromium",
  "/headless-shell/headless-shell",
];

/**
 * Find a Chromium binary on the system.
 * Returns the path or null if not found.
 */
export async function findChromium(): Promise<string | null> {
  for (const path of CHROMIUM_PATHS) {
    try {
      const file = Bun.file(path);
      if (await file.exists()) return path;
    } catch {
      // not accessible, continue
    }
  }

  // Try `which` as fallback
  try {
    const proc = Bun.spawn(["which", "google-chrome", "chromium", "chromium-browser"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const found = text.trim().split("\n")[0]?.trim();
    if (found && found.length > 0) return found;
  } catch {
    // which not available or no results
  }

  return null;
}

// ─── Margin Parsing ──────────────────────────────────────────────────────────

function parseMargin(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const trimmed = value.trim().toLowerCase();

  if (trimmed.endsWith("mm")) {
    return parseFloat(trimmed) / 25.4;
  }
  if (trimmed.endsWith("cm")) {
    return parseFloat(trimmed) / 2.54;
  }
  if (trimmed.endsWith("in")) {
    return parseFloat(trimmed);
  }
  if (trimmed.endsWith("px")) {
    return parseFloat(trimmed) / 96;
  }

  // Assume mm if no unit
  const num = parseFloat(trimmed);
  return isNaN(num) ? defaultValue : num / 25.4;
}

// ─── TOC Generation ──────────────────────────────────────────────────────────

function injectToc(html: string): string {
  const headingRegex = /<h([1-3])[^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  const headings: { level: number; text: string; id: string }[] = [];
  let match: RegExpExecArray | null;
  let idCounter = 0;

  // Collect headings
  while ((match = headingRegex.exec(html)) !== null) {
    const level = parseInt(match[1]!, 10);
    const text = match[2]!.replace(/<[^>]+>/g, "").trim();
    const id = `toc-${idCounter++}`;
    headings.push({ level, text, id });
  }

  if (headings.length === 0) return html;

  // Build TOC HTML
  const tocItems = headings
    .map((h) => {
      const indent = (h.level - 1) * 20;
      return `<div style="margin-left:${indent}px;padding:2px 0"><a href="#${h.id}" style="text-decoration:none;color:#333">${h.text}</a></div>`;
    })
    .join("\n");

  const tocHtml = `
<div id="table-of-contents" style="page-break-after:always;padding:20px">
  <h2 style="margin-bottom:16px">Table of Contents</h2>
  ${tocItems}
</div>`;

  // Add IDs to headings in the HTML
  let modifiedHtml = html;
  idCounter = 0;
  modifiedHtml = modifiedHtml.replace(/<h([1-3])([^>]*)>/gi, (_full, level: string, attrs: string) => {
    const id = `toc-${idCounter++}`;
    return `<h${level}${attrs} id="${id}">`;
  });

  // Insert TOC after <body> or at the beginning
  const bodyMatch = modifiedHtml.match(/<body[^>]*>/i);
  if (bodyMatch) {
    const insertPos = (bodyMatch.index ?? 0) + bodyMatch[0].length;
    return modifiedHtml.slice(0, insertPos) + tocHtml + modifiedHtml.slice(insertPos);
  }

  return tocHtml + modifiedHtml;
}

// ─── Page Number Footer ──────────────────────────────────────────────────────

const DEFAULT_PAGE_NUMBER_FOOTER = `
<div style="font-size:10px;text-align:center;width:100%;padding:5px 0;color:#666">
  <span class="pageNumber"></span> / <span class="totalPages"></span>
</div>`;

// ─── CDP Communication ───────────────────────────────────────────────────────

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class CdpConnection {
  private ws: WebSocket;
  private messageId = 0;
  private pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private ready: Promise<void>;

  constructor(wsUrl: string, private operationTimeout: number) {
    this.ws = new WebSocket(wsUrl);

    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket connection timeout")), 10000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket connection failed"));
      };
    });

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as CdpResponse;
        const pending = this.pending.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(data.id);
          if (data.error) {
            pending.reject(new Error(`CDP error: ${data.error.message}`));
          } else {
            pending.resolve(data.result ?? {});
          }
        }
      } catch {
        // Malformed message, ignore
      }
    };

    this.ws.onclose = () => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed unexpectedly"));
        this.pending.delete(id);
      }
    };
  }

  async waitForReady(): Promise<void> {
    return this.ready;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.messageId;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${this.operationTimeout}ms)`));
      }, this.operationTimeout);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err: unknown) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP connection closing"));
      this.pending.delete(id);
    }
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// ─── Process Management ──────────────────────────────────────────────────────

async function launchChromium(chromiumPath: string, timeout: number): Promise<{ proc: ReturnType<typeof Bun.spawn>; wsUrl: string }> {
  const port = 9222 + Math.floor(Math.random() * 1000);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ];

  const proc = Bun.spawn([chromiumPath, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });

  // Poll for CDP endpoint
  const deadline = Date.now() + timeout;
  let wsUrl: string | null = null;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) {
        const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) {
          wsUrl = data.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!wsUrl) {
    proc.kill();
    throw new Error(`Chromium failed to start within ${timeout}ms`);
  }

  return { proc, wsUrl };
}

function killProcess(proc: ReturnType<typeof Bun.spawn>): void {
  try {
    proc.kill();
  } catch {
    // Already dead
  }

  // Force kill after 3s
  setTimeout(() => {
    try {
      proc.kill(9);
    } catch {
      // Already dead
    }
  }, 3000);
}

// ─── Main API ────────────────────────────────────────────────────────────────

/**
 * Generate a PDF from HTML content using Chromium CDP.
 *
 * @returns PDF as a Buffer
 * @throws Error if Chromium is not found or conversion fails
 */
export async function generatePdf(options: GeneratePdfOptions): Promise<Buffer> {
  const {
    html: rawHtml,
    header,
    footer,
    pageNumbers = false,
    toc = false,
    orientation = "portrait",
    format = "A4",
    margins,
    timeout = 30000,
    chromiumPath: customPath,
  } = options;

  // Find Chromium
  const chromiumPath = customPath ?? (await findChromium());
  if (!chromiumPath) {
    throw new Error(
      "Chromium not found. Install Google Chrome or Chromium, or provide chromiumPath option."
    );
  }

  // Prepare HTML
  let html = rawHtml;
  if (toc) {
    html = injectToc(html);
  }

  // Resolve paper size
  const paper = PAPER_SIZES[format] ?? PAPER_SIZES.A4;
  const landscape = orientation === "landscape";
  const paperWidth = landscape ? paper.height : paper.width;
  const paperHeight = landscape ? paper.width : paper.height;

  // Resolve margins (in inches)
  const defaultMargin = 0.39; // ~10mm
  const marginTop = parseMargin(margins?.top, defaultMargin);
  const marginRight = parseMargin(margins?.right, defaultMargin);
  const marginBottom = parseMargin(margins?.bottom, defaultMargin);
  const marginLeft = parseMargin(margins?.left, defaultMargin);

  // Resolve header/footer
  const displayHeaderFooter = !!(header || footer || pageNumbers);
  const headerTemplate = header ?? "<span></span>";
  const footerTemplate = footer ?? (pageNumbers ? DEFAULT_PAGE_NUMBER_FOOTER : "<span></span>");

  // Overall timeout guard
  const deadline = Date.now() + timeout;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let cdp: CdpConnection | null = null;

  try {
    // Launch Chromium
    const launchTimeout = Math.min(15000, timeout / 2);
    const launch = await launchChromium(chromiumPath, launchTimeout);
    proc = launch.proc;

    // Connect via CDP
    const operationTimeout = Math.max(5000, deadline - Date.now());
    cdp = new CdpConnection(launch.wsUrl, operationTimeout);
    await cdp.waitForReady();

    // Enable Page domain
    await cdp.send("Page.enable");

    // Navigate to data URL with HTML content
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await cdp.send("Page.navigate", { url: dataUrl });

    // Wait for page load
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Page load timeout")), Math.max(5000, deadline - Date.now()));

      // Give the page time to render
      const checkLoaded = async () => {
        try {
          const result = await cdp!.send("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          });
          const value = (result?.result as Record<string, unknown>)?.value;
          if (value === "complete" || value === "interactive") {
            clearTimeout(timer);
            // Small delay for rendering
            setTimeout(resolve, 200);
          } else {
            setTimeout(checkLoaded, 100);
          }
        } catch {
          clearTimeout(timer);
          resolve(); // Proceed anyway
        }
      };
      checkLoaded();
    });

    // Check deadline
    if (Date.now() >= deadline) {
      throw new Error("PDF generation timeout exceeded");
    }

    // Generate PDF
    const printParams: Record<string, unknown> = {
      landscape,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      printBackground: true,
      paperWidth,
      paperHeight,
      marginTop,
      marginRight,
      marginBottom,
      marginLeft,
      preferCSSPageSize: false,
    };

    const result = await cdp.send("Page.printToPDF", printParams);
    const base64Data = result.data as string | undefined;

    if (!base64Data) {
      throw new Error("CDP returned empty PDF data");
    }

    return Buffer.from(base64Data, "base64");
  } finally {
    // Cleanup — never leak processes
    if (cdp) {
      cdp.close();
    }
    if (proc) {
      killProcess(proc);
    }
  }
}
