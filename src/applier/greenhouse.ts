/**
 * Greenhouse ATS applier
 * Handles boards.greenhouse.io and job-boards.greenhouse.io
 *
 * Form structure:
 * 1. Personal info (name, email, phone, location, resume upload)
 * 2. Optional: LinkedIn, website
 * 3. Custom demographic / EEO questions
 * 4. Submit button
 */
import { Page } from "playwright";
import { ApplicationProfile, FilledField } from "../types";
import { analyzeFormAndFill, answerCustomQuestion } from "./claude";
import { getPageSnapshot, hasCaptcha, screenshot, writeTempResume, humanDelay, humanScroll, humanScan, humanType } from "./browser";
import * as fs from "fs";

export interface GreenhouseResult {
  success: boolean;
  questionsAnswered: { question: string; answer: string }[];
  confirmationScreenshot?: string;
  failureReason?: string;
  failureCategory?: "captcha" | "missing_field" | "custom_question" | "timeout" | "other";
}

export async function applyGreenhouse(
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
): Promise<GreenhouseResult> {
  const questionsAnswered: { question: string; answer: string }[] = [];

  try {
    console.log(`[greenhouse] Navigating to ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Human-like: wait for page to render, scan around, scroll
    await humanDelay(2000, 4000);
    await humanScan(page);
    await humanScroll(page, 200);
    await humanDelay(500, 1500);

    if (await hasCaptcha(page)) {
      return { success: false, questionsAnswered, failureReason: "CAPTCHA detected on page", failureCategory: "captcha" };
    }

    // ── Step 1: Get AI analysis of form ──────────────────────────────────
    const snapshot = await getPageSnapshot(page);
    console.log(`[greenhouse] Snapshot (${snapshot.split("\n").length} fields)`);

    const fields: FilledField[] = await analyzeFormAndFill(
      snapshot, profile, jobTitle, company, jobDescription, coverLetterText
    );
    console.log(`[greenhouse] Claude returned ${fields.length} fields to fill`);

    // ── Step 2: Fill standard fields (with human-like pacing) ─────────────
    for (const field of fields) {
      try {
        if (field.type === "file") continue; // handle separately
        await humanDelay(300, 1200); // pause between fields like a real person
        await fillField(page, field);
        questionsAnswered.push({ question: field.label, answer: field.value });
      } catch (e) {
        console.warn(`[greenhouse] Could not fill "${field.label}": ${(e as Error).message}`);
      }
    }
    // Scroll down after filling fields
    await humanScroll(page, 300);
    await humanDelay(500, 1500);

    // ── Step 3: Resume upload ─────────────────────────────────────────────
    await uploadResume(page, resumeBase64, resumeFileName);

    // ── Step 4: Handle custom questions (if any remain unfilled) ─────────
    await handleCustomQuestions(page, profile, jobTitle, company, jobDescription, questionsAnswered);

    // ── Step 5: Submit (with human-like pause before clicking) ─────────
    if (!dryRun) {
      await humanDelay(1000, 3000); // pause like you're reviewing
      await humanScroll(page, -100); // scroll up slightly to see submit
      await humanDelay(500, 1000);
      const submitted = await submitForm(page);
      if (!submitted) {
        return { success: false, questionsAnswered, failureReason: "Could not locate submit button", failureCategory: "other" };
      }
      await page.waitForTimeout(3000);
    }

    const confirmShot = await screenshot(page);
    const pageText = await page.evaluate(() => document.body.innerText);
    const confirmed = /thank you|application received|submitted|we.?ll be in touch|confirmation/i.test(pageText);

    if (!dryRun && !confirmed) {
      console.warn("[greenhouse] Confirmation text not found — may have failed");
    }

    return { success: true, questionsAnswered, confirmationScreenshot: confirmShot };

  } catch (err) {
    const msg = (err as Error).message;
    console.error("[greenhouse] Error:", msg);
    return {
      success: false, questionsAnswered,
      failureReason: msg,
      failureCategory: msg.includes("timeout") ? "timeout" : "other",
    };
  }
}

async function fillField(page: Page, field: FilledField): Promise<void> {
  const { selector, value, type } = field;
  if (!selector || !value) return;

  // Try multiple selector strategies
  const locator = page.locator(selector).first();
  if (!await locator.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Fallback: try by label text
    const byLabel = page.getByLabel(field.label, { exact: false }).first();
    if (!await byLabel.isVisible({ timeout: 2000 }).catch(() => false)) return;

    if (type === "select") {
      await byLabel.selectOption({ label: value }).catch(() => byLabel.selectOption(value));
    } else {
      await byLabel.fill(value);
    }
    return;
  }

  if (type === "select") {
    await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
  } else if (type === "radio") {
    // Find radio by value or label text
    const radio = page.locator(`input[type="radio"]`).filter({ hasText: value }).first();
    if (await radio.isVisible({ timeout: 2000 }).catch(() => false)) {
      await radio.click();
    }
  } else if (type === "checkbox") {
    if (value.toLowerCase() === "yes" || value === "true") {
      const cb = locator;
      if (!await cb.isChecked()) await cb.click();
    }
  } else {
    await locator.click({ timeout: 3000 });
    await locator.fill("");
    await locator.type(value, { delay: 30 });
  }
}

async function uploadResume(page: Page, resumeBase64: string, resumeFileName: string): Promise<void> {
  let tempPath: string | null = null;
  try {
    tempPath = writeTempResume(resumeBase64, resumeFileName);

    // Greenhouse resume upload: look for file input near "Resume" label
    const fileInputs = page.locator("input[type='file']");
    const count = await fileInputs.count();
    if (count === 0) { console.log("[greenhouse] No file input found"); return; }

    // Upload to first file input (usually resume)
    const firstInput = fileInputs.first();
    await firstInput.setInputFiles(tempPath);
    await page.waitForTimeout(1000);
    console.log(`[greenhouse] Resume uploaded: ${resumeFileName}`);
  } catch (e) {
    console.warn("[greenhouse] Resume upload failed:", (e as Error).message);
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
  // Find any empty required text areas that look like essay questions
  const empties = await page.evaluate(() => {
    const results: { label: string; selector: string }[] = [];
    document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((el, i) => {
      if (!el.value || el.value.trim() === "") {
        const lbl = el.closest("div")?.querySelector("label")?.textContent?.trim() || `textarea_${i}`;
        const sel = el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : `textarea:nth-of-type(${i + 1})`;
        results.push({ label: lbl, selector: sel });
      }
    });
    return results;
  });

  for (const q of empties) {
    if (q.label.length < 5) continue; // skip unlabeled
    const answer = await answerCustomQuestion(q.label, profile, jobTitle, company, jobDescription);
    if (answer) {
      try {
        const el = page.locator(q.selector).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          await el.fill(answer);
          questionsAnswered.push({ question: q.label, answer });
          console.log(`[greenhouse] Answered: "${q.label.slice(0, 50)}"`);
        }
      } catch {}
    }
  }
}

async function submitForm(page: Page): Promise<boolean> {
  // Try common submit selectors
  const selectors = [
    "input[type='submit']",
    "button[type='submit']",
    "button:has-text('Submit Application')",
    "button:has-text('Submit')",
    "button:has-text('Apply')",
    "[data-qa='btn-submit']",
    "#submit_app",
  ];

  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click();
      console.log(`[greenhouse] Clicked submit: ${sel}`);
      return true;
    }
  }
  return false;
}
