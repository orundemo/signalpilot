import { reasonFor, scoreProspect, severityFactor } from "@prospecting-worker/engine/scoring";
import type { ScorableSignal } from "@prospecting-worker/engine/scoring";
import { DEFAULT_SIGNAL_WEIGHTS, PROSPECTING_RULESET_VERSION } from "@saas/contracts/prospecting";
import type { SignalKind } from "@saas/contracts/prospecting";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const OPTIONS = { now: NOW };

let seq = 0;
function signal(overrides: Partial<ScorableSignal> & { kind: string }): ScorableSignal {
  seq += 1;
  return {
    id: `sig-${String(seq).padStart(4, "0")}`,
    severity: 5,
    features: {},
    observedAt: new Date("2026-05-01T00:00:00.000Z"),
    expiresAt: null,
    ...overrides,
  };
}

describe("severityFactor", () => {
  it("maps 1–5 onto 0.4–1.0", () => {
    expect(severityFactor(1)).toBeCloseTo(0.4);
    expect(severityFactor(3)).toBeCloseTo(0.7);
    expect(severityFactor(5)).toBeCloseTo(1.0);
  });

  it("clamps out-of-range severities rather than trusting them", () => {
    expect(severityFactor(0)).toBeCloseTo(0.4);
    expect(severityFactor(-3)).toBeCloseTo(0.4);
    expect(severityFactor(99)).toBeCloseTo(1.0);
  });

  it("never zeroes a signal — a low-confidence weakness is still a weakness", () => {
    expect(severityFactor(1)).toBeGreaterThan(0);
  });
});

describe("scoreProspect — the arithmetic", () => {
  it("prices a single signal at weight × severity factor", () => {
    const result = scoreProspect([signal({ kind: "tls_missing", severity: 5 })], null, OPTIONS);
    expect(result.score).toBe(DEFAULT_SIGNAL_WEIGHTS.tls_missing);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]!.points).toBe(25);
  });

  it("halves nothing — severity 3 on a 20-point rule is 14", () => {
    const result = scoreProspect([signal({ kind: "perf_poor", severity: 3 })], null, OPTIONS);
    expect(result.score).toBe(14);
  });

  it("sums across kinds and caps at 100", () => {
    const all = (Object.keys(DEFAULT_SIGNAL_WEIGHTS) as SignalKind[]).map((kind) =>
      signal({ kind, severity: 5 }),
    );
    const result = scoreProspect(all, null, OPTIONS);
    expect(result.score).toBe(100);
    expect(result.band).toBe("hot");
  });

  it("scores an empty signal set as a cold zero rather than throwing", () => {
    const result = scoreProspect([], null, OPTIONS);
    expect(result.score).toBe(0);
    expect(result.band).toBe("cold");
    expect(result.contributions).toEqual([]);
    expect(result.signalIds).toEqual([]);
  });
});

describe("scoreProspect — band boundaries", () => {
  // 39/40 and 69/70 are the exact edges the design names.
  it.each([
    [39, "cold"],
    [40, "warm"],
    [69, "warm"],
    [70, "hot"],
  ])("scores %i as %s", (target, band) => {
    // Construct the target exactly with a synthetic weight override.
    const result = scoreProspect(
      [signal({ kind: "tls_missing", severity: 5 })],
      { version: 1, weights: { tls_missing: target } },
      OPTIONS,
    );
    expect(result.score).toBe(target);
    expect(result.band).toBe(band);
  });
});

describe("scoreProspect — expiry", () => {
  it("drops a signal past its staleness horizon", () => {
    const result = scoreProspect(
      [signal({ kind: "tls_missing", expiresAt: new Date("2026-05-15T00:00:00.000Z") })],
      null,
      OPTIONS,
    );
    expect(result.score).toBe(0);
    expect(result.contributions).toEqual([]);
  });

  it("keeps a signal whose horizon is still in the future", () => {
    const result = scoreProspect(
      [signal({ kind: "tls_missing", expiresAt: new Date("2026-07-01T00:00:00.000Z") })],
      null,
      OPTIONS,
    );
    expect(result.score).toBe(25);
  });

  it("treats expiry exactly at `now` as expired", () => {
    const result = scoreProspect([signal({ kind: "tls_missing", expiresAt: NOW })], null, OPTIONS);
    expect(result.score).toBe(0);
  });

  it("keeps a signal with no horizon at all", () => {
    const result = scoreProspect([signal({ kind: "tls_missing", expiresAt: null })], null, OPTIONS);
    expect(result.score).toBe(25);
  });
});

describe("scoreProspect — most recent signal per kind", () => {
  it("counts only the newest observation of a kind", () => {
    const result = scoreProspect(
      [
        signal({ kind: "perf_poor", severity: 5, observedAt: new Date("2026-01-01T00:00:00.000Z") }),
        signal({ kind: "perf_poor", severity: 1, observedAt: new Date("2026-05-01T00:00:00.000Z") }),
      ],
      null,
      OPTIONS,
    );
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]!.severity).toBe(1);
    expect(result.score).toBe(8); // 20 × 0.4
  });

  it("does not care what order the signals arrive in", () => {
    const older = signal({ kind: "perf_poor", severity: 5, observedAt: new Date("2026-01-01T00:00:00.000Z") });
    const newer = signal({ kind: "perf_poor", severity: 1, observedAt: new Date("2026-05-01T00:00:00.000Z") });
    expect(scoreProspect([older, newer], null, OPTIONS).score).toBe(
      scoreProspect([newer, older], null, OPTIONS).score,
    );
  });

  it("breaks an exact timestamp tie deterministically, not by insertion order", () => {
    const at = new Date("2026-05-01T00:00:00.000Z");
    const a: ScorableSignal = { id: "sig-aaaa", kind: "perf_poor", severity: 1, features: {}, observedAt: at, expiresAt: null };
    const b: ScorableSignal = { id: "sig-bbbb", kind: "perf_poor", severity: 5, features: {}, observedAt: at, expiresAt: null };
    expect(scoreProspect([a, b], null, OPTIONS)).toEqual(scoreProspect([b, a], null, OPTIONS));
  });
});

describe("scoreProspect — weight profiles", () => {
  it("applies a per-org override", () => {
    const signals = [signal({ kind: "tls_missing", severity: 5 })];
    expect(scoreProspect(signals, { version: 3, weights: { tls_missing: 40 } }, OPTIONS).score).toBe(40);
  });

  it("leaves untouched kinds on the ruleset defaults", () => {
    const result = scoreProspect(
      [signal({ kind: "tls_missing", severity: 5 }), signal({ kind: "perf_poor", severity: 5 })],
      { version: 3, weights: { tls_missing: 40 } },
      OPTIONS,
    );
    expect(result.score).toBe(40 + DEFAULT_SIGNAL_WEIGHTS.perf_poor);
  });

  it("records the profile version that produced the score", () => {
    expect(scoreProspect([], { version: 7, weights: {} }, OPTIONS).profileVersion).toBe(7);
    // Version 0 means "no org profile — the code ruleset defaults".
    expect(scoreProspect([], null, OPTIONS).profileVersion).toBe(0);
  });

  it("records the ruleset version the code implements", () => {
    expect(scoreProspect([], null, OPTIONS).rulesetVersion).toBe(PROSPECTING_RULESET_VERSION);
  });

  it("lets an org zero a rule out entirely", () => {
    const result = scoreProspect(
      [signal({ kind: "reviews_thin", severity: 5 })],
      { version: 2, weights: { reviews_thin: 0 } },
      OPTIONS,
    );
    expect(result.score).toBe(0);
    // The contribution is still listed, at zero — the explainer shows that the
    // signal was seen and priced at nothing, not that it was missing.
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]!.points).toBe(0);
  });
});

describe("scoreProspect — determinism", () => {
  it("produces byte-identical contributions for the same corpus scored twice", () => {
    const corpus = [
      signal({ kind: "tls_missing", severity: 5 }),
      signal({ kind: "perf_poor", severity: 4, features: { lcp_ms: 6400, bucket: "poor" } }),
      signal({ kind: "booking_absent", severity: 4 }),
      signal({ kind: "content_stale", severity: 3, features: { months_since_change: 14 } }),
      signal({ kind: "reviews_thin", severity: 2, features: { review_count: 9, industry_floor: 25 } }),
    ];
    const first = scoreProspect(corpus, null, OPTIONS);
    const second = scoreProspect(corpus, null, OPTIONS);
    expect(JSON.stringify(first.contributions)).toBe(JSON.stringify(second.contributions));
    expect(first.score).toBe(second.score);
  });

  it("orders contributions highest-points-first so the explainer reads top-down", () => {
    const result = scoreProspect(
      [
        signal({ kind: "reviews_thin", severity: 5 }),
        signal({ kind: "site_missing", severity: 5 }),
        signal({ kind: "analytics_absent", severity: 5 }),
      ],
      null,
      OPTIONS,
    );
    const points = result.contributions.map((c) => c.points);
    expect(points).toEqual([...points].sort((a, b) => b - a));
    expect(result.contributions[0]!.kind).toBe("site_missing");
  });

  it("has no clock, network, or database dependency — the same call outside any time freeze agrees", () => {
    const corpus = [signal({ kind: "tls_missing", severity: 5 })];
    expect(scoreProspect(corpus, null, { now: new Date("2030-01-01T00:00:00Z") }).score).toBe(
      scoreProspect(corpus, null, OPTIONS).score,
    );
  });
});

describe("scoreProspect — attribution", () => {
  it("names the signal behind every point", () => {
    const tls = signal({ kind: "tls_missing", severity: 5 });
    const perf = signal({ kind: "perf_poor", severity: 4, features: { lcp_ms: 6400 } });
    const result = scoreProspect([tls, perf], null, OPTIONS);

    expect(result.signalIds.sort()).toEqual([tls.id, perf.id].sort());
    for (const contribution of result.contributions) {
      expect([tls.id, perf.id]).toContain(contribution.signalId);
      expect(contribution.reason.length).toBeGreaterThan(0);
    }
  });

  it("carries the features that produced each contribution", () => {
    const result = scoreProspect(
      [signal({ kind: "perf_poor", severity: 4, features: { lcp_ms: 6400, bucket: "poor" } })],
      null,
      OPTIONS,
    );
    expect(result.contributions[0]!.features).toEqual({ lcp_ms: 6400, bucket: "poor" });
  });

  it("ignores a kind this ruleset version does not price rather than scoring it at a default", () => {
    const result = scoreProspect(
      [signal({ kind: "future_signal_from_v2" }), signal({ kind: "tls_missing", severity: 5 })],
      null,
      OPTIONS,
    );
    expect(result.score).toBe(25);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions.map((c) => c.kind)).not.toContain("future_signal_from_v2");
  });
});

describe("reasonFor", () => {
  it("renders a sentence a salesperson could paste into an email", () => {
    expect(reasonFor("perf_poor", { lcp_ms: 6400 })).toBe("Page loads in 6.4s — slow enough to lose visitors");
    expect(reasonFor("reviews_thin", { review_count: 9, industry_floor: 25 })).toBe(
      "Only 9 public reviews against an industry floor of 25",
    );
    expect(reasonFor("content_stale", { months_since_change: 14 })).toBe("Content last changed about 14 months ago");
  });

  it("degrades to a generic sentence when the feature is absent, never to a number it invented", () => {
    expect(reasonFor("perf_poor", {})).toBe("Page load is slow");
    expect(reasonFor("reviews_thin", {})).toBe("Thin public review presence");
    expect(reasonFor("content_stale", {})).toBe("Content has not changed in over a year");
  });

  it("distinguishes 'no booking flow' from 'no way to reach them at all'", () => {
    expect(reasonFor("booking_absent", { contact_form: true })).toContain("no way to book");
    expect(reasonFor("booking_absent", { contact_form: false })).toContain("No booking, scheduling, or contact route");
  });

  it("has a reason for every catalog kind", () => {
    for (const kind of Object.keys(DEFAULT_SIGNAL_WEIGHTS) as SignalKind[]) {
      expect(reasonFor(kind, {}).length).toBeGreaterThan(0);
    }
  });
});
