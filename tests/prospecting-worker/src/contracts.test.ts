import {
  DEFAULT_SIGNAL_WEIGHTS,
  PROSPECTING_RULESET_VERSION,
  SIGNAL_KINDS,
  bandForScore,
  isDiscoveryAdapterId,
  isInsightKind,
  isScoreBand,
  isSignalFeatures,
  isSignalKind,
  isSignalSeverity,
  isSizeBand,
  isSourceDigest,
  isStageKey,
  isStageOutcome,
  resolveWeights,
  validateWeights,
} from "@saas/contracts/prospecting";

const DIGEST = "a".repeat(64);

describe("signal catalog", () => {
  it("prices every catalog kind in ruleset v1", () => {
    for (const kind of SIGNAL_KINDS) {
      expect(typeof DEFAULT_SIGNAL_WEIGHTS[kind]).toBe("number");
      expect(DEFAULT_SIGNAL_WEIGHTS[kind]).toBeGreaterThan(0);
    }
  });

  it("declares a ruleset version", () => {
    expect(PROSPECTING_RULESET_VERSION).toBe(1);
  });

  it("rejects an unknown signal kind", () => {
    expect(isSignalKind("tls_missing")).toBe(true);
    expect(isSignalKind("vibes_bad")).toBe(false);
    expect(isSignalKind(42)).toBe(false);
  });
});

describe("never-store-raw invariants", () => {
  it("accepts a flat map of scalars as features", () => {
    expect(isSignalFeatures({ lcp_ms: 6400, bucket: "poor", https: false, note: null })).toBe(true);
  });

  it("rejects a nested object — that is how a raw payload would sneak in", () => {
    expect(isSignalFeatures({ response: { body: "<html>…</html>" } })).toBe(false);
  });

  it("rejects an array value", () => {
    expect(isSignalFeatures({ headers: ["content-type: text/html"] })).toBe(false);
  });

  it("rejects an over-long string value", () => {
    expect(isSignalFeatures({ html: "x".repeat(257) })).toBe(false);
  });

  it("rejects a top-level array", () => {
    expect(isSignalFeatures([1, 2, 3])).toBe(false);
  });

  it("only accepts a 64-char lowercase hex source digest", () => {
    expect(isSourceDigest(DIGEST)).toBe(true);
    expect(isSourceDigest(DIGEST.toUpperCase())).toBe(false);
    expect(isSourceDigest("a".repeat(63))).toBe(false);
    expect(isSourceDigest("<html>")).toBe(false);
  });
});

describe("enum guards", () => {
  it("validates size bands", () => {
    expect(isSizeBand("micro")).toBe(true);
    expect(isSizeBand("gigantic")).toBe(false);
  });

  it("validates score bands", () => {
    expect(isScoreBand("hot")).toBe(true);
    expect(isScoreBand("lukewarm")).toBe(false);
  });

  it("validates insight kinds", () => {
    expect(isInsightKind("outreach_email")).toBe(true);
    expect(isInsightKind("cold_call_script")).toBe(false);
  });

  it("validates adapter ids", () => {
    expect(isDiscoveryAdapterId("synthetic")).toBe(true);
    expect(isDiscoveryAdapterId("web-signals")).toBe(true);
    expect(isDiscoveryAdapterId("scrape-everything")).toBe(false);
  });

  it("validates severities as 1–5 integers", () => {
    expect(isSignalSeverity(1)).toBe(true);
    expect(isSignalSeverity(5)).toBe(true);
    expect(isSignalSeverity(0)).toBe(false);
    expect(isSignalSeverity(6)).toBe(false);
    expect(isSignalSeverity("3")).toBe(false);
  });

  it("validates stage keys and outcomes", () => {
    expect(isStageKey("contacted")).toBe(true);
    expect(isStageKey("follow-up_2")).toBe(true);
    expect(isStageKey("-bad")).toBe(false);
    expect(isStageKey("")).toBe(false);
    expect(isStageOutcome("won")).toBe(true);
    expect(isStageOutcome("pending")).toBe(false);
  });
});

describe("band thresholds", () => {
  it("puts the boundaries at 39/40 and 69/70", () => {
    expect(bandForScore(39)).toBe("cold");
    expect(bandForScore(40)).toBe("warm");
    expect(bandForScore(69)).toBe("warm");
    expect(bandForScore(70)).toBe("hot");
  });

  it("maps the extremes", () => {
    expect(bandForScore(0)).toBe("cold");
    expect(bandForScore(100)).toBe("hot");
  });
});

describe("weight resolution", () => {
  it("falls back to the ruleset defaults with no overrides", () => {
    expect(resolveWeights(null)).toEqual(DEFAULT_SIGNAL_WEIGHTS);
    expect(resolveWeights(undefined)).toEqual(DEFAULT_SIGNAL_WEIGHTS);
    expect(resolveWeights({})).toEqual(DEFAULT_SIGNAL_WEIGHTS);
  });

  it("applies a sparse override without disturbing the rest", () => {
    const resolved = resolveWeights({ tls_missing: 40 });
    expect(resolved.tls_missing).toBe(40);
    expect(resolved.perf_poor).toBe(DEFAULT_SIGNAL_WEIGHTS.perf_poor);
  });

  it("clamps an out-of-range override rather than trusting it", () => {
    expect(resolveWeights({ tls_missing: 5000 }).tls_missing).toBe(100);
    expect(resolveWeights({ tls_missing: -10 }).tls_missing).toBe(0);
  });

  it("does not mutate the shared defaults", () => {
    resolveWeights({ tls_missing: 1 });
    expect(DEFAULT_SIGNAL_WEIGHTS.tls_missing).toBe(25);
  });
});

describe("weight validation", () => {
  it("accepts a valid override map", () => {
    const result = validateWeights({ tls_missing: 30, perf_poor: 10 });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.weights).toEqual({ tls_missing: 30, perf_poor: 10 });
  });

  it("rejects an unknown signal kind by name", () => {
    const result = validateWeights({ vibes_bad: 10 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.fields["weights.vibes_bad"]).toEqual(["Unknown signal kind"]);
  });

  it("rejects a non-numeric or out-of-range weight", () => {
    expect(validateWeights({ tls_missing: "30" }).valid).toBe(false);
    expect(validateWeights({ tls_missing: 101 }).valid).toBe(false);
    expect(validateWeights({ tls_missing: -1 }).valid).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateWeights(null).valid).toBe(false);
    expect(validateWeights([]).valid).toBe(false);
    expect(validateWeights("weights").valid).toBe(false);
  });
});
