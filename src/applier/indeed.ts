/**
 * Indeed "Easy Apply" applier
 *
 * Indeed's apply flow is multi-step (wizard):
 *   Step 1: Resume upload (or use Indeed resume)
 *   Step 2: Contact info (name, email, phone)
 *   Step 3: Custom employer questions
 *   Step 4: Review and submit
 *
 * URL patterns:
 *   indeed.com/viewjob, indeed.com/rc/clk, indeed.com/applystart
 *
 * Notes:
 *   - Indeed may require login — if detected, return "unsupported"
 *   - Each step has a "Continue" button to advance
 *   - The final step has a "Submit your application" button
 *   - Indeed uses iframes for some apply modals
 */
import { Page } from "playwright";
import { ApplicationProfile, FilledField } from "../types";
import { analyzeFormAndFill, answerCustomQuestion } from "./claude";
import {
  getPageSnapshot,
  hasCaptcha,
  screenshot,
  writeTempResume,
  humanDelay,
  humanScroll,
  humanScan,
} from "./browser";
import { handleCaptcha } from "./captcha-solver";
import * as fs from "fs";

export interface IndeedResult {
  success: boolean;
  questionsAnswered: { question: string; answer: string }[];
  confirmationScreenshot?: string;
  failureReason?: string;
  failureCategory?: "captcha" | "missing_field" | "custom_question" | "timeout" | "login_required" | "other";
}

/** Maximum number of wizard steps before we bail out (safety valve) */
const MAX_STEPS = 12;

export async function applyIndeed(
  page: Page,
  applyUrl: string,
  profile: ApplicationProfile,
  resumeBase64: string,
  resumeFileName: string,
  coverLetterText: string,
  jobTitle: string,
  company: string,
  jobDescription: string,
  dryRun = false
): Promise<IndeedResult> {
  const questionsAnswered: { question: string; answer: string }[] = [];

  try {
    console.log(`[indeed] Navigating to ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // ── Wait for Cloudflare challenge ────────────────────────────────────
    await waitForCloudflare(page);

    // Human-like initial behavior
    await humanDelay(2000, 4000);
    await humanScan(page);
    await humanScroll(page, 200);
    await humanDelay(500, 1500);

    // ── Dismiss cookie consent ───────────────────────────────────────────
    await dismissCookieDialogs(page);

    // ── Check for login wall ─────────────────────────────────────────────
    if (await isLoginRequired(page)) {
      console.log("[indeed] Login required — returning unsupported");
      const shot = await screenshot(page);
      return {
        success: false,
        questionsAnswered,
        confirmationScreenshot: shot,
        failureReason: "Indeed requires login to apply. Please link your Indeed account or apply manually.",
        failureCategory: "login_required",
      };
    }

    // ── Check for pre-form CAPTCHA ───────────────────────────────────────
    if (await hasCaptcha(page)) {
      console.log("[indeed] CAPTCHA detected — attempting to solve...");
      const solved = await handleCaptcha(page);
      if (!solved) {
        return {
          success: false,
          questionsAnswered,
          failureReason: "CAPTCHA detected — solver unavailable or failed",
          failureCategory: "captcha",
        };
      }
      console.log("[indeed] CAPTCHA solved, continuing...");
      await humanDelay(1000, 2000);
    }

    // ── Click "Apply Now" button if on the job listing page ──────────────
    await clickApplyNowIfPresent(page);

    // ── Switch into apply iframe if Indeed wraps form in one ─────────────
    const applyFrame = await getApplyFrame(page);
    const formContext = applyFrame || page;

    // Re-check login after clicking Apply Now (Indeed sometimes redirects)
    if (await isLoginRequired(formContext as Page)) {
      console.log("[indeed] Login required after Apply Now — returning unsupported");
      const shot = await screenshot(page);
      return {
        success: false,
        questionsAnswered,
        confirmationScreenshot: shot,
        failureReason: "Indeed requires login to apply. Please link your Indeed account or apply manually.",
        failureCategory: "login_required",
      };
    }

    // ── Multi-step wizard loop ───────────────────────────────────────────
    let stepCount = 0;
    let submitted = false;

    while (stepCount < MAX_STEPS) {
      stepCount++;
      console.log(`[indeed] Step ${stepCount}`);
      await humanDelay(1000, 2500);

      // Check what state we're in
      const pageState = await detectPageState(formContext as Page);
      console.log(`[indeed] Page state: ${pageState}`);

      if (pageState === "confirmation") {
        submitted = true;
        break;
      }

      if (pageState === "error") {
        // Validation error on current step — try to fix and retry once
        console.log("[indeed] Validation error detected — re-analyzing step...");
      }

      // ── Resume step: upload resume ───────────────────────────────────
      if (pageState === "resume") {
        await uploadResume(formContext as Page, resumeBase64, resumeFileName);
        await humanDelay(500, 1500);
      }

      // ── Get snapshot and fill whatever is on this step ────────────────
      const snapshot = await getPageSnapshot(formContext as Page);
      console.log(`[indeed] Step ${stepCount} snapshot (${snapshot.split("\n").length} lines)`);

      const fields: FilledField[] = await analyzeFormAndFill(
        snapshot,
        profile,
        jobTitle,
        company,
        jobDescription,
        coverLetterText
      );
      console.log(`[indeed] Claude returned ${fields.length} fields for step ${stepCount}`);

      // Fill fields
      for (const field of fields) {
        if (field.type === "file") continue;
        try {
          await humanDelay(200, 800);
          await fillIndeedField(formContext as Page, field);
          questionsAnswered.push({ question: field.label, answer: field.value });
        } catch (e) {
          console.warn(`[indeed] Could not fill "${field.label}": ${(e as Error).message}`);
        }
      }

      // Handle empty textareas (custom questions) that Claude's snapshot pass may have missed
      await handleCustomQuestions(
        formContext as Page,
        profile,
        jobTitle,
        company,
        jobDescription,
        questionsAnswered
      );

      await humanScroll(page, 200);
      await humanDelay(500, 1200);

      // ── Determine whether to Continue or Submit ───────────────────────
      const isReviewStep = await isReviewPage(formContext as Page);

      if (isReviewStep && !dryRun) {
        // Final submit
        console.log("[indeed] Review step detected — submitting application");
        await humanDelay(1000, 3000);
        const didSubmit = await clickSubmit(formContext as Page);
        if (!didSubmit) {
          return {
            success: false,
            questionsAnswered,
            failureReason: "Could not locate submit button on review page",
            failureCategory: "other",
          };
        }
        await page.waitForTimeout(3000);

        // Post-submit CAPTCHA check
        if (await hasCaptcha(page)) {
          console.log("[indeed] Post-submit CAPTCHA detected — solving...");
          const solved = await handleCaptcha(page);
          if (!solved) {
            return {
              success: false,
              questionsAnswered,
              failureReason: "Post-submit CAPTCHA — solver failed",
              failureCategory: "captcha",
            };
          }
          await humanDelay(1000, 2000);
          await clickSubmit(formContext as Page);
          await page.waitForTimeout(3000);
        }

        submitted = true;
        break;
      } else if (isReviewStep && dryRun) {
        console.log("[indeed] Review step reached (dry run) — not submitting");
        submitted = true;
        break;
      } else {
        // Click Continue to advance to next step
        const advanced = await clickContinue(formContext as Page);
        if (!advanced) {
          // Maybe we're already on a confirmation page or stuck
          console.warn("[indeed] Could not find Continue or Submit button");
          // Check if somehow we ended up on confirmation
          if ((await detectPageState(formContext as Page)) === "confirmation") {
            submitted = true;
          }
          break;
        }
        await page.waitForTimeout(2000);
      }
    }

    if (stepCount >= MAX_STEPS) {
      console.error("[indeed] Exceeded max steps — bailing out");
      return {
        success: false,
        questionsAnswered,
        failureReason: `Exceeded max wizard steps (${MAX_STEPS})`,
        failureCategory: "other",
      };
    }

    // ── Confirmation ─────────────────────────────────────────────────────
    const confirmShot = await screenshot(page);
    const pageText = await page.evaluate(() => document.body.innerText);
    const confirmed =
      /thank you|application (has been |was )?submitted|application received|we.?ll be in touch|successfully applied/i.test(
        pageText
      );

    if (!dryRun && !confirmed && submitted) {
      console.warn("[indeed] Confirmation text not found — may have failed");
    }

    return {
      success: submitted,
      questionsAnswered,
      confirmationScreenshot: confirmShot,
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[indeed] Error:", msg);
    return {
      success: false,
      questionsAnswered,
      failureReason: msg,
      failureCategory: msg.includes("timeout") ? "timeout" : "other",
    };
  }
}

// ─── Helper functions ──────────────────────────────────────────────────────

async function waitForCloudflare(page: Page): Promise<void> {
  const cfChallenge = await page.evaluate(
    () =>
      document.body.innerText.toLowerCase().includes("checking your browser") ||
      document.body.innerText.toLowerCase().includes("just a moment")
  );
  if (cfChallenge) {
    console.log("[indeed] Cloudflare challenge detected — waiting for auto-resolve...");
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const still = await page.evaluate(
        () =>
          document.body.innerText.toLowerCase().includes("checking your browser") ||
          document.body.innerText.toLowerCase().includes("just a moment")
      );
      if (!still) {
        console.log(`[indeed] Cloudflare resolved after ${i + 1}s`);
        break;
      }
    }
    await page.waitForTimeout(2000);
  }
}

async function dismissCookieDialogs(page: Page): Promise<void> {
  try {
    // Indeed uses various cookie/consent dialogs
    const acceptSelectors = [
      "#onetrust-accept-btn-handler",
      "[data-testid='cookie-accept']",
      "button:has-text('Accept All')",
      "button:has-text('Accept Cookies')",
      "button:has-text('Accept')",
      "[aria-label='cookieconsent'] button",
    ];
    for (const sel of acceptSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        console.log("[indeed] Dismissed cookie consent");
        await page.waitForTimeout(500);
        break;
      }
    }
    // Force-remove remaining overlays
    await page.evaluate(() => {
      document
        .querySelectorAll(
          "[role='dialog'], .cookieconsent, [aria-label='cookieconsent'], .cc-window, #onetrust-consent-sdk"
        )
        .forEach((el) => {
          const text = (el as HTMLElement).textContent?.toLowerCase() || "";
          if (text.includes("cookie") || text.includes("privacy") || text.includes("consent")) {
            (el as HTMLElement).remove();
          }
        });
    });
  } catch {}
}

async function isLoginRequired(page: Page): Promise<boolean> {
  try {
    const url = page.url().toLowerCase();
    if (url.includes("/login") || url.includes("/signin") || url.includes("auth")) {
      return true;
    }
    return await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasLoginForm =
        !!document.querySelector("#login-email-input") ||
        !!document.querySelector("[data-testid='login-form']") ||
        !!document.querySelector("input[name='__email']");
      const hasLoginText =
        text.includes("sign in to apply") ||
        text.includes("sign in to indeed") ||
        text.includes("log in to apply") ||
        text.includes("create an account");
      return hasLoginForm || hasLoginText;
    });
  } catch {
    return false;
  }
}

async function clickApplyNowIfPresent(page: Page): Promise<void> {
  // Indeed job pages have an "Apply now" or "Apply on company site" button
  const applySelectors = [
    "#indeedApplyButton",
    "button[id*='applyButton']",
    "[data-testid='indeedApplyButton']",
    "button:has-text('Apply now')",
    "a:has-text('Apply now')",
  ];
  for (const sel of applySelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("[indeed] Clicking Apply Now button");
      await btn.click();
      await page.waitForTimeout(3000);
      return;
    }
  }
  // May already be on the apply page — that's fine
  console.log("[indeed] No Apply Now button found — may already be on apply page");
}

async function getApplyFrame(page: Page): Promise<Page | null> {
  // Indeed sometimes wraps the apply flow in an iframe
  try {
    const frame = page.frameLocator("iframe[id*='apply'], iframe[src*='apply'], iframe[title*='apply']");
    // Test if the frame has content by looking for any input
    const testEl = frame.locator("input, button, textarea").first();
    if (await testEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log("[indeed] Apply flow is inside an iframe");
      // Unfortunately Playwright FrameLocator isn't a Page — we need the actual Frame
      // Use page.frames() instead
      const frames = page.frames();
      for (const f of frames) {
        const url = f.url().toLowerCase();
        if (url.includes("apply") || url.includes("indeedapply")) {
          console.log(`[indeed] Found apply frame: ${url}`);
          // Return the frame as a Page-like object (Frame has the same locator API)
          return f as unknown as Page;
        }
      }
    }
  } catch {}
  return null;
}

async function detectPageState(
  page: Page
): Promise<"resume" | "form" | "review" | "confirmation" | "error"> {
  return await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();

    // Confirmation
    if (
      text.includes("application submitted") ||
      text.includes("thank you for applying") ||
      text.includes("your application has been submitted") ||
      text.includes("successfully applied")
    ) {
      return "confirmation";
    }

    // Validation errors
    const hasErrors =
      !!document.querySelector(".ia-ErrorList, [data-testid='error'], .error-message, .ia-BasePage-errors") ||
      !!document.querySelector("[role='alert']");
    if (hasErrors) return "error";

    // Review page
    if (
      text.includes("review your application") ||
      text.includes("please review") ||
      text.includes("review and submit")
    ) {
      return "review";
    }

    // Resume step
    const hasFileInput = !!document.querySelector("input[type='file']");
    if (hasFileInput && (text.includes("resume") || text.includes("cv"))) {
      return "resume";
    }

    return "form";
  });
}

async function isReviewPage(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    // Check for review indicators
    if (
      text.includes("review your application") ||
      text.includes("please review") ||
      text.includes("review and submit")
    ) {
      return true;
    }
    // Check for submit button text (final step)
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
    return buttons.some((btn) => {
      const btnText = (btn.textContent || (btn as HTMLInputElement).value || "").toLowerCase();
      return (
        btnText.includes("submit your application") ||
        btnText.includes("submit application") ||
        btnText.includes("apply now")
      );
    });
  });
}

async function fillIndeedField(page: Page, field: FilledField): Promise<void> {
  const { selector, value, type } = field;
  if (!selector || !value) return;

  const locator = page.locator(selector).first();
  const visible = await locator.isVisible({ timeout: 3000 }).catch(() => false);

  if (!visible) {
    // Fallback: try by label text
    const byLabel = page.getByLabel(field.label, { exact: false }).first();
    if (!(await byLabel.isVisible({ timeout: 2000 }).catch(() => false))) return;

    if (type === "select") {
      await byLabel.selectOption({ label: value }).catch(() => byLabel.selectOption(value));
    } else if (type === "radio") {
      const radio = page.locator(`input[type="radio"]`).filter({ hasText: value }).first();
      if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
        await radio.click();
      }
    } else if (type === "checkbox") {
      if (value.toLowerCase() === "yes" || value === "true") {
        if (!(await byLabel.isChecked())) await byLabel.click();
      }
    } else {
      await byLabel.click();
      await byLabel.fill("");
      await byLabel.type(value, { delay: 30 });
    }
    return;
  }

  if (type === "select") {
    await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
  } else if (type === "radio") {
    // Indeed radio buttons: find by value text within the group
    const radioGroup = locator.locator("..").locator("input[type='radio']");
    const count = await radioGroup.count();
    for (let i = 0; i < count; i++) {
      const radio = radioGroup.nth(i);
      const label = await radio.locator("..").textContent().catch(() => "");
      if (label && label.toLowerCase().includes(value.toLowerCase())) {
        await radio.click();
        break;
      }
    }
  } else if (type === "checkbox") {
    if (value.toLowerCase() === "yes" || value === "true") {
      if (!(await locator.isChecked())) await locator.click();
    }
  } else if (type === "textarea") {
    await locator.click();
    await locator.fill(value);
  } else {
    // Text / email / tel — clear then type with human-like delay
    await locator.click({ timeout: 3000 });
    await locator.fill("");
    await locator.type(value, { delay: 30 });
  }
}

async function uploadResume(page: Page, resumeBase64: string, resumeFileName: string): Promise<void> {
  let tempPath: string | null = null;
  try {
    tempPath = writeTempResume(resumeBase64, resumeFileName);

    // Look for file inputs on the page
    const fileInputs = page.locator("input[type='file']");
    const count = await fileInputs.count();
    if (count === 0) {
      console.log("[indeed] No file input found for resume upload");
      return;
    }

    // Upload to the first file input
    const firstInput = fileInputs.first();
    await firstInput.setInputFiles(tempPath);
    await page.waitForTimeout(2000);
    console.log(`[indeed] Resume uploaded: ${resumeFileName}`);
  } catch (e) {
    console.warn("[indeed] Resume upload failed:", (e as Error).message);
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
        fs.rmdirSync(require("path").dirname(tempPath));
      } catch {}
    }
  }
}

async function handleCustomQuestions(
  page: Page,
  profile: ApplicationProfile,
  jobTitle: string,
  company: string,
  jobDescription: string,
  questionsAnswered: { question: string; answer: string }[]
): Promise<void> {
  // Find empty required fields that look like custom questions
  const empties = await page.evaluate(() => {
    const results: { label: string; selector: string; tag: string }[] = [];

    // Textareas
    document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((el, i) => {
      if (el.value && el.value.trim()) return;
      const lbl =
        el.closest("[class*='question'], [class*='field'], [data-testid]")?.querySelector(
          "label, h3, h4, p, span"
        )?.textContent?.trim() ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        "";
      if (!lbl || lbl.length < 5) return;
      const sel = el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : `textarea:nth-of-type(${i + 1})`;
      results.push({ label: lbl, selector: sel, tag: "textarea" });
    });

    // Empty text inputs that aren't standard fields
    document.querySelectorAll<HTMLInputElement>("input[type='text'], input:not([type])").forEach((el, i) => {
      if (el.value && el.value.trim()) return;
      const name = el.name || "";
      // Skip standard contact fields
      if (["name", "email", "phone", "first", "last", "city", "state", "zip", "location"].some((k) => name.toLowerCase().includes(k)))
        return;
      const lbl =
        el.closest("[class*='question'], [class*='field'], [data-testid]")?.querySelector(
          "label, h3, h4, p, span"
        )?.textContent?.trim() ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        "";
      if (!lbl || lbl.length < 8) return;
      const sel = el.id
        ? `#${el.id}`
        : name
        ? `[name="${name}"]`
        : `input:nth-of-type(${i + 1})`;
      results.push({ label: lbl, selector: sel, tag: "input" });
    });

    return results;
  });

  for (const q of empties) {
    // Skip if we already answered this question
    if (questionsAnswered.some((qa) => qa.question === q.label)) continue;

    const answer = await answerCustomQuestion(q.label, profile, jobTitle, company, jobDescription);
    if (!answer) continue;
    try {
      const el = page.locator(q.selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.fill(answer);
        questionsAnswered.push({ question: q.label, answer });
        console.log(`[indeed] Answered: "${q.label.slice(0, 50)}"`);
      }
    } catch {}
  }
}

async function clickContinue(page: Page): Promise<boolean> {
  // Indeed wizard uses "Continue" to advance between steps
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a[role='button']"));
    for (const btn of buttons) {
      const text = (btn.textContent || (btn as HTMLInputElement).value || "").trim().toLowerCase();
      if (
        text === "continue" ||
        text.includes("continue") ||
        text.includes("next") ||
        text.includes("save and continue")
      ) {
        (btn as HTMLElement).scrollIntoView({ block: "center" });
        (btn as HTMLElement).click();
        return text;
      }
    }
    return null;
  });

  if (clicked) {
    console.log(`[indeed] Advanced via: "${clicked}"`);
    return true;
  }

  // Fallback: Playwright locator
  const btn = page.locator("button:has-text('Continue'), button:has-text('Next')").first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click({ force: true, timeout: 5000 }).catch(() => {});
    console.log("[indeed] Advanced via force click");
    return true;
  }

  return false;
}

async function clickSubmit(page: Page): Promise<boolean> {
  // Scroll to bottom and clear overlays
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    document
      .querySelectorAll("[role='dialog'], .cookieconsent, [aria-label='cookieconsent'], .cc-window")
      .forEach((el) => {
        const text = (el as HTMLElement).textContent?.toLowerCase() || "";
        if (text.includes("cookie") || text.includes("privacy") || text.includes("consent")) {
          (el as HTMLElement).style.display = "none";
        }
      });
  });
  await page.waitForTimeout(500);

  // Primary: JS click on submit button
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
    // Priority order: most specific first
    const priorities = [
      "submit your application",
      "submit application",
      "apply now",
      "submit",
    ];
    for (const target of priorities) {
      for (const btn of buttons) {
        const text = (btn.textContent || (btn as HTMLInputElement).value || "").trim().toLowerCase();
        if (text.includes(target)) {
          (btn as HTMLElement).scrollIntoView({ block: "center" });
          (btn as HTMLElement).click();
          return text;
        }
      }
    }
    return null;
  });

  if (clicked) {
    console.log(`[indeed] Submitted via JS click: "${clicked}"`);
    return true;
  }

  // Fallback: Playwright force click
  const btn = page.locator("button").filter({ hasText: /submit/i }).last();
  if ((await btn.count()) > 0) {
    await btn.click({ force: true, timeout: 5000 }).catch(() => {});
    console.log("[indeed] Submitted via force click");
    return true;
  }

  console.error("[indeed] No submit button found");
  return false;
}
