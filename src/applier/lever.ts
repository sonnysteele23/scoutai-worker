/**
 * Lever ATS applier — jobs.lever.co
 *
 * Lever form structure:
 * 1. Name, email, phone, company, location (top section)
 * 2. Resume upload (drag-drop or file input)
 * 3. LinkedIn, Twitter, website (optional links)
 * 4. Cover letter textarea (optional)
 * 5. Custom questions (varies by job)
 * 6. EEO section (optional, at bottom)
 * 7. Submit button
 */
import { Page } from "playwright";
import { ApplicationProfile, FilledField } from "../types";
import { analyzeFormAndFill, answerCustomQuestion } from "./claude";
import { getPageSnapshot, hasCaptcha, screenshot, writeTempResume, humanDelay, humanScroll, humanScan } from "./browser";
import { handleCaptcha } from "./captcha-solver";
import * as fs from "fs";

export interface LeverResult {
  success: boolean;
  questionsAnswered: { question: string; answer: string }[];
  confirmationScreenshot?: string;
  failureReason?: string;
  failureCategory?: "captcha" | "missing_field" | "custom_question" | "timeout" | "other";
}

export async function applyLever(
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
): Promise<LeverResult> {
  const questionsAnswered: { question: string; answer: string }[] = [];

  try {
    console.log(`[lever] Navigating to ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Wait for Cloudflare challenge to auto-resolve (if present)
    const cfChallenge = await page.evaluate(() =>
      document.body.innerText.toLowerCase().includes("checking your browser") ||
      document.body.innerText.toLowerCase().includes("just a moment")
    );
    if (cfChallenge) {
      console.log("[lever] Cloudflare challenge detected — waiting for auto-resolve...");
      // Wait up to 15 seconds for the challenge to pass
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1000);
        const still = await page.evaluate(() =>
          document.body.innerText.toLowerCase().includes("checking your browser") ||
          document.body.innerText.toLowerCase().includes("just a moment")
        );
        if (!still) { console.log(`[lever] Cloudflare resolved after ${i + 1}s`); break; }
      }
      await page.waitForTimeout(2000);
    }

    // Dismiss cookie consent dialog (blocks ALL interaction on Lever pages)
    try {
      const acceptBtn = page.locator("dialog button:has-text('Accept'), dialog button:has-text('Dismiss'), [aria-label='cookieconsent'] button:has-text('Accept')").first();
      if (await acceptBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await acceptBtn.click();
        console.log("[lever] Dismissed cookie consent");
        await page.waitForTimeout(500);
      }
      // Force-remove cookie dialog overlays ONLY (don't touch CAPTCHA elements)
      await page.evaluate(() => {
        document.querySelectorAll("[aria-label='cookieconsent'], .cc-window, .cookieconsent").forEach(el => {
          if (el.tagName === "DIALOG") (el as HTMLDialogElement).close();
          (el as HTMLElement).remove();
        });
        // Close native <dialog> elements that look like cookie consent (not CAPTCHA)
        document.querySelectorAll("dialog[open]").forEach(el => {
          const text = el.textContent?.toLowerCase() || "";
          if (text.includes("cookie") || text.includes("privacy notice") || text.includes("consent")) {
            (el as HTMLDialogElement).close();
            el.remove();
          }
        });
      });
    } catch {}
    await page.waitForTimeout(300);

    // Diagnostic: log what the page looks like from the worker
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const pageUrl = page.url();
    console.log(`[lever] Page loaded: "${pageTitle}" @ ${pageUrl}`);
    console.log(`[lever] Page text preview: ${pageText.substring(0, 200)}`);

    // Check if this is a full-page CAPTCHA block (can't see the form at all)
    const isFullPageBlock = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasForm = !!document.querySelector("input[type='text'], input[type='email'], textarea");
      return !hasForm && (text.includes("verify") || text.includes("checking") || text.includes("captcha"));
    });

    if (isFullPageBlock) {
      console.log("[lever] Full-page CAPTCHA block — must solve before form is visible");
      const solved = await handleCaptcha(page);
      if (!solved) {
        return { success: false, questionsAnswered, failureReason: "Full-page CAPTCHA block — solver failed", failureCategory: "captcha" };
      }
      await humanDelay(2000, 3000);
    } else if (await hasCaptcha(page)) {
      // Passive CAPTCHA (loaded but not blocking) — skip for now, handle after submit
      console.log("[lever] Passive CAPTCHA detected — will handle after form fill if needed");
    }

    // ── Get form snapshot + AI analysis ──────────────────────────────────
    const snapshot = await getPageSnapshot(page);
    const fields: FilledField[] = await analyzeFormAndFill(
      snapshot, profile, jobTitle, company, jobDescription, coverLetterText
    );
    console.log(`[lever] ${fields.length} fields to fill`);

    // ── Fill standard fields ──────────────────────────────────────────────
    for (const field of fields) {
      if (field.type === "file") continue;
      try {
        await fillLeverField(page, field);
        questionsAnswered.push({ question: field.label, answer: field.value });
      } catch (e) {
        console.warn(`[lever] Skip "${field.label}": ${(e as Error).message}`);
      }
    }

    // ── Lever-specific: fill known fields by name attribute ──────────────
    await fillKnownFields(page, profile);

    // ── Resume upload ─────────────────────────────────────────────────────
    await uploadResumeLever(page, resumeBase64, resumeFileName);

    // ── Cover letter ──────────────────────────────────────────────────────
    if (coverLetterText) {
      await fillCoverLetter(page, coverLetterText);
      questionsAnswered.push({ question: "Cover Letter", answer: coverLetterText.slice(0, 100) + "..." });
    }

    // ── Custom questions ──────────────────────────────────────────────────
    await handleCustomQuestions(page, profile, jobTitle, company, jobDescription, questionsAnswered);

    // ── Submit ────────────────────────────────────────────────────────────
    if (!dryRun) {
      const submitted = await submitLever(page);
      if (!submitted) return { success: false, questionsAnswered, failureReason: "No submit button found", failureCategory: "other" };
      await page.waitForTimeout(3000);

      // Check if CAPTCHA appeared AFTER submit (common with passive hCaptcha)
      if (await hasCaptcha(page)) {
        console.log("[lever] Post-submit CAPTCHA detected — attempting solve...");

        // Try clicking the hCaptcha checkbox to trigger the challenge
        try {
          const hcCheckbox = page.frameLocator("iframe[src*='hcaptcha']").locator("#checkbox");
          if (await hcCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
            await hcCheckbox.click();
            console.log("[lever] Clicked hCaptcha checkbox");
            await page.waitForTimeout(2000);
          }
        } catch {}

        const solved = await handleCaptcha(page);
        if (solved) {
          // Wait for hCaptcha callback to process, then re-submit
          await page.waitForTimeout(3000);

          // Check if CAPTCHA auto-submitted the form (some implementations do this)
          const autoSubmitted = await page.evaluate(() => /thank you|application received|submitted|confirmation/i.test(document.body.innerText));
          if (autoSubmitted) {
            console.log("[lever] CAPTCHA callback auto-submitted the form!");
            const shot = await screenshot(page);
            return { success: true, questionsAnswered, confirmationScreenshot: shot };
          }

          // Otherwise manually re-submit
          await submitLever(page);
          await page.waitForTimeout(3000);
        } else {
          // Even if solver fails, check if submission went through anyway
          const postText = await page.evaluate(() => document.body.innerText);
          if (/thank you|application received|submitted|confirmation/i.test(postText)) {
            console.log("[lever] Application submitted despite CAPTCHA solver failure!");
            const shot = await screenshot(page);
            return { success: true, questionsAnswered, confirmationScreenshot: shot };
          }
          return { success: false, questionsAnswered, failureReason: "CAPTCHA appeared after submit — form is pre-filled, click 'Continue manually' to finish", failureCategory: "captcha" };
        }
      }

      // Also check if it actually submitted without CAPTCHA
      const postSubmitText = await page.evaluate(() => document.body.innerText);
      if (/thank you|application received|submitted|confirmation|we.?ll be in touch/i.test(postSubmitText)) {
        console.log("[lever] Application confirmed after submit!");
      }
    }

    const shot = await screenshot(page);
    const text = await page.evaluate(() => document.body.innerText);
    const confirmed = /thank you|application received|submitted|confirmation|on file/i.test(text);
    if (!dryRun && !confirmed) console.warn("[lever] Confirmation text not found");

    return { success: true, questionsAnswered, confirmationScreenshot: shot };

  } catch (err) {
    const msg = (err as Error).message;
    return { success: false, questionsAnswered, failureReason: msg, failureCategory: msg.includes("timeout") ? "timeout" : "other" };
  }
}

async function fillLeverField(page: Page, field: FilledField): Promise<void> {
  const { selector, value, type } = field;
  if (!selector || !value) return;

  const loc = page.locator(selector).first();
  const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);
  if (!visible) return;

  if (type === "select") {
    await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
  } else if (type === "textarea") {
    await loc.click();
    await loc.fill(value);
  } else {
    await loc.click();
    await loc.fill("");
    await loc.type(value, { delay: 25 });
  }
}

async function fillKnownFields(page: Page, profile: ApplicationProfile): Promise<void> {
  // Lever uses specific input names
  const knownFields: Record<string, string> = {
    "name": `${profile.firstName} ${profile.lastName}`,
    "email": profile.email,
    "phone": profile.phone,
    "org": "",           // current company — leave blank
    "urls[LinkedIn]": profile.linkedinUrl || "",
    "urls[Portfolio]": profile.portfolioUrl || "",
    "urls[GitHub]": profile.githubUrl || "",
    "location": `${profile.city}, ${profile.state}`,
  };

  for (const [name, value] of Object.entries(knownFields)) {
    if (!value) continue;
    const loc = page.locator(`[name="${name}"]`).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      const current = await loc.inputValue().catch(() => "");
      if (!current) {
        await loc.fill(value);
      }
    }
  }
}

async function uploadResumeLever(page: Page, resumeBase64: string, resumeFileName: string): Promise<void> {
  let tempPath: string | null = null;
  try {
    tempPath = writeTempResume(resumeBase64, resumeFileName);
    const fileInput = page.locator("input[type='file']").first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(tempPath);
      await page.waitForTimeout(1500);
      console.log("[lever] Resume uploaded");
    }
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); fs.rmdirSync(require("path").dirname(tempPath)); } catch {}
    }
  }
}

async function fillCoverLetter(page: Page, text: string): Promise<void> {
  // Lever cover letter: textarea with class or label "Cover Letter"
  const selectors = [
    "textarea[name='comments']",
    "textarea[placeholder*='cover letter' i]",
    "textarea[aria-label*='cover letter' i]",
    ".cover-letter textarea",
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      const current = await el.inputValue().catch(() => "");
      if (!current) {
        await el.fill(text);
        return;
      }
    }
  }
}

async function handleCustomQuestions(
  page: Page,
  profile: ApplicationProfile,
  jobTitle: string,
  company: string,
  jobDescription: string,
  qa: { question: string; answer: string }[]
): Promise<void> {
  const empties = await page.evaluate(() => {
    const res: { label: string; selector: string; tag: string }[] = [];
    document.querySelectorAll<HTMLElement>("input[type='text'], textarea").forEach((el, i) => {
      const val = (el as HTMLInputElement).value;
      if (val && val.trim()) return;
      const name = (el as HTMLInputElement).name || "";
      if (["name", "email", "phone", "org", "location"].some(k => name.includes(k))) return;
      const lbl = el.closest(".application-question, .field, [class*='question']")
        ?.querySelector("label, h4, p")?.textContent?.trim() || "";
      if (!lbl || lbl.length < 8) return;
      const sel = el.id ? `#${el.id}` : name ? `[name="${name}"]` : `${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`;
      res.push({ label: lbl, selector: sel, tag: el.tagName.toLowerCase() });
    });
    return res;
  });

  for (const q of empties) {
    const answer = await answerCustomQuestion(q.label, profile, jobTitle, company, jobDescription);
    if (!answer) continue;
    try {
      const el = page.locator(q.selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.fill(answer);
        qa.push({ question: q.label, answer });
        console.log(`[lever] Answered: "${q.label.slice(0, 50)}"`);
      }
    } catch {}
  }
}

async function submitLever(page: Page): Promise<boolean> {
  // Scroll to absolute bottom
  await page.keyboard.press("End");
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // Remove any cookie consent dialogs that might overlay the submit button
  await page.evaluate(() => {
    document.querySelectorAll("[role='dialog'], .cookieconsent, [aria-label='cookieconsent'], .cc-window").forEach(el => {
      (el as HTMLElement).style.display = "none";
    });
  });
  await page.waitForTimeout(300);

  // Primary: find submit button via JavaScript (most reliable)
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toLowerCase() || "";
      if (text.includes("submit application") || text.includes("submit your application")) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
        return text;
      }
    }
    // Fallback: any button with "submit" that isn't a cookie button
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toLowerCase() || "";
      if (text.includes("submit") && !text.includes("deny") && !text.includes("accept") && !text.includes("dismiss") && !text.includes("cookie")) {
        btn.scrollIntoView({ block: "center" });
        btn.click();
        return text;
      }
    }
    // Fallback: input[type=submit]
    const submitInput = document.querySelector<HTMLInputElement>("input[type='submit']");
    if (submitInput) { submitInput.click(); return submitInput.value || "input-submit"; }
    return null;
  });

  if (clicked) {
    console.log(`[lever] Submitted via JS click: "${clicked}"`);
    return true;
  }

  // Last resort: Playwright locator with force click
  const btn = page.locator("button").filter({ hasText: /submit/i }).last();
  if (await btn.count() > 0) {
    await btn.click({ force: true, timeout: 5000 }).catch(() => {});
    console.log("[lever] Submitted via force click");
    return true;
  }

  console.error("[lever] No submit button found — dumping buttons:");
  const allButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).map(b => b.textContent?.trim().substring(0, 60))
  );
  console.error("[lever] Buttons on page:", JSON.stringify(allButtons));
  return false;
}
