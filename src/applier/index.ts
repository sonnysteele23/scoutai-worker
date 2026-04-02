/**
 * Main apply orchestrator — dispatches to the right ATS handler
 */
import { ApplyJobRequest, ApplyJobResult } from "../types";
import { getBrowser, createContext, screenshot, hasCaptcha } from "./browser";
import { applyGreenhouse } from "./greenhouse";
import { applyLever } from "./lever";
import { applyIndeed } from "./indeed";
import { applyWorkday } from "./workday";
import { applyAshby } from "./ashby";
import { generateCoverLetter, getTokensUsed, resetTokens } from "./claude";

export async function executeApply(req: ApplyJobRequest): Promise<ApplyJobResult> {
  const startMs = Date.now();
  resetTokens();

  const browser = await getBrowser();
  const ctx = await createContext(browser);
  const page = await ctx.newPage();

  try {
    // Generate cover letter if not provided and mode is "generate"
    let coverLetterText = req.coverLetterText || "";
    if (!coverLetterText) {
      console.log("[orchestrator] Generating cover letter...");
      coverLetterText = await generateCoverLetter(
        req.profile, req.jobTitle, req.company,
        req.jobDescription, req.humanization || 40
      );
    }

    // Dispatch to ATS handler
    let result: Omit<ApplyJobResult, "autoApplyJobId" | "tokensUsed" | "durationMs">;

    const ats = req.atsType || detectAts(req.applyUrl);
    console.log(`[orchestrator] ATS type: ${ats}`);

    if (ats === "greenhouse") {
      const r = await applyGreenhouse(
        page, req.applyUrl, req.profile,
        req.resumeBase64, req.resumeFileName,
        coverLetterText, req.jobTitle, req.company,
        req.jobDescription, req.dryRun
      );
      result = {
        status: r.success ? "applied" : (r.failureCategory === "captcha" ? "captcha" : "failed"),
        method: "greenhouse",
        confirmationScreenshot: r.confirmationScreenshot,
        questionsAnswered: r.questionsAnswered,
        coverLetterText,
        failureReason: r.failureReason,
        failureCategory: r.failureCategory,
      };
    } else if (ats === "lever") {
      const r = await applyLever(
        page, req.applyUrl, req.profile,
        req.resumeBase64, req.resumeFileName,
        coverLetterText, req.jobTitle, req.company,
        req.jobDescription, req.dryRun
      );
      result = {
        status: r.success ? "applied" : (r.failureCategory === "captcha" ? "captcha" : "failed"),
        method: "lever",
        confirmationScreenshot: r.confirmationScreenshot,
        questionsAnswered: r.questionsAnswered,
        coverLetterText,
        failureReason: r.failureReason,
        failureCategory: r.failureCategory,
      };
    } else if (ats === "indeed") {
      const r = await applyIndeed(
        page, req.applyUrl, req.profile,
        req.resumeBase64, req.resumeFileName,
        coverLetterText, req.jobTitle, req.company,
        req.jobDescription, req.dryRun
      );
      result = {
        status: r.success ? "applied" : (r.failureCategory === "captcha" ? "captcha" : (r.failureCategory === "login_required" ? "unsupported" : "failed")),
        method: "indeed",
        confirmationScreenshot: r.confirmationScreenshot,
        questionsAnswered: r.questionsAnswered,
        coverLetterText,
        failureReason: r.failureReason,
        failureCategory: r.failureCategory === "login_required" ? "portal_unsupported" : r.failureCategory,
      };
    } else if (ats === "workday") {
      const r = await applyWorkday(
        page, req.applyUrl, req.profile,
        req.resumeBase64, req.resumeFileName,
        coverLetterText, req.jobTitle, req.company,
        req.jobDescription, req.dryRun
      );
      result = {
        status: r.success ? "applied" : (r.failureCategory === "captcha" ? "captcha" : "failed"),
        method: "workday",
        confirmationScreenshot: r.confirmationScreenshot,
        questionsAnswered: r.questionsAnswered,
        coverLetterText,
        failureReason: r.failureReason,
        failureCategory: r.failureCategory,
      };
    } else if (ats === "ashby") {
      const r = await applyAshby(
        page, req.applyUrl, req.profile,
        req.resumeBase64, req.resumeFileName,
        coverLetterText, req.jobTitle, req.company,
        req.jobDescription, req.dryRun
      );
      result = {
        status: r.success ? "applied" : (r.failureCategory === "captcha" ? "captcha" : "failed"),
        method: "ashby",
        confirmationScreenshot: r.confirmationScreenshot,
        questionsAnswered: r.questionsAnswered,
        coverLetterText,
        failureReason: r.failureReason,
        failureCategory: r.failureCategory,
      };
    } else {
      // Unsupported ATS — take screenshot so user can see why
      await page.goto(req.applyUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      const shot = await screenshot(page).catch(() => "");
      const captcha = await hasCaptcha(page).catch(() => false);
      result = {
        status: captcha ? "captcha" : "unsupported",
        confirmationScreenshot: shot,
        failureReason: captcha ? "CAPTCHA detected" : `ATS "${ats}" not yet supported (coming soon)`,
        failureCategory: captcha ? "captcha" : "portal_unsupported",
        questionsAnswered: [],
        coverLetterText,
      };
    }

    return {
      autoApplyJobId: req.autoApplyJobId,
      tokensUsed: getTokensUsed(),
      durationMs: Date.now() - startMs,
      ...result,
    };

  } catch (err) {
    const msg = (err as Error).message;
    console.error("[orchestrator] Fatal error:", msg);
    return {
      autoApplyJobId: req.autoApplyJobId,
      status: "failed",
      failureReason: msg,
      failureCategory: "other",
      tokensUsed: getTokensUsed(),
      durationMs: Date.now() - startMs,
      questionsAnswered: [],
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

function detectAts(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("greenhouse.io")) return "greenhouse";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("myworkdayjobs.com") || u.includes("myworkdaysite.com")) return "workday";
  if (u.includes("indeed.com")) return "indeed";
  if (u.includes("linkedin.com")) return "linkedin";
  return "other";
}
