/**
 * Workday ATS applier
 * Handles myworkdayjobs.com and wd*.myworkdaysite.com
 *
 * Workday form structure (multi-page flow):
 * Page 1: "Apply" button on job listing -> opens application
 * Page 2: Sign-in / Create Account / Apply as Guest (we prefer guest)
 * Page 3: Personal info (name, email, phone, address)
 * Page 4: Work experience
 * Page 5: Education
 * Page 6: Resume upload + additional documents
 * Page 7: Voluntary self-identification (EEO)
 * Page 8: Review & submit
 *
 * Key challenges:
 * - Multi-page flow with "Next" / "Continue" buttons
 * - Shadow DOM elements (Workday custom components)
 * - Account creation gate (try guest path first)
 * - Dynamic loading between steps
 */
import { Page } from "playwright";
import { ApplicationProfile, FilledField } from "../types";
import { analyzeFormAndFill, answerCustomQuestion } from "./claude";
import { getPageSnapshot, hasCaptcha, screenshot, writeTempResume, humanDelay, humanScroll, humanScan } from "./browser";
import { handleCaptcha } from "./captcha-solver";
import * as fs from "fs";

export interface WorkdayResult {
  success: boolean;
  questionsAnswered: { question: string; answer: string }[];
  confirmationScreenshot?: string;
  failureReason?: string;
  failureCategory?: "captcha" | "missing_field" | "custom_question" | "timeout" | "other";
}

/** Maximum number of pages we'll attempt before giving up */
const MAX_PAGES = 12;

export async function applyWorkday(
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
): Promise<WorkdayResult> {
  const questionsAnswered: { question: string; answer: string }[] = [];

  try {
    console.log(`[workday] Navigating to ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // ── Cloudflare challenge ────────────────────────────────────────────
    await waitForCloudflare(page);

    // Human-like initial behavior
    await humanDelay(2000, 4000);
    await humanScan(page);
    await humanScroll(page, 200);
    await humanDelay(500, 1500);

    // ── Dismiss cookie consent ──────────────────────────────────────────
    await dismissCookieDialog(page);

    // ── Initial CAPTCHA check ───────────────────────────────────────────
    if (await hasCaptcha(page)) {
      console.log("[workday] CAPTCHA detected — attempting to solve...");
      const solved = await handleCaptcha(page);
      if (!solved) {
        return { success: false, questionsAnswered, failureReason: "CAPTCHA detected — solver unavailable or failed", failureCategory: "captcha" };
      }
      console.log("[workday] CAPTCHA solved, continuing...");
      await humanDelay(1000, 2000);
    }

    // ── Click the "Apply" button on the job listing page ────────────────
    await clickApplyButton(page);
    await humanDelay(2000, 4000);

    // ── Handle sign-in / guest flow ─────────────────────────────────────
    await handleAuthGate(page);
    await humanDelay(2000, 3000);

    // ── Multi-page form fill loop ───────────────────────────────────────
    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      // Wait for page content to stabilize
      await page.waitForTimeout(1500);
      await dismissCookieDialog(page);

      const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
      const currentUrl = page.url();
      console.log(`[workday] Step ${pageNum + 1}, URL: ${currentUrl}`);

      // Check if we've reached the confirmation/thank-you page
      if (isConfirmationPage(pageText)) {
        console.log("[workday] Reached confirmation page");
        break;
      }

      // Check if this is the review/submit page
      if (isReviewPage(pageText)) {
        console.log("[workday] Reached review/submit page");
        if (!dryRun) {
          await humanDelay(1000, 2000);
          const submitted = await submitWorkday(page);
          if (!submitted) {
            return { success: false, questionsAnswered, failureReason: "Could not locate submit button on review page", failureCategory: "other" };
          }
          await page.waitForTimeout(4000);

          // Post-submit CAPTCHA check
          if (await hasCaptcha(page)) {
            console.log("[workday] Post-submit CAPTCHA detected — solving...");
            const solved = await handleCaptcha(page);
            if (!solved) {
              return { success: false, questionsAnswered, failureReason: "Post-submit CAPTCHA — solver failed", failureCategory: "captcha" };
            }
            await humanDelay(1000, 2000);
            await submitWorkday(page);
            await page.waitForTimeout(4000);
          }
        }
        break;
      }

      // ── Snapshot the current page and let AI analyze it ────────────
      const snapshot = await getPageSnapshot(page);
      console.log(`[workday] Page ${pageNum + 1} snapshot (${snapshot.split("\n").length} lines)`);

      const fields: FilledField[] = await analyzeFormAndFill(
        snapshot, profile, jobTitle, company, jobDescription, coverLetterText
      );
      console.log(`[workday] Claude returned ${fields.length} fields for page ${pageNum + 1}`);

      // ── Fill fields on this page ──────────────────────────────────
      for (const field of fields) {
        if (field.type === "file") continue;
        try {
          await humanDelay(200, 800);
          await fillWorkdayField(page, field);
          questionsAnswered.push({ question: field.label, answer: field.value });
        } catch (e) {
          console.warn(`[workday] Could not fill "${field.label}": ${(e as Error).message}`);
        }
      }

      // ── Upload resume if there's a file input on this page ────────
      const hasFileInput = await page.locator("input[type='file']").count() > 0;
      if (hasFileInput) {
        await uploadResumeWorkday(page, resumeBase64, resumeFileName);
      }

      // ── Handle custom text questions on this page ─────────────────
      await handleCustomQuestions(page, profile, jobTitle, company, jobDescription, questionsAnswered);

      // ── Fill Workday-specific known fields by data-automation-id ──
      await fillWorkdayKnownFields(page, profile);

      await humanScroll(page, 200);
      await humanDelay(500, 1000);

      // ── Advance to next page ──────────────────────────────────────
      const advanced = await clickNextOrContinue(page);
      if (!advanced) {
        // Could be the final submit page or a single-page variant
        console.log("[workday] No next button found — attempting submit");
        if (!dryRun) {
          const submitted = await submitWorkday(page);
          if (submitted) {
            await page.waitForTimeout(4000);
          }
        }
        break;
      }

      // Wait for next page to load
      await page.waitForTimeout(2500);
    }

    // ── Take confirmation screenshot ──────────────────────────────────
    const confirmShot = await screenshot(page);
    const finalText = await page.evaluate(() => document.body.innerText);
    const confirmed = isConfirmationPage(finalText.toLowerCase());

    if (!dryRun && !confirmed) {
      console.warn("[workday] Confirmation text not found — may have failed");
    }

    return { success: true, questionsAnswered, confirmationScreenshot: confirmShot };

  } catch (err) {
    const msg = (err as Error).message;
    console.error("[workday] Error:", msg);
    return {
      success: false,
      questionsAnswered,
      failureReason: msg,
      failureCategory: msg.includes("timeout") ? "timeout" : "other",
    };
  }
}

// ─── Helper functions ────────────────────────────────────────────────────────

async function waitForCloudflare(page: Page): Promise<void> {
  const cfChallenge = await page.evaluate(() =>
    document.body.innerText.toLowerCase().includes("checking your browser") ||
    document.body.innerText.toLowerCase().includes("just a moment")
  );
  if (cfChallenge) {
    console.log("[workday] Cloudflare challenge detected — waiting for auto-resolve...");
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const still = await page.evaluate(() =>
        document.body.innerText.toLowerCase().includes("checking your browser") ||
        document.body.innerText.toLowerCase().includes("just a moment")
      );
      if (!still) { console.log(`[workday] Cloudflare resolved after ${i + 1}s`); break; }
    }
    await page.waitForTimeout(2000);
  }
}

async function dismissCookieDialog(page: Page): Promise<void> {
  try {
    // Click accept/dismiss buttons
    const acceptBtn = page.locator([
      "button:has-text('Accept')",
      "button:has-text('Accept All')",
      "button:has-text('Dismiss')",
      "button:has-text('I Accept')",
      "button:has-text('OK')",
      "[aria-label='cookieconsent'] button",
    ].join(", ")).first();
    if (await acceptBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await acceptBtn.click();
      console.log("[workday] Dismissed cookie consent");
      await page.waitForTimeout(500);
    }

    // Force-remove overlays
    await page.evaluate(() => {
      document.querySelectorAll(
        "[aria-label='cookieconsent'], .cc-window, .cookieconsent, #onetrust-consent-sdk, .onetrust-pc-dark-filter, #onetrust-banner-sdk"
      ).forEach(el => {
        (el as HTMLElement).remove();
      });
      document.querySelectorAll("dialog[open]").forEach(el => {
        const text = el.textContent?.toLowerCase() || "";
        if (text.includes("cookie") || text.includes("privacy") || text.includes("consent")) {
          (el as HTMLDialogElement).close();
          el.remove();
        }
      });
    });
  } catch {}
}

/**
 * Click the initial "Apply" button on the Workday job listing page.
 * Workday uses data-automation-id attributes extensively.
 */
async function clickApplyButton(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    // Workday-specific: data-automation-id="jobApplyButton"
    const wdApply = document.querySelector<HTMLElement>('[data-automation-id="jobApplyButton"]');
    if (wdApply) { wdApply.click(); return "jobApplyButton"; }

    // Broader search for apply buttons
    const links = Array.from(document.querySelectorAll("a, button"));
    for (const el of links) {
      const text = (el.textContent?.trim().toLowerCase() || "");
      const ariaLabel = ((el as HTMLElement).getAttribute("aria-label") || "").toLowerCase();
      if (text === "apply" || text === "apply now" || ariaLabel.includes("apply")) {
        (el as HTMLElement).click();
        return text || ariaLabel;
      }
    }
    return null;
  });

  if (clicked) {
    console.log(`[workday] Clicked apply button: "${clicked}"`);
    await page.waitForTimeout(3000);
  } else {
    console.log("[workday] No apply button found — may already be on application form");
  }
}

/**
 * Handle the auth gate: try "Apply Manually" / "Apply as Guest" / skip sign-in.
 * Workday sites often require an account but some offer a guest path.
 */
async function handleAuthGate(page: Page): Promise<void> {
  const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());

  // Check if we're on a sign-in / create account page
  const isAuthPage = pageText.includes("sign in") || pageText.includes("create account") ||
    pageText.includes("existing applicant") || pageText.includes("new applicant");

  if (!isAuthPage) {
    console.log("[workday] No auth gate detected — proceeding");
    return;
  }

  console.log("[workday] Auth gate detected — looking for guest/manual path");

  // Try clicking guest-apply or manual-apply options
  const guestClicked = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("a, button, [role='button'], [data-automation-id]"));
    const guestTerms = [
      "apply manually", "apply as guest", "continue without account",
      "skip", "apply without signing in", "use my information",
      "autofill with resume", "manual apply"
    ];
    for (const el of elements) {
      const text = (el.textContent?.trim().toLowerCase() || "");
      const automationId = ((el as HTMLElement).getAttribute("data-automation-id") || "").toLowerCase();
      for (const term of guestTerms) {
        if (text.includes(term) || automationId.includes("manualpply") || automationId.includes("useMyInformation")) {
          (el as HTMLElement).click();
          return text || automationId;
        }
      }
    }

    // Fallback: Workday often has "Apply Manually" as data-automation-id="applyManually"
    const manualBtn = document.querySelector<HTMLElement>('[data-automation-id="applyManually"]');
    if (manualBtn) { manualBtn.click(); return "applyManually"; }

    // Another common Workday pattern: "Use My Last Application"
    const useLastBtn = document.querySelector<HTMLElement>('[data-automation-id="useMyLastApplication"]');
    if (useLastBtn) { useLastBtn.click(); return "useMyLastApplication"; }

    return null;
  });

  if (guestClicked) {
    console.log(`[workday] Bypassed auth gate via: "${guestClicked}"`);
    await page.waitForTimeout(3000);
  } else {
    console.log("[workday] Could not bypass auth gate — continuing anyway (may be blocked)");
  }
}

/**
 * Fill a single form field using Workday-aware selectors.
 * Workday uses custom web components and data-automation-id attributes.
 */
async function fillWorkdayField(page: Page, field: FilledField): Promise<void> {
  const { selector, value, type } = field;
  if (!selector || !value) return;

  const locator = page.locator(selector).first();
  const visible = await locator.isVisible({ timeout: 3000 }).catch(() => false);

  if (!visible) {
    // Fallback: try by label text
    const byLabel = page.getByLabel(field.label, { exact: false }).first();
    if (!await byLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Fallback: try Workday data-automation-id pattern
      const byPlaceholder = page.getByPlaceholder(field.label, { exact: false }).first();
      if (await byPlaceholder.isVisible({ timeout: 1500 }).catch(() => false)) {
        await byPlaceholder.click();
        await byPlaceholder.fill("");
        await byPlaceholder.type(value, { delay: 30 });
        return;
      }
      return;
    }
    await fillByType(byLabel, value, type);
    return;
  }

  await fillByType(locator, value, type);
}

async function fillByType(locator: ReturnType<Page["locator"]>, value: string, type: string): Promise<void> {
  if (type === "select") {
    // Workday dropdowns are often custom — try native select first, then click-and-pick
    try {
      await locator.selectOption({ label: value });
    } catch {
      // Custom dropdown: click to open, then select option from the list
      await locator.click();
      // Wait for dropdown to open
      const page = locator.page();
      await page.waitForTimeout(500);

      // Try to find the option in a dropdown list
      const option = page.locator(`[role="option"], [role="listbox"] li, [data-automation-id*="option"]`)
        .filter({ hasText: value }).first();
      if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
        await option.click();
      } else {
        // Try partial text match
        const partialOption = page.locator(`[role="option"], li`)
          .filter({ hasText: new RegExp(value.split(" ")[0], "i") }).first();
        if (await partialOption.isVisible({ timeout: 1500 }).catch(() => false)) {
          await partialOption.click();
        }
      }
    }
  } else if (type === "radio") {
    const page = locator.page();
    const radio = page.locator(`input[type="radio"]`).filter({ hasText: value }).first();
    if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
      await radio.click();
    } else {
      // Workday radio buttons may be custom elements
      const customRadio = page.locator(`[role="radio"]`).filter({ hasText: value }).first();
      if (await customRadio.isVisible({ timeout: 1500 }).catch(() => false)) {
        await customRadio.click();
      }
    }
  } else if (type === "checkbox") {
    if (value.toLowerCase() === "yes" || value === "true") {
      const isChecked = await locator.isChecked().catch(() => false);
      if (!isChecked) await locator.click();
    }
  } else {
    // Text, email, tel, textarea
    await locator.click({ timeout: 3000 });
    await locator.fill("");
    await locator.type(value, { delay: 30 });
  }
}

/**
 * Fill Workday-specific known fields using data-automation-id selectors.
 * These are common across most Workday implementations.
 */
async function fillWorkdayKnownFields(page: Page, profile: ApplicationProfile): Promise<void> {
  const automationFields: Record<string, string> = {
    "legalNameSection_firstName": profile.firstName,
    "legalNameSection_lastName": profile.lastName,
    "email": profile.email,
    "phone-number": profile.phone,
    "addressSection_addressLine1": `${profile.city}, ${profile.state} ${profile.zipCode}`,
    "addressSection_city": profile.city,
    "addressSection_region": profile.state,
    "addressSection_postalCode": profile.zipCode,
    "linkedinQuestion": profile.linkedinUrl || "",
    "websiteQuestion": profile.portfolioUrl || "",
  };

  for (const [automationId, value] of Object.entries(automationFields)) {
    if (!value) continue;
    try {
      // Workday inputs: try data-automation-id on the input itself or its parent
      const loc = page.locator(`[data-automation-id="${automationId}"] input, input[data-automation-id="${automationId}"]`).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        const current = await loc.inputValue().catch(() => "");
        if (!current) {
          await loc.click();
          await loc.fill(value);
          console.log(`[workday] Filled known field: ${automationId}`);
        }
      }
    } catch {}
  }

  // Also try filling by placeholder text (common in Workday)
  const placeholderFields: Record<string, string> = {
    "First Name": profile.firstName,
    "Last Name": profile.lastName,
    "Email": profile.email,
    "Phone": profile.phone,
    "City": profile.city,
    "Postal Code": profile.zipCode,
    "Zip": profile.zipCode,
  };

  for (const [placeholder, value] of Object.entries(placeholderFields)) {
    if (!value) continue;
    try {
      const loc = page.getByPlaceholder(placeholder, { exact: false }).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        const current = await loc.inputValue().catch(() => "");
        if (!current) {
          await loc.click();
          await loc.fill(value);
        }
      }
    } catch {}
  }
}

async function uploadResumeWorkday(page: Page, resumeBase64: string, resumeFileName: string): Promise<void> {
  let tempPath: string | null = null;
  try {
    tempPath = writeTempResume(resumeBase64, resumeFileName);

    // Workday file inputs: may be hidden behind a "Select Files" button
    // First, try to expose the file input
    await page.evaluate(() => {
      document.querySelectorAll<HTMLInputElement>("input[type='file']").forEach(el => {
        el.style.display = "block";
        el.style.opacity = "1";
        el.style.position = "relative";
      });
    });

    const fileInputs = page.locator("input[type='file']");
    const count = await fileInputs.count();
    if (count === 0) {
      // Workday may use a button that triggers a hidden input — try clicking upload area
      const uploadBtn = page.locator('[data-automation-id="file-upload-input-ref"], [data-automation-id="resumeUpload"], button:has-text("Select Files"), button:has-text("Upload")').first();
      if (await uploadBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Set up file chooser listener before clicking
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null),
          uploadBtn.click(),
        ]);
        if (fileChooser) {
          await fileChooser.setFiles(tempPath);
          console.log(`[workday] Resume uploaded via file chooser: ${resumeFileName}`);
        }
      } else {
        console.log("[workday] No file input or upload button found on this page");
      }
      return;
    }

    // Upload to first file input
    await fileInputs.first().setInputFiles(tempPath);
    await page.waitForTimeout(1500);
    console.log(`[workday] Resume uploaded: ${resumeFileName}`);

  } catch (e) {
    console.warn("[workday] Resume upload failed:", (e as Error).message);
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); fs.rmdirSync(require("path").dirname(tempPath)); } catch {}
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
  // Find empty text inputs and textareas that look like custom questions
  const empties = await page.evaluate(() => {
    const results: { label: string; selector: string; tag: string }[] = [];

    // Textareas
    document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((el, i) => {
      if (el.value && el.value.trim()) return;
      const container = el.closest("[data-automation-id], .css-1wc3gvm, div[class*='formField']");
      const lbl = container?.querySelector("label")?.textContent?.trim()
        || el.getAttribute("aria-label")
        || el.getAttribute("placeholder")
        || "";
      if (!lbl || lbl.length < 5) return;
      const sel = el.id ? `#${el.id}` : el.getAttribute("data-automation-id")
        ? `[data-automation-id="${el.getAttribute("data-automation-id")}"]`
        : `textarea:nth-of-type(${i + 1})`;
      results.push({ label: lbl, selector: sel, tag: "textarea" });
    });

    // Text inputs that might be custom questions (skip known fields)
    const knownNames = ["firstName", "lastName", "email", "phone", "city", "state", "zip", "postal", "address"];
    document.querySelectorAll<HTMLInputElement>("input[type='text']").forEach((el, i) => {
      if (el.value && el.value.trim()) return;
      const name = (el.name || el.id || "").toLowerCase();
      if (knownNames.some(k => name.includes(k))) return;
      const container = el.closest("[data-automation-id], div[class*='formField']");
      const lbl = container?.querySelector("label")?.textContent?.trim()
        || el.getAttribute("aria-label")
        || el.getAttribute("placeholder")
        || "";
      if (!lbl || lbl.length < 8) return;
      const sel = el.id ? `#${el.id}` : `input[type="text"]:nth-of-type(${i + 1})`;
      results.push({ label: lbl, selector: sel, tag: "input" });
    });

    return results;
  });

  for (const q of empties) {
    const answer = await answerCustomQuestion(q.label, profile, jobTitle, company, jobDescription);
    if (!answer) continue;
    try {
      const el = page.locator(q.selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.fill(answer);
        questionsAnswered.push({ question: q.label, answer });
        console.log(`[workday] Answered: "${q.label.slice(0, 50)}"`);
      }
    } catch {}
  }
}

/**
 * Click "Next", "Continue", or "Save and Continue" to advance to the next page.
 */
async function clickNextOrContinue(page: Page): Promise<boolean> {
  // Scroll to bottom first
  await page.keyboard.press("End");
  await page.waitForTimeout(500);

  const clicked = await page.evaluate(() => {
    // Remove any overlays that might block clicking
    document.querySelectorAll("[role='dialog'].cookie, .cookieconsent, .cc-window").forEach(el => {
      (el as HTMLElement).style.display = "none";
    });

    // Workday-specific next/continue buttons
    const wdNext = document.querySelector<HTMLElement>('[data-automation-id="bottom-navigation-next-button"]');
    if (wdNext) { wdNext.click(); return "wd-next"; }

    const wdContinue = document.querySelector<HTMLElement>('[data-automation-id="continueButton"]');
    if (wdContinue) { wdContinue.click(); return "wd-continue"; }

    // Generic next/continue buttons
    const buttons = Array.from(document.querySelectorAll("button, a[role='button'], [role='button']"));
    const nextTerms = ["next", "continue", "save and continue", "save & continue", "proceed"];
    for (const btn of buttons) {
      const text = (btn.textContent?.trim().toLowerCase() || "");
      const ariaLabel = ((btn as HTMLElement).getAttribute("aria-label") || "").toLowerCase();
      for (const term of nextTerms) {
        if (text === term || ariaLabel === term || text.includes(term)) {
          // Don't click submit buttons
          if (text.includes("submit")) continue;
          (btn as HTMLElement).scrollIntoView({ block: "center" });
          (btn as HTMLElement).click();
          return text;
        }
      }
    }

    return null;
  });

  if (clicked) {
    console.log(`[workday] Advanced to next page via: "${clicked}"`);
    return true;
  }

  // Fallback: Playwright locator with force click
  const nextBtn = page.locator("button:has-text('Next'), button:has-text('Continue'), button:has-text('Save and Continue')").first();
  if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nextBtn.click({ force: true, timeout: 5000 }).catch(() => {});
    console.log("[workday] Advanced via force click on Next/Continue");
    return true;
  }

  return false;
}

/**
 * Submit the final application on the review/submit page.
 */
async function submitWorkday(page: Page): Promise<boolean> {
  await page.keyboard.press("End");
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  // Remove overlays
  await page.evaluate(() => {
    document.querySelectorAll("[role='dialog'], .cookieconsent, [aria-label='cookieconsent'], .cc-window").forEach(el => {
      (el as HTMLElement).style.display = "none";
    });
  });
  await page.waitForTimeout(300);

  const clicked = await page.evaluate(() => {
    // Workday submit button
    const wdSubmit = document.querySelector<HTMLElement>('[data-automation-id="bottom-navigation-next-button"]');
    if (wdSubmit) {
      const text = wdSubmit.textContent?.trim().toLowerCase() || "";
      if (text.includes("submit")) { wdSubmit.click(); return "wd-submit"; }
    }

    const wdSubmit2 = document.querySelector<HTMLElement>('[data-automation-id="submitButton"]');
    if (wdSubmit2) { wdSubmit2.click(); return "wd-submitButton"; }

    // Generic submit buttons
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toLowerCase() || "";
      if (text.includes("submit application") || text.includes("submit")) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
        return text;
      }
    }

    const submitInput = document.querySelector<HTMLInputElement>("input[type='submit']");
    if (submitInput) { submitInput.click(); return submitInput.value || "input-submit"; }

    return null;
  });

  if (clicked) {
    console.log(`[workday] Submitted via JS click: "${clicked}"`);
    return true;
  }

  // Fallback: Playwright force click
  const btn = page.locator("button:has-text('Submit'), button[type='submit'], input[type='submit']").first();
  if (await btn.count() > 0) {
    await btn.click({ force: true, timeout: 5000 }).catch(() => {});
    console.log("[workday] Submitted via force click");
    return true;
  }

  console.error("[workday] No submit button found");
  return false;
}

function isConfirmationPage(text: string): boolean {
  return /thank you|application (has been |was )?received|application submitted|successfully submitted|we.?ll be in touch|confirmation|your application has been/i.test(text);
}

function isReviewPage(text: string): boolean {
  return /review (your |and )?submit|review application|review & submit|ready to submit/i.test(text);
}
