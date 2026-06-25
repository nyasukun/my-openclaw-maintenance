// Headless render/verify engine for Workspace Artifacts.
//
// Loaded lazily by the supervisor only when a verify request arrives, so the
// normal HTTP/WS proxy path never imports Playwright. Renders a URL (a served
// dynamic app or a `file://` static artifact) in headless Chromium, captures a
// screenshot and structured diagnostics (console errors, uncaught page errors,
// failed network requests), and returns them.

import { chromium } from "playwright";

/**
 * @param {object} opts
 * @param {string} opts.url               URL to load (http(s):// or file://).
 * @param {{width:number,height:number}} [opts.viewport]
 * @param {boolean} [opts.fullPage]       Capture the full scrollable page.
 * @param {"load"|"domcontentloaded"|"networkidle"} [opts.waitUntil]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.settleMs]        Extra settle time after load (animations).
 * @returns {Promise<{ screenshot: Buffer, result: object }>}
 */
export async function renderArtifact(opts) {
  const {
    url,
    viewport = { width: 1280, height: 800 },
    fullPage = true,
    waitUntil = "networkidle",
    timeoutMs = 30_000,
    settleMs = 400,
  } = opts;

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message || String(err)));
    page.on("requestfailed", (req) => {
      failedRequests.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText ?? "failed" });
    });

    let status = null;
    try {
      const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
      status = response ? response.status() : null;
    } catch (err) {
      pageErrors.push(`navigation: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (settleMs > 0) await page.waitForTimeout(settleMs);

    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    const screenshot = await page.screenshot({ fullPage, type: "png" });

    const result = {
      ok: pageErrors.length === 0 && consoleErrors.length === 0 && (status === null || status < 400),
      finalUrl,
      status,
      title,
      consoleErrors,
      pageErrors,
      failedRequests,
    };
    return { screenshot, result };
  } finally {
    await browser.close().catch(() => {});
  }
}
