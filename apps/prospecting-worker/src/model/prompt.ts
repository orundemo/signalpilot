import type { InsightPromptInput } from "./types.js";

/**
 * The system prompt. Written to constrain, not to encourage.
 *
 * Every line here exists because the alternative is a specific failure the
 * guardrail would otherwise have to catch — and a generation the guardrail
 * strips is a wasted call the tenant paid for. The guardrail is the
 * enforcement point; this is the cheap first line.
 */
export const SYSTEM_PROMPT = [
  "You write short, factual sales copy for a web agency about a prospective client's website.",
  "",
  "You are given a business record, an opportunity score, and the exact observations that produced that score.",
  "You may reference ONLY those observations. You have no other information about this business, and you must not imply that you do.",
  "",
  "Rules:",
  "- Never invent a person's name, an email address, or a phone number. You were given none.",
  "- Never state a score other than the one provided.",
  "- Never claim past clients, results, testimonials, or credentials for the agency.",
  "- Never use urgency language ('act now', 'limited time', 'last chance') or guarantees.",
  "- Write plainly. No preamble, no sign-off placeholders like [Your Name], no markdown headings.",
].join("\n");

/** The per-request user turn. Deterministic given the same input. */
export function buildUserPrompt(input: InsightPromptInput): string {
  const observations = input.contributions
    .map((c) => `- ${c.reason} (${c.points} points, signal: ${c.kind})`)
    .join("\n");

  const where = [input.industry, input.locality].filter(Boolean).join(", ");
  const identity = [
    `Business: ${input.prospectName}`,
    input.prospectDomain ? `Website: ${input.prospectDomain}` : "Website: none found",
    where ? `Context: ${where}` : null,
    `Opportunity score: ${input.score} of 100 (${input.band})`,
  ]
    .filter(Boolean)
    .join("\n");

  const task =
    input.kind === "prospect_summary"
      ? [
          "Write a 2–3 sentence internal summary for the sales rep.",
          "Say what is wrong with this business's web presence and why it is worth a call.",
          "Write it as notes for a colleague, not as copy for the prospect.",
        ].join(" ")
      : [
          "Write a first-touch outreach email to this business, at most 120 words.",
          "Open by naming one specific, checkable problem from the observations.",
          "Say plainly what you would do about it, and end with a single low-pressure question.",
          "No subject line, no greeting placeholder, no signature.",
        ].join(" ");

  return `${identity}\n\nObservations:\n${observations || "- none"}\n\nTask: ${task}`;
}

/**
 * The cache key: `sha256(kind ‖ prompt_version ‖ score_id ‖ contributions)`.
 *
 * Note what it does *not* include: the clock, the requesting user, or the
 * request id. Two members of the same org asking for the same insight about
 * an unchanged prospect get the same row, and only the first is metered. A
 * rescore changes `score_id` and the contributions, so regeneration after a
 * rescore is a genuine new generation.
 */
export async function inputDigest(
  kind: string,
  promptVersion: number,
  scoreId: string,
  contributions: unknown,
): Promise<string> {
  const payload = `${kind}|${promptVersion}|${scoreId}|${JSON.stringify(contributions)}`;
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}
