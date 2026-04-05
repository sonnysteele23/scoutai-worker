/**
 * qa-cache.ts
 * Learns from previously answered application questions.
 * When the same question appears on a new job, reuses the answer
 * instead of calling Claude again.
 *
 * Flow:
 * 1. After each application, save Q&A pairs with normalized question text
 * 2. Before answering a new question, check cache for a match
 * 3. Match by normalized text similarity (not exact match — questions vary slightly)
 * 4. If match found with 90%+ similarity, reuse the answer
 * 5. If no match, call Claude and save the new Q&A to cache
 */

// In-memory cache per user session (reset on worker restart)
// For persistence across restarts, this should be backed by DB
const userCache = new Map<string, Map<string, string>>();

/**
 * Normalize a question for matching.
 * Strips punctuation, lowercases, removes common prefixes.
 */
function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[*?!.,;:()'"]/g, "")
    .replace(/^(please |kindly |if applicable,? )/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute simple word overlap similarity between two strings.
 * Returns 0-1 (1 = identical).
 */
function similarity(a: string, b: string): number {
  const wordsA = new Set(a.split(" ").filter(w => w.length > 2));
  const wordsB = new Set(b.split(" ").filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/**
 * Common application questions with standard answers.
 * These are answered from the user's profile without Claude.
 */
const PROFILE_QUESTIONS: { patterns: string[]; profileKey: string; defaultAnswer?: string }[] = [
  { patterns: ["authorized to work", "eligible to work", "legally authorized", "right to work"], profileKey: "workAuthorization", defaultAnswer: "Yes" },
  { patterns: ["require visa sponsorship", "need sponsorship", "require sponsorship", "visa sponsorship"], profileKey: "requireSponsorship", defaultAnswer: "No" },
  { patterns: ["willing to relocate", "open to relocation", "relocate for this"], profileKey: "willingToRelocate", defaultAnswer: "Yes" },
  { patterns: ["desired salary", "salary expectation", "compensation expectation", "expected salary"], profileKey: "desiredSalary" },
  { patterns: ["start date", "available to start", "earliest start", "when can you start"], profileKey: "availableStartDate", defaultAnswer: "Immediately" },
  { patterns: ["hybrid", "remote", "in-office", "on-site", "work arrangement", "work location preference"], profileKey: "workType", defaultAnswer: "Yes" },
  { patterns: ["gender", "gender identity"], profileKey: "gender", defaultAnswer: "Prefer not to say" },
  { patterns: ["race", "ethnicity", "racial"], profileKey: "ethnicity", defaultAnswer: "Prefer not to say" },
  { patterns: ["veteran", "military"], profileKey: "veteranStatus", defaultAnswer: "I am not a veteran" },
  { patterns: ["disability", "disabled"], profileKey: "disabilityStatus", defaultAnswer: "Prefer not to say" },
  { patterns: ["how did you hear", "where did you find", "how did you learn about"], profileKey: "_source", defaultAnswer: "Job board" },
  { patterns: ["worked for", "previously employed", "worked at", "at any other time"], profileKey: "_previousEmployee" },
  { patterns: ["linkedin", "linkedin profile", "linkedin url"], profileKey: "linkedinUrl" },
  { patterns: ["portfolio", "portfolio url", "work samples", "portfolio link"], profileKey: "portfolioUrl" },
  { patterns: ["github", "github url", "github profile"], profileKey: "githubUrl" },
  { patterns: ["phone", "phone number", "contact number"], profileKey: "phone" },
  { patterns: ["website", "personal website", "personal site"], profileKey: "portfolioUrl" },
];

/**
 * Try to answer a question from the user's profile data (no AI needed).
 * Returns the answer or null if not a profile question.
 */
export function answerFromProfile(
  question: string,
  profile: Record<string, string>,
  resumeCompanies?: string[]
): string | null {
  const normalized = normalizeQuestion(question);

  for (const pq of PROFILE_QUESTIONS) {
    if (pq.patterns.some(p => normalized.includes(p))) {
      // Special case: "Have you worked for [Company] previously?"
      if (pq.profileKey === "_previousEmployee" && resumeCompanies) {
        // Extract company name from the question
        const match = question.match(/worked (?:for|at) ([A-Z][a-zA-Z\s&.,]+?)(?:\s+at|\s+before|\s+previously|\?|$)/i);
        if (match) {
          const company = match[1].trim().toLowerCase();
          const hasWorked = resumeCompanies.some(c => c.toLowerCase().includes(company) || company.includes(c.toLowerCase()));
          return hasWorked ? "Yes" : "No";
        }
        return "No";
      }

      // Special case: "How did you hear about this job?"
      if (pq.profileKey === "_source") {
        return pq.defaultAnswer || "Job board";
      }

      const value = profile[pq.profileKey];
      if (value) return value;
      if (pq.defaultAnswer) return pq.defaultAnswer;
    }
  }

  return null;
}

/**
 * Check the Q&A cache for a previously answered similar question.
 * Returns the cached answer or null.
 */
export function getCachedAnswer(userId: string, question: string): string | null {
  const cache = userCache.get(userId);
  if (!cache || cache.size === 0) return null;

  const normalized = normalizeQuestion(question);

  // Check for exact match first
  if (cache.has(normalized)) return cache.get(normalized)!;

  // Check for similar match (90%+ similarity)
  for (const [cachedQ, cachedA] of cache.entries()) {
    if (similarity(normalized, cachedQ) >= 0.9) {
      return cachedA;
    }
  }

  return null;
}

/**
 * Save a Q&A pair to the cache for future reuse.
 */
export function cacheAnswer(userId: string, question: string, answer: string): void {
  if (!userCache.has(userId)) {
    userCache.set(userId, new Map());
  }
  userCache.get(userId)!.set(normalizeQuestion(question), answer);
}

/**
 * Load cached Q&A from a list of previous applications.
 * Called at worker startup or when processing a new user.
 */
export function loadCache(userId: string, previousQA: { question: string; answer: string }[]): void {
  if (!userCache.has(userId)) {
    userCache.set(userId, new Map());
  }
  const cache = userCache.get(userId)!;
  for (const qa of previousQA) {
    cache.set(normalizeQuestion(qa.question), qa.answer);
  }
  console.log(`[qa-cache] Loaded ${previousQA.length} cached Q&A for user ${userId.slice(0, 8)}`);
}

/**
 * Clear cache for a user (called when they update their profile).
 */
export function clearCache(userId: string): void {
  userCache.delete(userId);
}
