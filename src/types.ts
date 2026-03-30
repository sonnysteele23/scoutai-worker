// Shared types across the worker service

export interface ApplicationProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  linkedinUrl: string;
  portfolioUrl: string;
  githubUrl: string;
  workAuthorized: string;       // "yes" | "no"
  requiresSponsorship: string;  // "no" | "yes" | "future"
  desiredSalary: string;
  availableStartDate: string;   // "immediately" | "2weeks" | "1month" | "negotiable"
  willingToRelocate: string;    // "no" | "yes" | "maybe"
  preferredWorkType: string;    // "remote" | "hybrid" | "onsite" | "any"
  yearsExperience: string;
  highestEducation: string;
  referralSource: string;
  gender: string;
  race: string;
  veteranStatus: string;
  disabilityStatus: string;
  customFields: { label: string; value: string }[];
}

export interface ApplyJobRequest {
  jobId: string;           // ScoutAI job ID (for tracking)
  autoApplyJobId: string;  // ScoutAI AutoApplyJob record ID
  userId: string;
  applyUrl: string;        // Direct ATS URL to apply at
  jobTitle: string;
  company: string;
  jobDescription: string;
  atsType: string;         // "greenhouse" | "lever" | "workday" | "other"
  profile: ApplicationProfile;
  resumeBase64: string;    // PDF as base64
  resumeFileName: string;
  coverLetterText?: string;
  humanization?: number;   // 0-100
  dryRun?: boolean;        // if true, fill but don't submit
}

export interface ApplyJobResult {
  autoApplyJobId: string;
  status: "applied" | "failed" | "captcha" | "unsupported";
  method?: string;
  confirmationUrl?: string;
  confirmationScreenshot?: string; // base64 PNG
  questionsAnswered?: { question: string; answer: string }[];
  coverLetterText?: string;
  failureReason?: string;
  failureCategory?: "missing_field" | "captcha" | "portal_unsupported" | "custom_question" | "timeout" | "other";
  tokensUsed: number;
  durationMs: number;
}

export interface QueuedJob {
  id: string;
  request: ApplyJobRequest;
  status: "pending" | "running" | "done" | "failed";
  result?: ApplyJobResult;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface FormField {
  label: string;
  type: "text" | "email" | "tel" | "select" | "radio" | "checkbox" | "file" | "textarea";
  selector: string;
  options?: string[];   // for select/radio
  required: boolean;
  currentValue?: string;
}

export interface FilledField {
  label: string;
  selector: string;
  value: string;
  type: string;
}
