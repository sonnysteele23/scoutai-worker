import type { Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let _browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    const { chromium } = require("playwright");
    _browser = await chromium.launch({
      headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,900",
      ],
    });
    console.log("[browser] Chromium launched");
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
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: [],
  });

  // Mask automation signals
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
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
 */
export async function hasCaptcha(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body.innerText.toLowerCase());
  const src = await page.content();
  return (
    text.includes("prove you're human") ||
    text.includes("i'm not a robot") ||
    src.includes("recaptcha") ||
    src.includes("hcaptcha") ||
    src.includes("turnstile") ||
    src.includes("cf-challenge")
  );
}
