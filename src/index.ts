import express, { Request, Response, NextFunction } from "express";
import { enqueue, getJob, getAllJobs } from "./queue";
import { ApplyJobRequest } from "./types";
import { closeBrowser } from "./applier/browser";

const app = express();
app.use(express.json({ limit: "25mb" })); // large — resume base64 can be ~5MB

const PORT = parseInt(process.env.PORT || "3001");

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.WORKER_SECRET;
  const provided = req.headers["x-worker-secret"] || req.headers.authorization?.replace("Bearer ", "");
  if (secret && provided !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — Railway uses this
app.get("/health", async (_req, res) => {
  const key = process.env.TWOCAPTCHA_API_KEY?.trim() || "";
  let balance = "unknown";
  if (key) {
    try {
      const r = await fetch(`https://2captcha.com/res.php?key=${key}&action=getbalance&json=1`);
      const d = await r.json() as Record<string, unknown>;
      balance = d.status === 1 ? `$${d.request}` : String(d.request);
    } catch {}
  }
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    captchaSolver: {
      configured: !!key,
      keyLength: key.length,
      keyPrefix: key.substring(0, 4) || "none",
      balance,
    },
    webhookUrl: process.env.SCOUTAI_URL || "not set",
  });
});

// Enqueue a new apply job
app.post("/apply", requireSecret, (req: Request, res: Response) => {
  const body = req.body as ApplyJobRequest;

  // Validate required fields
  const missing: string[] = [];
  if (!body.autoApplyJobId) missing.push("autoApplyJobId");
  if (!body.applyUrl) missing.push("applyUrl");
  if (!body.profile?.email) missing.push("profile.email");
  if (!body.resumeBase64) missing.push("resumeBase64");
  if (!body.jobTitle) missing.push("jobTitle");
  if (!body.company) missing.push("company");

  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
    return;
  }

  const queueId = enqueue(body);
  res.status(202).json({
    queueId,
    autoApplyJobId: body.autoApplyJobId,
    message: "Job queued — results will be POSTed to ScoutAI webhook",
    statusUrl: `/status/${queueId}`,
  });
});

// Poll job status
app.get("/status/:queueId", requireSecret, (req: Request, res: Response) => {
  const job = getJob(req.params.queueId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({
    queueId: job.id,
    status: job.status,
    autoApplyJobId: job.request.autoApplyJobId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result ? {
      status: job.result.status,
      method: job.result.method,
      failureReason: job.result.failureReason,
      failureCategory: job.result.failureCategory,
      tokensUsed: job.result.tokensUsed,
      durationMs: job.result.durationMs,
      questionsCount: job.result.questionsAnswered?.length || 0,
      hasScreenshot: !!job.result.confirmationScreenshot,
    } : null,
    error: job.error,
  });
});

// Diagnostic: visit a URL and report what the worker sees (CAPTCHA detection test)
app.get("/diagnose", requireSecret, async (req: Request, res: Response) => {
  const url = req.query.url as string;
  if (!url) { res.status(400).json({ error: "url query param required" }); return; }

  try {
    const { getBrowser, createContext, hasCaptcha } = require("./applier/browser");
    const { detectCaptcha } = require("./applier/captcha-solver");
    const browser = await getBrowser();
    const ctx = await createContext(browser);
    const page = await ctx.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);

    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const captchaDetected = await hasCaptcha(page);
    const captchaInfo = await detectCaptcha(page);
    const iframes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("iframe")).map(f => (f as HTMLIFrameElement).src).slice(0, 10)
    );

    await ctx.close();
    res.json({ title, url: page.url(), captchaDetected, captchaInfo, iframes, bodyPreview: bodyText.substring(0, 300) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Queue overview (admin)
app.get("/jobs", requireSecret, (_req, res) => {
  const all = getAllJobs().slice(0, 50).map(j => ({
    id: j.id,
    status: j.status,
    atsType: j.request.atsType,
    jobTitle: j.request.jobTitle,
    company: j.request.company,
    createdAt: j.createdAt,
    durationMs: j.result?.durationMs,
    resultStatus: j.result?.status,
  }));
  res.json({ count: all.length, jobs: all });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[server] SIGTERM received — closing browser and exiting");
  await closeBrowser();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});

// Global error handlers — ensure crashes are logged
process.on("uncaughtException", (err) => { console.error("[CRASH] Uncaught exception:", err); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error("[CRASH] Unhandled rejection:", err); });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] ScoutAI worker running on port ${PORT}`);
  console.log(`[server] PLAYWRIGHT_HEADLESS=${process.env.PLAYWRIGHT_HEADLESS || "true"}`);
  console.log(`[server] MAX_CONCURRENT=${process.env.MAX_CONCURRENT_BROWSERS || "1"}`);
});

export default app;
