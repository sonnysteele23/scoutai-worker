import Anthropic from "@anthropic-ai/sdk";
import { ApplicationProfile, FilledField } from "../types";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

let totalTokens = 0;
export function getTokensUsed() { return totalTokens; }
export function resetTokens() { totalTokens = 0; }

/**
 * Given raw page HTML/text snapshot and user profile,
 * Claude returns JSON of exactly what to fill in each visible form field.
 */
export async function analyzeFormAndFill(
  pageSnapshot: string,
  profile: ApplicationProfile,
  jobTitle: string,
  company: string,
  jobDescription: string,
  coverLetterText?: string
): Promise<FilledField[]> {
  const profileText = buildProfileSummary(profile);

  const prompt = `You are filling out a job application form on behalf of a candidate.

JOB: ${jobTitle} at ${company}
JOB DESCRIPTION (first 800 chars): ${jobDescription.slice(0, 800)}

CANDIDATE PROFILE:
${profileText}

${coverLetterText ? `COVER LETTER (pre-written):\n${coverLetterText.slice(0, 2000)}\n\n` : ""}

PAGE SNAPSHOT (accessibility tree / visible text):
${pageSnapshot.slice(0, 8000)}

Your task: Return a JSON array of form fields to fill. For EACH fillable field visible on the page, provide:
{
  "label": "the field label as shown on page",
  "selector": "CSS selector or aria-label to target this field",
  "value": "what to enter based on the candidate profile",
  "type": "text|email|tel|textarea|select|radio|checkbox|file"
}

RULES:
- Only include fields you can see in the snapshot
- For "How did you hear about us?" use "${profile.referralSource || "LinkedIn"}"
- For gender/race/disability/veteran EEO fields use the candidate's preferences (${profile.gender}, ${profile.race}, ${profile.veteranStatus}, ${profile.disabilityStatus})
- For work authorization: "${profile.workAuthorized === "yes" ? "Yes, I am authorized to work in the US" : "No"}"
- For visa sponsorship: "${profile.requiresSponsorship === "no" ? "No, I do not require sponsorship" : "Yes"}"
- For cover letter textarea: use the pre-written cover letter if provided, otherwise generate 2 short paragraphs
- For "additional information" or open-ended: write a brief, professional 1-sentence response
- SKIP file upload fields (handled separately)
- SKIP CAPTCHA fields
- Return ONLY valid JSON array, no markdown, no explanation`;

  const response = await getClient().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

  const raw = response.content[0].type === "text" ? response.content[0].text : "[]";
  const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(clean) as FilledField[];
  } catch {
    console.error("[claude] JSON parse failed:", clean.slice(0, 200));
    return [];
  }
}

/**
 * For custom/essay questions, Claude generates a tailored answer.
 */
export async function answerCustomQuestion(
  question: string,
  profile: ApplicationProfile,
  jobTitle: string,
  company: string,
  jobDescription: string
): Promise<string> {
  const response = await getClient().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 600,
    messages: [{
      role: "user",
      content: `You are answering a custom application question for a job candidate.

JOB: ${jobTitle} at ${company}
QUESTION: "${question}"

CANDIDATE:
- Name: ${profile.firstName} ${profile.lastName}
- Experience: ${profile.yearsExperience} years
- Work preference: ${profile.preferredWorkType}
- Education: ${profile.highestEducation}
- Location: ${profile.city}, ${profile.state}

Write a concise, professional answer (2-4 sentences). Sound human, not AI-generated. 
Be specific but brief. Return ONLY the answer text, no quotes, no explanation.`
    }],
  });

  totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  return response.content[0].type === "text" ? response.content[0].text.trim() : "";
}

/**
 * Generate a tailored cover letter for this specific job.
 */
export async function generateCoverLetter(
  profile: ApplicationProfile,
  jobTitle: string,
  company: string,
  jobDescription: string,
  humanization: number = 40
): Promise<string> {
  const toneMap: Record<number, string> = {
    0: "formal and professional",
    25: "polished and clear",
    50: "natural and confident",
    75: "conversational and genuine",
    100: "authentic and personal"
  };
  const toneKey = [0, 25, 50, 75, 100].reduce((a, b) =>
    Math.abs(b - humanization) < Math.abs(a - humanization) ? b : a
  );
  const tone = toneMap[toneKey];

  const response = await getClient().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 800,
    messages: [{
      role: "user",
      content: `Write a cover letter for this job application.

CANDIDATE: ${profile.firstName} ${profile.lastName}
JOB: ${jobTitle} at ${company}
DESCRIPTION: ${jobDescription.slice(0, 600)}

Tone: ${tone}
Length: 3 short paragraphs, no "Dear Hiring Manager" opener, no "Sincerely" sign-off.
Start directly with the value proposition. Sound human.
Return ONLY the cover letter text.`
    }],
  });

  totalTokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
  return response.content[0].type === "text" ? response.content[0].text.trim() : "";
}

function buildProfileSummary(p: ApplicationProfile): string {
  return [
    `Name: ${p.firstName} ${p.lastName}`,
    `Email: ${p.email}`,
    `Phone: ${p.phone}`,
    `Location: ${p.city}, ${p.state} ${p.zipCode}, ${p.country}`,
    `LinkedIn: ${p.linkedinUrl || "not provided"}`,
    `Portfolio: ${p.portfolioUrl || "not provided"}`,
    `GitHub: ${p.githubUrl || "not provided"}`,
    `Work Auth (US): ${p.workAuthorized === "yes" ? "Authorized" : "Not authorized"}`,
    `Visa Sponsorship: ${p.requiresSponsorship}`,
    `Desired Salary: ${p.desiredSalary || "negotiable"}`,
    `Start Date: ${p.availableStartDate}`,
    `Work Type: ${p.preferredWorkType}`,
    `Relocate: ${p.willingToRelocate}`,
    `Experience: ${p.yearsExperience} years`,
    `Education: ${p.highestEducation}`,
  ].join("\n");
}
