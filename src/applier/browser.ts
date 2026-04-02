import type { Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let _browser: Browser | null = null;

// Parse proxy URL: http://user:pass@host:port or host:port
function getProxyConfig(): { server: string; username?: string; password?: string } | undefined {
  const proxy = process.env.PROXY_URL?.trim();
  if (!proxy) return undefined;
  try {
    const url = new URL(proxy.startsWith("http") ? proxy : `http://${proxy}`);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    console.warn("[browser] Invalid PROXY_URL:", proxy);
    return undefined;
  }
}

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    const { chromium } = require("playwright");
    const proxy = getProxyConfig();
    _browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
      proxy: proxy ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-web-security",
        "--window-size=1280,900",
        "--lang=en-US,en",
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
      ],
    });
    console.log(`[browser] Chromium launched (stealth mode${proxy ? " + proxy" : ""})`);
  }
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) { await _browser.close(); _browser = null; }
}

/**
 * Create a stealth context that looks more human.
 */
export async function createContext(browser: Browser): Promise<BrowserContext> {
  // Randomize viewport slightly to avoid fingerprint matching
  const w = 1280 + Math.floor(Math.random() * 40) - 20;
  const h = 900 + Math.floor(Math.random() * 40) - 20;

  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: w, height: h },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: [],
    deviceScaleFactor: 2,
    hasTouch: false,
    isMobile: false,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true, // Required for residential proxy HTTPS interception
  });

  // Comprehensive anti-detection: mask automation signals
  await ctx.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });

    // Add chrome runtime object
    const w = window as unknown as Record<string, unknown>;
    w.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };

    // Spoof plugins (real browsers have plugins)
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
        { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
        { name: "Native Client", filename: "internal-nacl-plugin" },
      ],
    });

    // Spoof languages
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

    // Fix permissions API
    const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params: PermissionDescriptor) => {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "denied", onchange: null } as PermissionStatus);
      }
      return origQuery(params);
    };

    // Spoof hardware concurrency
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });

    // Spoof WebGL vendor/renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param: number) {
      if (param === 37445) return "Intel Inc.";
      if (param === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, param);
    };
  });

  return ctx;
}

/**
 * Get page accessibility snapshot — what the AI uses to understand the form.
 * Returns cleaned text representation of all interactive elements.
 */
export async function getPageSnapshot(page: Page): Promise<string> {
  // Wait for network idle and main content
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  // Extract all form fields with labels
  const snapshot = await page.evaluate(() => {
    const lines: string[] = [];
    const seen = new Set<string>();

    // Get all input, select, textarea elements
    const elements = document.querySelectorAll<HTMLElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea, [role=combobox], [role=listbox]"
    );

    elements.forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el as HTMLInputElement).type || tag;
      const name = (el as HTMLInputElement).name || el.id || "";
      const placeholder = (el as HTMLInputElement).placeholder || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const ariaLabelledBy = el.getAttribute("aria-labelledby");

      // Find associated label
      let labelText = "";
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) labelText = lbl.textContent?.trim() || "";
      }
      if (!labelText && ariaLabel) labelText = ariaLabel;
      if (!labelText && ariaLabelledBy) {
        const lblEl = document.getElementById(ariaLabelledBy);
        if (lblEl) labelText = lblEl.textContent?.trim() || "";
      }
      if (!labelText) {
        // Walk up to find wrapping label
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++) {
          const t = p.tagName.toLowerCase();
          if (t === "label") { labelText = p.textContent?.trim().replace(/\s+/g, " ") || ""; break; }
          p = p.parentElement;
        }
      }

      const key = `${labelText}_${name}_${type}`;
      if (seen.has(key)) return;
      seen.add(key);

      // Build selector
      const selector = el.id ? `#${el.id}` :
        name ? `[name="${name}"]` :
        ariaLabel ? `[aria-label="${ariaLabel}"]` : tag;

      const required = (el as HTMLInputElement).required ? " (required)" : "";

      if (type === "select" || tag === "select") {
        const opts = Array.from((el as HTMLSelectElement).options).map(o => o.text).slice(0, 10).join("|");
        lines.push(`SELECT${required} | label: "${labelText || placeholder}" | selector: ${selector} | options: ${opts}`);
      } else if (type === "radio") {
        lines.push(`RADIO${required} | label: "${labelText || placeholder}" | selector: ${selector} | name: ${name}`);
      } else if (type === "checkbox") {
        lines.push(`CHECKBOX | label: "${labelText || placeholder}" | selector: ${selector}`);
      } else if (type === "file") {
        lines.push(`FILE UPLOAD | label: "${labelText || placeholder}" | selector: ${selector}`);
      } else if (tag === "textarea") {
        lines.push(`TEXTAREA${required} | label: "${labelText || placeholder}" | selector: ${selector}`);
      } else {
        lines.push(`INPUT[${type}]${required} | label: "${labelText || placeholder || name}" | selector: ${selector}`);
      }
    });

    return lines.join("\n");
  });

  return snapshot;
}

/**
 * Write resume PDF to a temp file, return path.
 * Caller is responsible for deleting after upload.
 */
export function writeTempResume(base64: string, fileName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutai-"));
  const filePath = path.join(dir, fileName.endsWith(".pdf") ? fileName : fileName + ".pdf");
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

/**
 * Take a screenshot and return as base64 PNG.
 */
export async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  return buf.toString("base64");
}

/**
 * Detect CAPTCHA on page.
 * Only triggers on visible CAPTCHA elements or challenge pages — not just script includes.
 */
export async function hasCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();

    // Visible challenge text
    if (text.includes("prove you're human") || text.includes("i'm not a robot")) return true;

    // Cloudflare challenge page (full-page block, not just a script tag)
    if (text.includes("checking your browser") || text.includes("verify you are human")) return true;

    // Visible reCAPTCHA widget (not just a script loaded in background)
    const recaptchaVisible = document.querySelector(".g-recaptcha, #g-recaptcha, iframe[src*='recaptcha/api2/anchor'], iframe[src*='recaptcha/api2/bframe']");
    if (recaptchaVisible) return true;

    // Visible hCaptcha widget
    const hcaptchaVisible = document.querySelector(".h-captcha, iframe[src*='hcaptcha.com']");
    if (hcaptchaVisible) return true;

    // Cloudflare Turnstile widget (visible, not just script)
    const turnstileVisible = document.querySelector(".cf-turnstile, iframe[src*='challenges.cloudflare.com']");
    if (turnstileVisible) return true;

    // Full-page Cloudflare challenge
    if (document.querySelector("#challenge-form, #cf-challenge-running")) return true;

    return false;
  });
}

// ─── Human-like behavior utilities ──────────────────────────────────────────

/** Random delay between min and max ms */
export function humanDelay(min = 500, max = 2000): Promise<void> {
  const ms = min + Math.floor(Math.random() * (max - min));
  return new Promise(r => setTimeout(r, ms));
}

/** Move mouse to element with human-like curve before clicking */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first();
  if (!await el.isVisible({ timeout: 3000 }).catch(() => false)) return;

  const box = await el.boundingBox();
  if (!box) return;

  // Random offset within the element (don't always click dead center)
  const x = box.x + box.width * (0.2 + Math.random() * 0.6);
  const y = box.y + box.height * (0.2 + Math.random() * 0.6);

  // Move mouse with steps (simulates human movement)
  await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 12) });
  await humanDelay(50, 200);
  await page.mouse.click(x, y);
}

/** Type text with variable speed like a human */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector).first();
  if (!await el.isVisible({ timeout: 3000 }).catch(() => false)) return;

  await humanClick(page, selector);
  await humanDelay(200, 500);

  // Clear existing text
  await el.fill("");
  await humanDelay(100, 300);

  // Type character by character with variable delay
  for (const char of text) {
    await page.keyboard.type(char, { delay: 30 + Math.floor(Math.random() * 80) });
    // Occasional longer pause (thinking)
    if (Math.random() < 0.05) await humanDelay(300, 800);
  }
}

/** Scroll page like a human (not instant) */
export async function humanScroll(page: Page, distance = 400): Promise<void> {
  const steps = 3 + Math.floor(Math.random() * 5);
  const stepDist = distance / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDist);
    await humanDelay(50, 150);
  }
  await humanDelay(300, 800);
}

/** Random mouse movement to simulate reading/scanning */
export async function humanScan(page: Page): Promise<void> {
  const moves = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < moves; i++) {
    const x = 200 + Math.floor(Math.random() * 800);
    const y = 100 + Math.floor(Math.random() * 600);
    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
    await humanDelay(200, 600);
  }
}
