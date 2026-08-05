import type { InsightKind, ScoreBand, ScoreContribution } from "@saas/contracts/prospecting";

/**
 * The prompt version. Bump when the prompt text changes: it is part of the
 * insight cache key, so a bump invalidates every cached generation — which is
 * the intent. A prompt change that silently reused old output would make
 * `prompt_version` a lie.
 */
export const PROMPT_VERSION = 1;

/**
 * Everything the model is allowed to see. There is deliberately no free-form
 * field here: the model gets the business record, the score, and the
 * contributions, and nothing else. It cannot cite a fact it was not given,
 * because it was not given any.
 */
export interface InsightPromptInput {
  kind: InsightKind;
  prospectName: string;
  prospectDomain: string | null;
  industry: string | null;
  locality: string | null;
  score: number;
  band: ScoreBand;
  contributions: ScoreContribution[];
}

export interface ModelResult {
  content: string;
  model: string;
}

export type ModelOutcome =
  | { ok: true; result: ModelResult }
  | { ok: false; reason: "declined" | "unavailable" };

export interface ModelAdapter {
  readonly id: string;
  generate(input: InsightPromptInput): Promise<ModelOutcome>;
}
