/**
 * Pure view-model logic for the prospecting surfaces.
 *
 * Dependency-free (no React, no icons, no SDK) so every rule the console
 * renders — how a band is coloured, when a card counts as stuck, how a
 * contribution becomes a bar, what a quota error means — is unit-testable
 * without mounting a page.
 *
 * The one rule this file must never break: **it derives, it does not decide.**
 * The score, the band, and the contributions come from the server. Nothing
 * here recomputes them; a console that could disagree with the engine would
 * make the explainer a second opinion rather than a rendering.
 */

import type {
  PipelineBoardEntry,
  PublicPipelineStage,
  PublicProspect,
  QuotaExhaustedDetails,
  ScoreBand,
  ScoreContribution,
  SignalKind,
} from "@saas/contracts/prospecting";

// ── Bands ──────────────────────────────────────────────────

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

/**
 * `hot` is the one that should pull the eye, so it takes the strongest
 * variant. Bands are a server fact — never recomputed from the number here.
 */
export function bandVariant(band: ScoreBand | null): BadgeVariant {
  switch (band) {
    case "hot":
      return "destructive";
    case "warm":
      return "default";
    case "cold":
      return "secondary";
    default:
      return "outline";
  }
}

export function bandLabel(band: ScoreBand | null): string {
  return band ?? "unscored";
}

// ── Score explainer ────────────────────────────────────────

export interface ContributionBar {
  kind: SignalKind;
  points: number;
  reason: string;
  /** 0–100, relative to the largest contribution in the same score. */
  percent: number;
}

/**
 * Bars are scaled against the *largest contribution in this score*, not
 * against 100. Scaling against 100 would make a well-balanced 45 render as a
 * row of stubs, which reads as "nothing here" when the point is the opposite.
 */
export function contributionBars(contributions: ScoreContribution[]): ContributionBar[] {
  const max = contributions.reduce((acc, c) => Math.max(acc, c.points), 0);
  return contributions.map((c) => ({
    kind: c.kind,
    points: c.points,
    reason: c.reason,
    percent: max <= 0 ? 0 : Math.round((c.points / max) * 100),
  }));
}

/** The provenance line under the explainer — never omitted. */
export function scoreProvenance(rulesetVersion: number, profileVersion: number): string {
  const profile = profileVersion === 0 ? "default weights" : `weight profile v${profileVersion}`;
  return `ruleset v${rulesetVersion} · ${profile}`;
}

// ── Quota ──────────────────────────────────────────────────

export interface QuotaState {
  meter: string;
  limit: number | null;
  used: number | null;
  resetAt: string | null;
  message: string;
}

/**
 * Recognise the typed 402 and pull out everything the upgrade prompt needs.
 *
 * The contract's whole point is that this payload is sufficient — the console
 * must never need a second round trip to tell a user why they are blocked or
 * when it clears.
 */
export function asQuotaState(
  error: { code: string; message: string; details?: Record<string, unknown> | undefined } | null,
): QuotaState | null {
  if (!error || error.code !== "quota_exhausted") return null;
  const details = (error.details ?? {}) as Partial<QuotaExhaustedDetails>;
  return {
    meter: typeof details.meter === "string" ? details.meter : "unknown",
    limit: typeof details.limit === "number" ? details.limit : null,
    used: typeof details.used === "number" ? details.used : null,
    resetAt: typeof details.resetAt === "string" ? details.resetAt : null,
    message: error.message,
  };
}

/** "You've used 100 of 100 this month. Resets 1 Jul." */
export function quotaSummary(state: QuotaState, formatDate: (iso: string) => string = defaultFormatDate): string {
  const parts: string[] = [];
  if (state.used !== null && state.limit !== null) {
    parts.push(`You've used ${state.used} of ${state.limit} this month.`);
  } else if (state.limit === 0) {
    parts.push("This capability is not included in your current plan.");
  }
  if (state.resetAt) parts.push(`Resets ${formatDate(state.resetAt)}.`);
  return parts.join(" ") || state.message;
}

function defaultFormatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

// ── Prospect filters ───────────────────────────────────────

export interface ProspectFilterState {
  band: ScoreBand | "";
  signalKind: SignalKind | "";
  stageKey: string;
}

export const EMPTY_FILTERS: ProspectFilterState = { band: "", signalKind: "", stageKey: "" };

/** Only non-empty filters reach the query — an empty string is not a filter. */
export function buildProspectQuery(filters: ProspectFilterState): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.band) query.band = filters.band;
  if (filters.signalKind) query.signalKind = filters.signalKind;
  if (filters.stageKey) query.stageKey = filters.stageKey;
  return query;
}

export function hasActiveFilters(filters: ProspectFilterState): boolean {
  return Object.keys(buildProspectQuery(filters)).length > 0;
}

// ── Discovery run polling ──────────────────────────────────

export const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isRunTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** A one-line summary of a run, used while polling and after it finishes. */
export function runSummary(run: {
  status: string;
  candidatesFound: number;
  prospectsCreated: number;
  prospectsUpdated: number;
  signalsRecorded: number;
  errorCode: string | null;
}): string {
  if (run.status === "running") {
    return `Working… ${run.prospectsCreated} created, ${run.prospectsUpdated} updated so far.`;
  }
  const base = `${run.candidatesFound} examined · ${run.prospectsCreated} created · ${run.prospectsUpdated} updated · ${run.signalsRecorded} signals`;
  // A failed run keeps its counters: the prospects it produced are real and
  // the user can see them. Hiding them behind the failure would be a lie.
  return run.status === "failed" ? `${base} · stopped: ${run.errorCode ?? "adapter error"}` : base;
}

// ── Pipeline board ─────────────────────────────────────────

/** A card older than this in one stage gets the stuck treatment. */
export const STUCK_DAYS = 7;

export function isStuck(entry: { daysInStage: number; closedAt: string | null }): boolean {
  return entry.closedAt === null && entry.daysInStage >= STUCK_DAYS;
}

export interface BoardColumn {
  stage: PublicPipelineStage;
  entries: PipelineBoardEntry[];
  /** How many cards in this column have been sitting too long. */
  stuckCount: number;
}

/**
 * Group entries into columns in stage order.
 *
 * Every stage gets a column even when empty — a kanban that hides its empty
 * columns cannot be dragged into, which is exactly when a user needs them.
 */
export function buildBoard(stages: PublicPipelineStage[], entries: PipelineBoardEntry[]): BoardColumn[] {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  return ordered.map((stage) => {
    const inStage = entries
      .filter((entry) => entry.stageKey === stage.key)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.daysInStage - a.daysInStage);
    return { stage, entries: inStage, stuckCount: inStage.filter(isStuck).length };
  });
}

/** Terminal stages read as an outcome, not as a step. */
export function stageIsTerminal(stage: PublicPipelineStage): boolean {
  return stage.outcome !== "open";
}

// ── Insights ───────────────────────────────────────────────

export function guardrailVariant(verdict: "pass" | "revised"): BadgeVariant {
  // `revised` is not a warning — it means the guardrail worked. It gets an
  // outline so it reads as informational rather than as an error.
  return verdict === "pass" ? "secondary" : "outline";
}

export function guardrailExplanation(verdict: "pass" | "revised", noteCount: number): string {
  if (verdict === "pass") return "Generated unchanged — every claim maps to an observed signal.";
  return `The guardrail edited this draft (${noteCount} ${noteCount === 1 ? "change" : "changes"}) before storing it.`;
}

// ── Sorting the board list ─────────────────────────────────

/**
 * Hot first, then by score. The point of the prospects table is that the best
 * opportunity is visible without scrolling.
 */
export function sortProspects(prospects: PublicProspect[]): PublicProspect[] {
  const bandRank: Record<string, number> = { hot: 0, warm: 1, cold: 2 };
  return [...prospects].sort((a, b) => {
    const aRank = a.currentScore ? bandRank[a.currentScore.band] ?? 3 : 4;
    const bRank = b.currentScore ? bandRank[b.currentScore.band] ?? 3 : 4;
    if (aRank !== bRank) return aRank - bRank;
    return (b.currentScore?.score ?? -1) - (a.currentScore?.score ?? -1);
  });
}
