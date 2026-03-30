import "dotenv/config";
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
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
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

app.listen(PORT, () => {
  console.log(`[server] ScoutAI worker running on port ${PORT}`);
  console.log(`[server] PLAYWRIGHT_HEADLESS=${process.env.PLAYWRIGHT_HEADLESS || "true"}`);
  console.log(`[server] MAX_CONCURRENT=${process.env.MAX_CONCURRENT_BROWSERS || "1"}`);
});

export default app;
