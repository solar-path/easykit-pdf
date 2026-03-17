# @easykit/pdf

Shared PDF generation package — HTML→PDF via Chromium CDP. Zero npm dependencies, Bun runtime.

## Principles
- Zero npm dependencies — Bun built-in APIs + Chromium CDP via fetch
- No puppeteer, no playwright — direct Chrome DevTools Protocol
- TypeScript strict mode, no `any`, use `unknown` + narrowing
- Maximum resilience — Chromium crash/timeout never crashes the calling process
- Timeouts on all CDP operations, graceful retry

## API
- `generatePdf(options)` — HTML string → PDF Buffer
- `findChromium()` — locate Chromium binary on the system

## CDP Approach
1. Launch Chromium headless with `--remote-debugging-port`
2. Connect via WebSocket to CDP endpoint
3. `Page.navigate` + `Page.printToPDF` with options
4. Graceful shutdown with kill fallback

## Testing
```bash
bun test
```
