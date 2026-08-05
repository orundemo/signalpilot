// Pure view-model tests for the prospecting console surfaces.
//
// Everything the pages render that involves a decision — which band gets which
// treatment, how a contribution becomes a bar, what a 402 means, when a card
// counts as stuck — lives in `prospecting.ts` precisely so it can be asserted
// here without mounting a page.

import {
  EMPTY_FILTERS,
  STUCK_DAYS,
  asQuotaState,
  bandLabel,
  bandVariant,
  buildBoard,
  buildProspectQuery,
  contributionBars,
  guardrailExplanation,
  guardrailVariant,
  hasActiveFilters,
  isRunTerminal,
  isStuck,
  quotaSummary,
  runSummary,
  scoreProvenance,
  sortProspects,
  stageIsTerminal,
} from "@web-console-next/components/prospecting/prospecting";
import type {
  PipelineBoardEntry,
  PublicPipelineStage,
  PublicProspect,
  ScoreContribution,
} from "@saas/contracts/prospecting";

function contribution(kind: string, points: number, reason = "reason"): ScoreContribution {
  return { kind: kind as ScoreContribution["kind"], points, reason, severity: 4, features: {}, signalId: "sig_1" };
}

function stage(key: string, position: number, outcome: "open" | "won" | "lost" = "open"): PublicPipelineStage {
  return { id: `stg_${key}`, orgId: "org_1", key, label: key, position, outcome };
}

function entry(overrides: Partial<PipelineBoardEntry> & { stageKey: string }): PipelineBoardEntry {
  return {
    id: `pen_${overrides.stageKey}_${overrides.prospectName ?? "x"}`,
    orgId: "org_1",
    prospectId: "prs_1",
    stageId: `stg_${overrides.stageKey}`,
    ownerUserId: null,
    valueCents: null,
    enteredStageAt: "2026-06-01T00:00:00.000Z",
    closedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    prospectName: "Business",
    prospectDomain: null,
    score: null,
    band: null,
    daysInStage: 0,
    ...overrides,
  };
}

function prospect(name: string, score: number | null, band: "hot" | "warm" | "cold" | null): PublicProspect {
  return {
    id: `prs_${name}`,
    orgId: "org_1",
    name,
    domain: null,
    industry: null,
    locality: null,
    region: null,
    country: null,
    sizeBand: "unknown",
    source: "synthetic",
    status: "active",
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastEnrichedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    currentScore:
      score === null || band === null
        ? null
        : {
            id: "scr_1",
            orgId: "org_1",
            prospectId: `prs_${name}`,
            score,
            band,
            rulesetVersion: 1,
            profileVersion: 0,
            contributions: [],
            signalIds: [],
            computedAt: "2026-06-01T00:00:00.000Z",
          },
  };
}

describe("bands", () => {
  it("gives hot the strongest treatment", () => {
    expect(bandVariant("hot")).toBe("destructive");
    expect(bandVariant("warm")).toBe("default");
    expect(bandVariant("cold")).toBe("secondary");
  });

  it("has a treatment for an unscored prospect", () => {
    expect(bandVariant(null)).toBe("outline");
    expect(bandLabel(null)).toBe("unscored");
  });
});

describe("score explainer", () => {
  it("scales bars against the largest contribution, not against 100", () => {
    // A well-balanced 45 must not render as a row of stubs.
    const bars = contributionBars([contribution("tls_missing", 25), contribution("perf_poor", 20)]);
    expect(bars[0]!.percent).toBe(100);
    expect(bars[1]!.percent).toBe(80);
  });

  it("carries the points and the reason through untouched", () => {
    const bars = contributionBars([contribution("tls_missing", 25, "No valid HTTPS")]);
    expect(bars[0]!.points).toBe(25);
    expect(bars[0]!.reason).toBe("No valid HTTPS");
    expect(bars[0]!.kind).toBe("tls_missing");
  });

  it("does not divide by zero on an all-zero score", () => {
    const bars = contributionBars([contribution("reviews_thin", 0)]);
    expect(bars[0]!.percent).toBe(0);
  });

  it("names the ruleset and the weight profile that produced the number", () => {
    expect(scoreProvenance(1, 0)).toBe("ruleset v1 · default weights");
    expect(scoreProvenance(1, 3)).toBe("ruleset v1 · weight profile v3");
  });
});

describe("quota state", () => {
  const error = {
    code: "quota_exhausted",
    message: "Your plan's monthly insight allowance is spent",
    details: {
      meter: "prospecting.insights.generated",
      entitlement: "prospecting.insight",
      limit: 10,
      used: 10,
      resetAt: "2026-07-01T00:00:00.000Z",
    },
  };

  it("recognises the typed 402 and pulls out everything the prompt needs", () => {
    const state = asQuotaState(error)!;
    expect(state.meter).toBe("prospecting.insights.generated");
    expect(state.limit).toBe(10);
    expect(state.used).toBe(10);
    expect(state.resetAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("renders the whole prompt from that payload alone — no second round trip", () => {
    const summary = quotaSummary(asQuotaState(error)!, (iso) => iso.slice(0, 10));
    expect(summary).toContain("used 10 of 10");
    expect(summary).toContain("2026-07-01");
  });

  it("ignores every other error code", () => {
    expect(asQuotaState({ code: "not_found", message: "Not found" })).toBeNull();
    expect(asQuotaState(null)).toBeNull();
  });

  it("degrades to the server message when details are missing", () => {
    const state = asQuotaState({ code: "quota_exhausted", message: "spent" })!;
    expect(state.limit).toBeNull();
    expect(quotaSummary(state)).toBe("spent");
  });

  it("says the plan does not include the capability when the limit is zero", () => {
    const state = asQuotaState({
      code: "quota_exhausted",
      message: "not included",
      details: { meter: "m", limit: 0, used: null, resetAt: null },
    })!;
    expect(quotaSummary(state)).toContain("not included in your current plan");
  });
});

describe("prospect filters", () => {
  it("omits empty filters from the query", () => {
    expect(buildProspectQuery(EMPTY_FILTERS)).toEqual({});
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it("passes set filters through", () => {
    const filters = { band: "hot" as const, signalKind: "tls_missing" as const, stageKey: "contacted" };
    expect(buildProspectQuery(filters)).toEqual({ band: "hot", signalKind: "tls_missing", stageKey: "contacted" });
    expect(hasActiveFilters(filters)).toBe(true);
  });
});

describe("discovery run summaries", () => {
  const base = { candidatesFound: 10, prospectsCreated: 6, prospectsUpdated: 4, signalsRecorded: 21, errorCode: null };

  it("treats completed, failed, and cancelled as terminal", () => {
    expect(isRunTerminal("running")).toBe(false);
    expect(isRunTerminal("completed")).toBe(true);
    expect(isRunTerminal("failed")).toBe(true);
    expect(isRunTerminal("cancelled")).toBe(true);
  });

  it("reports live progress while running", () => {
    expect(runSummary({ ...base, status: "running" })).toContain("6 created");
  });

  it("keeps the counters on a failed run — the prospects it produced are real", () => {
    const summary = runSummary({ ...base, status: "failed", errorCode: "adapter_error" });
    expect(summary).toContain("6 created");
    expect(summary).toContain("adapter_error");
  });

  it("reports the full tally on success", () => {
    const summary = runSummary({ ...base, status: "completed" });
    expect(summary).toContain("10 examined");
    expect(summary).toContain("21 signals");
    expect(summary).not.toContain("stopped");
  });
});

describe("pipeline board", () => {
  const stages = [stage("new", 1), stage("contacted", 2), stage("won", 3, "won")];

  it("gives every stage a column, including the empty ones", () => {
    // A kanban that hides empty columns cannot be dragged into.
    const board = buildBoard(stages, []);
    expect(board.map((c) => c.stage.key)).toEqual(["new", "contacted", "won"]);
    expect(board.every((c) => c.entries.length === 0)).toBe(true);
  });

  it("orders columns by stage position regardless of input order", () => {
    const board = buildBoard([stage("won", 3, "won"), stage("new", 1), stage("contacted", 2)], []);
    expect(board.map((c) => c.stage.key)).toEqual(["new", "contacted", "won"]);
  });

  it("sorts cards by score within a column", () => {
    const board = buildBoard(stages, [
      entry({ stageKey: "new", prospectName: "Low", score: 20 }),
      entry({ stageKey: "new", prospectName: "High", score: 82 }),
    ]);
    expect(board[0]!.entries.map((e) => e.prospectName)).toEqual(["High", "Low"]);
  });

  it("counts stuck cards per column", () => {
    const board = buildBoard(stages, [
      entry({ stageKey: "new", prospectName: "Stale", daysInStage: STUCK_DAYS }),
      entry({ stageKey: "new", prospectName: "Fresh", daysInStage: 1 }),
    ]);
    expect(board[0]!.stuckCount).toBe(1);
  });

  it("marks a card stuck exactly at the threshold, and never once it is closed", () => {
    expect(isStuck({ daysInStage: STUCK_DAYS - 1, closedAt: null })).toBe(false);
    expect(isStuck({ daysInStage: STUCK_DAYS, closedAt: null })).toBe(true);
    expect(isStuck({ daysInStage: 90, closedAt: "2026-06-01T00:00:00.000Z" })).toBe(false);
  });

  it("distinguishes terminal stages from steps", () => {
    expect(stageIsTerminal(stage("new", 1))).toBe(false);
    expect(stageIsTerminal(stage("won", 5, "won"))).toBe(true);
    expect(stageIsTerminal(stage("lost", 6, "lost"))).toBe(true);
  });
});

describe("guardrail presentation", () => {
  it("does not present a revised draft as an error — the edit is the feature", () => {
    expect(guardrailVariant("pass")).toBe("secondary");
    expect(guardrailVariant("revised")).toBe("outline");
  });

  it("explains what the verdict means in a sentence a rep can act on", () => {
    expect(guardrailExplanation("pass", 0)).toContain("every claim maps to an observed signal");
    expect(guardrailExplanation("revised", 1)).toContain("1 change");
    expect(guardrailExplanation("revised", 3)).toContain("3 changes");
  });
});

describe("prospect ordering", () => {
  it("puts the best opportunity above the fold", () => {
    const sorted = sortProspects([
      prospect("Cold", 20, "cold"),
      prospect("Unscored", null, null),
      prospect("HotLower", 72, "hot"),
      prospect("HotTop", 91, "hot"),
      prospect("Warm", 55, "warm"),
    ]);
    expect(sorted.map((p) => p.name)).toEqual(["HotTop", "HotLower", "Warm", "Cold", "Unscored"]);
  });

  it("does not mutate the input", () => {
    const input = [prospect("A", 10, "cold"), prospect("B", 90, "hot")];
    sortProspects(input);
    expect(input.map((p) => p.name)).toEqual(["A", "B"]);
  });
});
