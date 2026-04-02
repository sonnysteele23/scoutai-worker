/**
 * Ashby ATS applier — jobs.ashbyhq.com
 *
 * Ashby forms are single-page like Greenhouse:
 * 1. Personal info (name, email, phone, location)
 * 2. Resume upload
 * 3. LinkedIn, portfolio, website links
 * 4. Cover letter textarea
 * 5. Custom questions per job
 * 6. EEO / diversity section
 * 7. Submit button
 */
import { Page } from "playwright";
import { ApplicationProfile, FilledField } from "../types";
import { analyzeFormAndFill, answerCustomQuestion } from "./claude";
import { getPageSnapshot, hasCaptcha, screenshot, writeTempResume, humanDelay, humanScroll, humanScan } from "./browser";
import { handleCaptcha } from "./captcha-solver";
import * as fs from "fs";

export interface AshbyResult {
  success: boolean;
  questionsAnswered: { question: string; answer: string }[];
  confirmationScreenshot?: string;
  failureReason?: string;
  failureCategory?: "captcha" | "missing_field" | "custom_question" | "timeout" | "other";
}

export async function applyAshby(
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
): Promise<AshbyResult> {
  const questionsAnswered: { question: string; answer: string }[] = [];

  try {
    // Ensure URL points to the application form
    const formUrl = applyUrl.includes("/application")
      ? applyUrl
      : applyUrl.replace(/\/?$/, "/application");

    console.log(`[ashby] Navigating to ${formUrl}`);
    await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Wait for Cloudflare challenge if present
    const cfChallenge = await page.evaluate(() =>
      document.body.innerText.toLowerCase().includes("checking your browser") ||
      document.body.innerText.toLowerCase().includes("just a moment")
    );
    if (cfChallenge) {
      console.log("[ashby] Cloudflare challenge — waiting...");
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(1000);
        const still = await page.evaluate(() =>
          document.body.innerText.toLowerCase().includes("checking your browser") ||
          document.body.innerText.toLowerCase().includes("just a moment")
        );
        if (!still) { console.log(`[ashby] Cloudflare resolved after ${i + 1}s`); break; }
      }
      await page.waitForTimeout(2000);
    }

    // Dismiss cookie consent
    try {
      const cookieBtn = page.locator("button:has-text('Accept'), button:has-text('Dismiss'), button:has-text('Got it')").first();
      if (await cookieBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await cookieBtn.click();
        await page.waitForTimeout(500);
      }
    } catch {}

    // Human-like behavior
    await humanDelay(1000, 2000);
    await humanScan(page);
    await humanScroll(page, 200);

    // Check for full-page CAPTCHA block vs passive
    const isFullPageBlock = await page.evaluate(() => {
      const hasForm = !!document.querySelector("input[type='text'], input[type='email'], textarea");
      const text = document.body.innerText.toLowerCase();
      return !hasForm && (text.includes("verify") || text.includes("captcha"));
    });

    if (isFullPageBlock) {
      console.log("[ashby] Full-page CAPTCHA block");
      const solved = await handleCaptcha(page);
      if (!solved) {
        return { success: false, questionsAnswered, failureReason: "Full-page CAPTCHA — solver failed", failureCategory: "captcha" };
      }
      await humanDelay(2000, 3000);
    } else if (await hasCaptcha(page)) {
      console.log("[ashby] Passive CAPTCHA detected — will handle after submit");
    }

    // ── AI form analysis ─────────────────────────────────────────────
    const snapshot = await getPageSnapshot(page);
    console.log(`[ashby] Snapshot: ${snapshot.split("\n").length} fields`);

    const fields: FilledField[] = await analyzeFormAndFill(
      snapshot, profile, jobTitle, company, jobDescription, coverLetterText
    );
    console.log(`[ashby] Claude returned ${fields.length} fields`);

    // ── Fill fields ──────────────────────────────────────────────────
    for (const field of fields) {
      if (field.type === "file") continue;
      try {
        await humanDelay(200, 800);
        await fillAshbyField(page, field);
        questionsAnswered.push({ question: field.label, answer: field.value });
      } catch (e) {
        console.warn(`[ashby] Skip "${field.label}": ${(e as Error).message}`);
      }
    }
    await humanScroll(page, 300);

    // ── Fill known fields by common patterns ─────────────────────────
    await fillKnownFields(page, profile);

    // ── Resume upload ────────────────────────────────────────────────
    await uploadResume(page, resumeBase64, resumeFileName);

    // ── Cover letter ─────────────────────────────────────────────────
    if (coverLetterText) {
      const clSelectors = [
        "textarea[name*='cover' i]",
        "textarea[placeholder*='cover letter' i]",
        "textarea[aria-label*='cover letter' i]",
        "textarea[name*='additional' i]",
      ];
      for (const sel of clSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          const current = await el.inputValue().catch(() => "");
          if (!current) {
            await el.fill(coverLetterText);
            questionsAnswered.push({ question: "Cover Letter", answer: coverLetterText.slice(0, 100) + "..." });
            break;
          }
        }
      }
    }

    // ── Custom questions ─────────────────────────────────────────────
    await handleCustomQuestions(page, profile, jobTitle, company, jobDescription, questionsAnswered);

    // ── Submit ───────────────────────────────────────────────────────
    if (!dryRun) {
      await humanDelay(500, 1500);
      const submitted = await submitAshby(page);
      if (!submitted) {
        return { success: false, questionsAnswered, failureReason: "No submit button found", failureCategory: "other" };
      }
      await page.waitForTimeout(3000);

      // Post-submit CAPTCHA
      if (await hasCaptcha(page)) {
        console.log("[ashby] Post-submit CAPTCHA — solving...");
        const solved = await handleCaptcha(page);
        if (solved) {
          await page.waitForTimeout(2000);
          await submitAshby(page);
          await page.waitForTimeout(3000);
        } else {
          return { success: false, questionsAnswered, failureReason: "CAPTCHA after submit — click Continue manually to finish", failureCategory: "captcha" };
        }
      }
    }

    const shot = await screenshot(page);
    const text = await page.evaluate(() => document.body.innerText);
    const confirmed = /thank you|application received|submitted|confirmation|we.?ll be in touch/i.test(text);
    if (!dryRun && !confirmed) console.warn("[ashby] Confirmation text not found");

    return { success: true, questionsAnswered, confirmationScreenshot: shot };

  } catch (err) {
    const msg = (err as Error).message;
    return { success: false, questionsAnswered, failureReason: msg, failureCategory: msg.includes("timeout") ? "timeout" : "other" };
  }
}

async function fillAshbyField(page: Page, field: FilledField): Promise<void> {
  const { selector, value, type } = field;
  if (!selector || !value) return;

  const loc = page.locator(selector).first();
  const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);

  if (!visible) {
    // Fallback: try by label text
    const byLabel = page.getByLabel(field.label, { exact: false }).first();
    if (!await byLabel.isVisible({ timeout: 1500 }).catch(() => false)) return;
    if (type === "select") {
      await byLabel.selectOption({ label: value }).catch(() => byLabel.selectOption(value));
    } else {
      await byLabel.fill(value);
    }
    return;
  }

  if (type === "select") {
    await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
  } else if (type === "radio") {
    const radio = page.locator(`input[type="radio"]`).filter({ hasText: value }).first();
    if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) await radio.click();
  } else if (type === "checkbox") {
    if (value.toLowerCase() === "yes" || value === "true") {
      if (!await loc.isChecked()) await loc.click();
    }
  } else {
    await loc.click({ timeout: 2000 });
    await loc.fill("");
    await loc.type(value, { delay: 25 });
  }
}

async function fillKnownFields(page: Page, profile: ApplicationProfile): Promise<void> {
  const fields: Record<string, string> = {
    "name": `${profile.firstName} ${profile.lastName}`.trim(),
    "email": profile.email,
    "phone": profile.phone,
    "location": `${profile.city}, ${profile.state}`.trim(),
    "linkedin": profile.linkedinUrl || "",
    "portfolio": profile.portfolioUrl || "",
    "github": profile.githubUrl || "",
  };

  for (const [hint, value] of Object.entries(fields)) {
    if (!value) continue;
    // Try by placeholder, name, or aria-label containing the hint
    const selectors = [
      `input[placeholder*='${hint}' i]`,
      `input[name*='${hint}' i]`,
      `input[aria-label*='${hint}' i]`,
    ];
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        const current = await loc.inputValue().catch(() => "");
        if (!current) {
          await loc.fill(value);
          break;
        }
      }
    }
  }
}

async function uploadResume(page: Page, resumeBase64: string, resumeFileName: string): Promise<void> {
  let tempPath: string | null = null;
  try {
    tempPath = writeTempResume(resumeBase64, resumeFileName);
    const fileInputs = page.locator("input[type='file']");
    const count = await fileInputs.count();
    if (count === 0) { console.log("[ashby] No file input found"); return; }
    await fileInputs.first().setInputFiles(tempPath);
    await page.waitForTimeout(1000);
    console.log(`[ashby] Resume uploaded: ${resumeFileName}`);
  } catch (e) {
    console.warn("[ashby] Resume upload failed:", (e as Error).message);
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
  qa: { question: string; answer: string }[]
): Promise<void> {
  const empties = await page.evaluate(() => {
    const res: { label: string; selector: string }[] = [];
    document.querySelectorAll<HTMLElement>("textarea, input[type='text']").forEach((el, i) => {
      if ((el as HTMLInputElement).value?.trim()) return;
      const name = (el as HTMLInputElement).name || "";
      if (["name", "email", "phone", "location", "linkedin", "github", "portfolio", "website"].some(k => name.toLowerCase().includes(k))) return;
      const lbl = el.closest("div")?.querySelector("label")?.textContent?.trim() ||
        el.getAttribute("placeholder") || "";
      if (!lbl || lbl.length < 5) return;
      const sel = el.id ? `#${el.id}` : name ? `[name="${name}"]` : `${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`;
      res.push({ label: lbl, selector: sel });
    });
    return res;
  });

  for (const q of empties) {
    const answer = await answerCustomQuestion(q.label, profile, jobTitle, company, jobDescription);
    if (!answer) continue;
    try {
      const el = page.locator(q.selector).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.fill(answer);
        qa.push({ question: q.label, answer });
        console.log(`[ashby] Answered: "${q.label.slice(0, 50)}"`);
      }
    } catch {}
  }
}

async function submitAshby(page: Page): Promise<boolean> {
  await page.keyboard.press("End");
  await page.waitForTimeout(500);

  // Remove cookie overlays
  await page.evaluate(() => {
    document.querySelectorAll("[aria-label='cookieconsent'], .cc-window, .cookieconsent").forEach(el => el.remove());
    document.querySelectorAll("dialog[open]").forEach(el => {
      const text = el.textContent?.toLowerCase() || "";
      if (text.includes("cookie") || text.includes("privacy") || text.includes("consent")) el.remove();
    });
  });
  await page.waitForTimeout(300);

  // JS click — most reliable
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toLowerCase() || "";
      if (text.includes("submit application") || text.includes("submit your application") || text === "submit" || text === "apply") {
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
    console.log(`[ashby] Submitted: "${clicked}"`);
    return true;
  }

  // Fallback: Playwright force click
  const btn = page.locator("button").filter({ hasText: /submit/i }).last();
  if (await btn.count() > 0) {
    await btn.click({ force: true, timeout: 5000 }).catch(() => {});
    console.log("[ashby] Submitted via force click");
    return true;
  }

  console.error("[ashby] No submit button found");
  return false;
}
