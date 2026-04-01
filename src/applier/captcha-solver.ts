/**
 * CAPTCHA Solver — integrates with 2Captcha API
 * Supports: reCAPTCHA v2, hCaptcha, Cloudflare Turnstile
 *
 * Flow:
 * 1. Detect CAPTCHA type on page
 * 2. Extract sitekey and page URL
 * 3. Send to 2Captcha API
 * 4. Poll for solution (20-60 seconds)
 * 5. Inject solution into page
 */

import { Page } from "playwright";

const API_KEY = process.env.TWOCAPTCHA_API_KEY || "";
const BASE = "https://2captcha.com";

interface CaptchaInfo {
  type: "recaptcha" | "hcaptcha" | "turnstile" | null;
  sitekey: string;
  pageUrl: string;
}

/**
 * Detect which CAPTCHA type is on the page and extract sitekey
 */
export async function detectCaptcha(page: Page): Promise<CaptchaInfo> {
  const pageUrl = page.url();

  const info = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;

    // reCAPTCHA v2
    const recaptchaEl = document.querySelector("[data-sitekey]") ||
      document.querySelector(".g-recaptcha") ||
      document.querySelector("iframe[src*='recaptcha']");
    if (recaptchaEl) {
      const sitekey = recaptchaEl.getAttribute("data-sitekey") ||
        (html.match(/data-sitekey="([^"]+)"/) || [])[1] ||
        (html.match(/sitekey:\s*['"]([^'"]+)['"]/) || [])[1] || "";
      return { type: "recaptcha" as const, sitekey };
    }

    // hCaptcha
    const hcaptchaEl = document.querySelector("[data-sitekey].h-captcha") ||
      document.querySelector("iframe[src*='hcaptcha']");
    if (hcaptchaEl) {
      const sitekey = hcaptchaEl.getAttribute("data-sitekey") ||
        (html.match(/data-sitekey="([^"]+)"/) || [])[1] || "";
      return { type: "hcaptcha" as const, sitekey };
    }

    // Cloudflare Turnstile
    const turnstileEl = document.querySelector(".cf-turnstile") ||
      document.querySelector("iframe[src*='challenges.cloudflare']");
    if (turnstileEl) {
      const sitekey = turnstileEl.getAttribute("data-sitekey") ||
        (html.match(/data-sitekey="([^"]+)"/) || [])[1] || "";
      return { type: "turnstile" as const, sitekey };
    }

    // Check for generic CAPTCHA indicators
    if (html.includes("recaptcha") || html.includes("g-recaptcha")) {
      const sitekey = (html.match(/sitekey['":\s]+['"]([0-9a-zA-Z_-]{40})['"]/) || [])[1] || "";
      return { type: "recaptcha" as const, sitekey };
    }

    if (html.includes("hcaptcha")) {
      const sitekey = (html.match(/sitekey['":\s]+['"]([0-9a-f-]{36})['"]/) || [])[1] || "";
      return { type: "hcaptcha" as const, sitekey };
    }

    return { type: null, sitekey: "" };
  });

  return { ...info, pageUrl } as CaptchaInfo;
}

/**
 * Solve a CAPTCHA using 2Captcha API
 * Returns the solution token or null if failed
 */
export async function solveCaptcha(info: CaptchaInfo): Promise<string | null> {
  if (!API_KEY) {
    console.log("[captcha] No 2Captcha API key configured (TWOCAPTCHA_API_KEY)");
    return null;
  }
  if (!info.type || !info.sitekey) {
    console.log("[captcha] Could not detect CAPTCHA type or sitekey");
    return null;
  }

  console.log(`[captcha] Solving ${info.type} (sitekey: ${info.sitekey.substring(0, 10)}...)`);

  try {
    // Step 1: Submit CAPTCHA to 2Captcha
    const submitParams = new URLSearchParams({
      key: API_KEY,
      method: info.type === "recaptcha" ? "userrecaptcha" :
              info.type === "hcaptcha" ? "hcaptcha" : "turnstile",
      sitekey: info.sitekey,
      pageurl: info.pageUrl,
      json: "1",
    });

    const submitRes = await fetch(`${BASE}/in.php?${submitParams}`);
    const submitData = await submitRes.json() as { status: number; request: string };

    if (submitData.status !== 1) {
      console.error("[captcha] Submit failed:", submitData.request);
      return null;
    }

    const taskId = submitData.request;
    console.log(`[captcha] Task submitted: ${taskId}`);

    // Step 2: Poll for solution (max 120 seconds)
    const maxWait = 120000;
    const pollInterval = 5000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));

      const resultRes = await fetch(
        `${BASE}/res.php?key=${API_KEY}&action=get&id=${taskId}&json=1`
      );
      const resultData = await resultRes.json() as { status: number; request: string };

      if (resultData.status === 1) {
        console.log(`[captcha] Solved in ${Math.round((Date.now() - start) / 1000)}s`);
        return resultData.request; // The solution token
      }

      if (resultData.request !== "CAPCHA_NOT_READY") {
        console.error("[captcha] Error:", resultData.request);
        return null;
      }
    }

    console.error("[captcha] Timeout after 120s");
    return null;
  } catch (err) {
    console.error("[captcha] Error:", (err as Error).message);
    return null;
  }
}

/**
 * Inject CAPTCHA solution into the page
 */
export async function injectSolution(page: Page, info: CaptchaInfo, token: string): Promise<boolean> {
  try {
    if (info.type === "recaptcha") {
      await page.evaluate((t) => {
        // Set the response textarea
        const textarea = document.querySelector("#g-recaptcha-response") ||
          document.querySelector("[name='g-recaptcha-response']");
        if (textarea) {
          (textarea as HTMLTextAreaElement).value = t;
          (textarea as HTMLTextAreaElement).style.display = "block"; // unhide for some implementations
        }
        // Call the callback if it exists
        if ((window as unknown as Record<string, unknown>).___grecaptcha_cfg) {
          const clients = ((window as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>).___grecaptcha_cfg).clients;
          if (clients) {
            for (const key of Object.keys(clients)) {
              const client = clients[key];
              for (const k2 of Object.keys(client)) {
                const obj = client[k2];
                if (obj && typeof obj === "object") {
                  for (const k3 of Object.keys(obj)) {
                    if (typeof (obj as Record<string, unknown>)[k3] === "function") {
                      try { ((obj as Record<string, CallableFunction>)[k3])(t); } catch {}
                    }
                  }
                }
              }
            }
          }
        }
      }, token);
      console.log("[captcha] reCAPTCHA solution injected");
      return true;
    }

    if (info.type === "hcaptcha") {
      await page.evaluate((t) => {
        const textarea = document.querySelector("[name='h-captcha-response']") ||
          document.querySelector("textarea[name*='hcaptcha']");
        if (textarea) (textarea as HTMLTextAreaElement).value = t;
        // Try to call hcaptcha callback
        if ((window as unknown as Record<string, { getResponse?: () => string }>).hcaptcha) {
          try {
            document.querySelector("iframe[src*='hcaptcha']")?.dispatchEvent(new Event("load"));
          } catch {}
        }
      }, token);
      console.log("[captcha] hCaptcha solution injected");
      return true;
    }

    if (info.type === "turnstile") {
      await page.evaluate((t) => {
        const input = document.querySelector("[name='cf-turnstile-response']") ||
          document.querySelector("input[name*='turnstile']");
        if (input) (input as HTMLInputElement).value = t;
        // Try Turnstile callback
        if ((window as unknown as Record<string, Record<string, CallableFunction>>).turnstile) {
          try {
            const w = window as unknown as Record<string, Record<string, CallableFunction>>;
            w.turnstile.getResponse = () => t;
          } catch {}
        }
      }, token);
      console.log("[captcha] Turnstile solution injected");
      return true;
    }

    return false;
  } catch (err) {
    console.error("[captcha] Injection failed:", (err as Error).message);
    return false;
  }
}

/**
 * Full CAPTCHA solve flow: detect → solve → inject
 * Returns true if solved, false if failed or no CAPTCHA
 */
export async function handleCaptcha(page: Page): Promise<boolean> {
  const info = await detectCaptcha(page);
  if (!info.type) return false; // No CAPTCHA detected

  console.log(`[captcha] Detected ${info.type} on ${info.pageUrl}`);

  const token = await solveCaptcha(info);
  if (!token) return false;

  const injected = await injectSolution(page, info, token);
  if (!injected) return false;

  // Wait a moment for the page to process the solution
  await new Promise(r => setTimeout(r, 2000));
  return true;
}
