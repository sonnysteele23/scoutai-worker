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

// 2Captcha — supports all CAPTCHA types with one API key
const API_KEY = process.env.TWOCAPTCHA_API_KEY || "";
const BASE = "https://2captcha.com";

interface CaptchaInfo {
  type: "recaptcha" | "hcaptcha" | "turnstile" | null;
  sitekey: string;
  pageUrl: string;
  rqdata?: string; // hCaptcha Enterprise rqdata token
}

/**
 * Detect which CAPTCHA type is on the page and extract sitekey
 */
export async function detectCaptcha(page: Page): Promise<CaptchaInfo> {
  const pageUrl = page.url();

  const info = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;

    // ── Scan for ALL CAPTCHA types at once ──────────────────────────────
    const signals = {
      hcaptcha: {
        iframe: !!document.querySelector("iframe[src*='hcaptcha']"),
        element: !!document.querySelector(".h-captcha"),
        widget: !!document.querySelector("[data-hcaptcha-widget-id]"),
        inHtml: html.includes("hcaptcha.com") || html.includes("h-captcha"),
      },
      recaptcha: {
        iframe: !!document.querySelector("iframe[src*='recaptcha']"),
        element: !!document.querySelector(".g-recaptcha"),
        inHtml: html.includes("google.com/recaptcha") || html.includes("g-recaptcha"),
      },
      turnstile: {
        iframe: !!document.querySelector("iframe[src*='challenges.cloudflare']"),
        element: !!document.querySelector(".cf-turnstile"),
        inHtml: html.includes("challenges.cloudflare.com/turnstile"),
      },
    };

    // Count signals for each type — strongest match wins
    const scores = {
      hcaptcha: +signals.hcaptcha.iframe * 3 + +signals.hcaptcha.element * 2 + +signals.hcaptcha.widget * 2 + +signals.hcaptcha.inHtml,
      recaptcha: +signals.recaptcha.iframe * 3 + +signals.recaptcha.element * 2 + +signals.recaptcha.inHtml,
      turnstile: +signals.turnstile.iframe * 3 + +signals.turnstile.element * 2 + +signals.turnstile.inHtml,
    };

    console.log("[captcha-detect] Signals:", JSON.stringify(signals));
    console.log("[captcha-detect] Scores:", JSON.stringify(scores));

    // Pick the type with the highest score
    const best = Object.entries(scores)
      .filter(([, score]) => score > 0)
      .sort(([, a], [, b]) => b - a)[0];

    if (!best) return { type: null, sitekey: "" };

    const type = best[0] as "hcaptcha" | "recaptcha" | "turnstile";

    // Extract sitekey based on detected type
    let sitekey = "";
    if (type === "hcaptcha") {
      const el = document.querySelector(".h-captcha[data-sitekey]") ||
        document.querySelector(".h-captcha") ||
        document.querySelector("[data-hcaptcha-widget-id]");
      sitekey = el?.getAttribute("data-sitekey") || "";
    } else if (type === "recaptcha") {
      const el = document.querySelector(".g-recaptcha[data-sitekey]");
      sitekey = el?.getAttribute("data-sitekey") || "";
    } else if (type === "turnstile") {
      const el = document.querySelector(".cf-turnstile[data-sitekey]");
      sitekey = el?.getAttribute("data-sitekey") || "";
    }

    // Fallback: grab any data-sitekey on the page
    if (!sitekey) {
      sitekey = document.querySelector("[data-sitekey]")?.getAttribute("data-sitekey") ||
        (html.match(/data-sitekey="([^"]+)"/) || [])[1] || "";
    }

    // Extract hCaptcha Enterprise rqdata if present
    let rqdata = "";
    if (type === "hcaptcha") {
      const hcEl = document.querySelector(".h-captcha");
      rqdata = hcEl?.getAttribute("data-rqdata") ||
        (html.match(/data-rqdata="([^"]+)"/) || [])[1] || "";
    }

    console.log(`[captcha-detect] Winner: ${type} (score: ${best[1]}), sitekey: ${sitekey.substring(0, 20)}..., rqdata: ${rqdata ? "yes" : "no"}`);
    return { type, sitekey, rqdata };
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
    console.log(`[captcha] Could not detect CAPTCHA type or sitekey — type: ${info.type}, sitekey: "${info.sitekey}", url: ${info.pageUrl}`);
    return null;
  }

  console.log(`[captcha] Solving ${info.type} via 2Captcha (sitekey: ${info.sitekey.substring(0, 10)}...)`);

  try {
    // Step 1: Submit CAPTCHA to 2Captcha
    const method = info.type === "recaptcha" ? "userrecaptcha" :
                   info.type === "hcaptcha" ? "hcaptcha" : "turnstile";

    const submitParams = new URLSearchParams({
      key: API_KEY,
      method,
      sitekey: info.sitekey,
      pageurl: info.pageUrl,
      json: "1",
    });

    // For hCaptcha: try Enterprise mode with rqdata if available
    if (info.type === "hcaptcha") {
      submitParams.set("data", info.rqdata || "");
      // Tell 2Captcha this might be Enterprise hCaptcha
      if (info.rqdata) {
        submitParams.set("enterprise", "1");
      }
    }

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
        return resultData.request;
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
  if (!info.type) {
    console.log("[captcha] handleCaptcha: no type detected");
    return false;
  }

  console.log(`[captcha] Detected ${info.type} on ${info.pageUrl} (sitekey: ${info.sitekey?.substring(0, 20) || "EMPTY"})`);

  if (!info.sitekey) {
    console.error(`[captcha] Sitekey is empty for ${info.type} — cannot solve`);
    return false;
  }

  const token = await solveCaptcha(info);
  if (!token) {
    console.error("[captcha] solveCaptcha returned null — solve failed");
    return false;
  }

  const injected = await injectSolution(page, info, token);
  if (!injected) return false;

  // Wait a moment for the page to process the solution
  await new Promise(r => setTimeout(r, 2000));
  return true;
}
