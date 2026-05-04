/**
 * In-memory job queue with concurrency limiting.
 * Jobs are processed one at a time (MAX_CONCURRENT_BROWSERS = 1 by default for Railway free tier).
 * Results are POSTed back to ScoutAI via webhook.
 */
import { v4 as uuid } from "uuid";
import axios from "axios";
import { ApplyJobRequest, ApplyJobResult, QueuedJob } from "../types";
import { executeApply } from "../applier";

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BROWSERS || "1");
// Real Greenhouse / Workday applies routinely take 4–6 minutes:
// ~30s nav, 15s Cloudflare check, multi-step Claude question answering,
// human-paced delays between fields, and the file upload itself. The old
// 120s default produced false "failed" reports on successful submissions.
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "360000");

const jobs = new Map<string, QueuedJob>();
let running = 0;

export function enqueue(request: ApplyJobRequest): string {
  const id = uuid();
  const job: QueuedJob = {
    id,
    request,
    status: "pending",
    createdAt: new Date(),
  };
  jobs.set(id, job);
  console.log(`[queue] Enqueued ${id} (queue size: ${jobs.size})`);
  void processNext();
  return id;
}

export function getJob(id: string): QueuedJob | undefined {
  return jobs.get(id);
}

export function getAllJobs(): QueuedJob[] {
  return Array.from(jobs.values()).sort((a, b) =>
    b.createdAt.getTime() - a.createdAt.getTime()
  );
}

async function processNext(): Promise<void> {
  if (running >= MAX_CONCURRENT) return;

  const next = Array.from(jobs.values()).find(j => j.status === "pending");
  if (!next) return;

  running++;
  next.status = "running";
  next.startedAt = new Date();
  console.log(`[queue] Processing job ${next.id} (${next.request.atsType} — ${next.request.jobTitle})`);

  try {
    const timeoutPromise = new Promise<ApplyJobResult>((_, reject) =>
      setTimeout(() => reject(new Error("Job timeout exceeded")), JOB_TIMEOUT_MS)
    );

    const result = await Promise.race([
      executeApply(next.request),
      timeoutPromise,
    ]);

    next.status = "done";
    next.result = result;
    next.completedAt = new Date();
    console.log(`[queue] Job ${next.id} done — status: ${result.status} in ${result.durationMs}ms`);

    // POST result back to ScoutAI
    await notifyScoutAI(result);

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[queue] Job ${next.id} failed: ${msg}`);
    next.status = "failed";
    next.error = msg;
    next.completedAt = new Date();

    const failResult: ApplyJobResult = {
      autoApplyJobId: next.request.autoApplyJobId,
      status: "failed",
      failureReason: msg,
      failureCategory: "timeout",
      tokensUsed: 0,
      durationMs: Date.now() - (next.startedAt?.getTime() || Date.now()),
      questionsAnswered: [],
    };
    await notifyScoutAI(failResult);
  } finally {
    running--;
    // Clean up old jobs (keep last 100)
    if (jobs.size > 100) {
      const sorted = Array.from(jobs.entries())
        .sort(([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime());
      for (let i = 0; i < jobs.size - 100; i++) {
        jobs.delete(sorted[i][0]);
      }
    }
    // Process next in queue
    void processNext();
  }
}

async function notifyScoutAI(result: ApplyJobResult): Promise<void> {
  const webhookUrl = `${process.env.SCOUTAI_URL}/api/auto-apply/webhook`;
  const secret = process.env.SCOUTAI_WEBHOOK_SECRET || "";

  // Retry-with-backoff: 3 attempts at 0/2s/8s. A single transient outage
  // on the SaaS side used to leave the AutoApplyJob row stuck in
  // "generating" forever. Combined with the SaaS-side stuck-jobs
  // reconciler this closes the visibility gap for users.
  const delays = [0, 2000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      await axios.post(webhookUrl, result, {
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": secret,
        },
        timeout: 10000,
      });
      console.log(`[queue] Webhook sent for job ${result.autoApplyJobId}${attempt ? ` (attempt ${attempt + 1})` : ""}`);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`[queue] Webhook attempt ${attempt + 1}/${delays.length} failed:`, (err as Error).message);
    }
  }
  // All retries exhausted — non-fatal at the worker level, but the SaaS
  // reconciler must catch this. Log loudly so the Railway log scraper
  // surfaces it.
  console.error(`[queue] Webhook permanently failed for job ${result.autoApplyJobId}:`, (lastErr as Error)?.message);
}
