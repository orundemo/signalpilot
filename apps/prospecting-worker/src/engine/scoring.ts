import type {
  ScoreBand,
  ScoreContribution,
  SignalFeatures,
  SignalKind,
  SignalSeverity,
} from "@saas/contracts/prospecting";
import {
  DEFAULT_SIGNAL_WEIGHTS,
  PROSPECTING_RULESET_VERSION,
  bandForScore,
  isSignalKind,
  resolveWeights,
} from "@saas/contracts/prospecting";

/**
 * The scoring engine. Pure: no clock, no randomness, no network, no database.
 *
 * This is the one piece of real domain IP in the product, and its value is
 * entirely in a property that is easy to lose: **the same signals and the same
 * profile always produce the same score, and every point is attributable to a
 * named observation.**
 *
 * A prospecting tool that returns a list of businesses with a mystery number
 * attached is indistinguishable from a spreadsheet. One that says
 * *"82 — no HTTPS (25), LCP 6.4s (20), no booking flow (20), last content
 * change 14 months ago (12), 9 reviews (5)"* is a different product, and the
 * difference lives here.
 *
 * Everything this function needs is passed in. That is not stylistic: the
 * moment scoring reads a clock or a database, "the engine decided, not the
 * rep" stops being auditable and the console's explainer becomes a story
 * rather than a derivation.
 */

/** The subset of a signal row the engine is allowed to see. */
export interface ScorableSignal {
  id: string;
  kind: string;
  severity: number;
  features: SignalFeatures;
  observedAt: Date;
  expiresAt: Date | null;
}

export interface ScoringProfileInput {
  version: number;
  weights: Partial<Record<SignalKind, number>>;
}

export interface ScoreResult {
  score: number;
  band: ScoreBand;
  rulesetVersion: number;
  profileVersion: number;
  contributions: ScoreContribution[];
  signalIds: string[];
}

/**
 * Severity 1–5 mapped onto a 0.4–1.0 multiplier.
 *
 * The floor is 0.4, not 0: an adapter that reports a weakness at low
 * confidence has still found something, and zeroing it would make the signal
 * indistinguishable from an absent one — which the console would then have to
 * explain twice.
 */
export function severityFactor(severity: number): number {
  const clamped = Math.min(5, Math.max(1, Math.round(severity)));
  return 0.4 + ((clamped - 1) / 4) * 0.6;
}

/** The human sentence that appears next to each bar in the score explainer. */
export function reasonFor(kind: SignalKind, features: SignalFeatures): string {
  const num = (key: string): number | null => {
    const value = features[key];
    return typeof value === "number" ? value : null;
  };

  switch (kind) {
    case "site_missing":
      return "No working website found";
    case "tls_missing":
      return "No valid HTTPS — visitors see a browser security warning";
    case "perf_poor": {
      const ms = num("lcp_ms") ?? num("load_ms");
      return ms === null
        ? "Page load is slow"
        : `Page loads in ${(ms / 1000).toFixed(1)}s — slow enough to lose visitors`;
    }
    case "mobile_unfriendly":
      return "No mobile viewport — the site is unusable on a phone";
    case "booking_absent":
      return features.contact_form === true
        ? "A contact form exists, but there is no way to book or schedule"
        : "No booking, scheduling, or contact route on the site";
    case "analytics_absent":
      return "No analytics installed — they cannot see what their site is doing";
    case "content_stale": {
      const months = num("months_since_change");
      return months === null
        ? "Content has not changed in over a year"
        : `Content last changed about ${Math.round(months)} months ago`;
    }
    case "reviews_thin": {
      const count = num("review_count");
      const floor = num("industry_floor");
      if (count === null) return "Thin public review presence";
      return floor === null
        ? `Only ${count} public reviews`
        : `Only ${count} public reviews against an industry floor of ${floor}`;
    }
  }
}

export interface ScoreOptions {
  /**
   * Reference time for expiry filtering. Passed in rather than read, so a
   * rescore of a historical corpus is reproducible.
   */
  now: Date;
}

/**
 * `(signals, profile) => ScoreResult`.
 *
 * 1. drop signals past `expires_at`
 * 2. for each remaining kind, take the most recent signal
 * 3. `points = weight(kind) × severityFactor(severity)`
 * 4. `raw = Σ points`, `score = min(100, round(raw))`
 * 5. band at ≥70 / ≥40
 * 6. one `contributions` entry per counted signal, ordered by points desc
 *
 * Unknown kinds are ignored rather than scored at a default weight: a signal
 * this ruleset version does not price must not silently move a number the
 * console then cannot explain.
 */
export function scoreProspect(
  signals: ScorableSignal[],
  profile: ScoringProfileInput | null,
  options: ScoreOptions,
): ScoreResult {
  const weights = resolveWeights(profile?.weights ?? null);

  // 1 + 2: expiry-filtered, most recent per kind. The repository already does
  // this in SQL for the hot path; doing it here too keeps the engine correct
  // in isolation, which is what makes it unit-testable without a database.
  const newestPerKind = new Map<SignalKind, ScorableSignal>();
  for (const signal of signals) {
    if (!isSignalKind(signal.kind)) continue;
    if (signal.expiresAt && signal.expiresAt.getTime() <= options.now.getTime()) continue;
    const current = newestPerKind.get(signal.kind);
    if (
      !current ||
      signal.observedAt.getTime() > current.observedAt.getTime() ||
      // Deterministic tie-break: two signals at the same instant must not
      // resolve by Map insertion order, or the same corpus could score twice.
      (signal.observedAt.getTime() === current.observedAt.getTime() && signal.id > current.id)
    ) {
      newestPerKind.set(signal.kind, signal);
    }
  }

  // 3: price each counted signal.
  const contributions: ScoreContribution[] = [];
  let raw = 0;
  for (const [kind, signal] of newestPerKind) {
    const weight = weights[kind] ?? DEFAULT_SIGNAL_WEIGHTS[kind];
    const points = Math.round(weight * severityFactor(signal.severity) * 100) / 100;
    raw += points;
    contributions.push({
      kind,
      points,
      reason: reasonFor(kind, signal.features),
      severity: Math.min(5, Math.max(1, Math.round(signal.severity))) as SignalSeverity,
      features: signal.features,
      signalId: signal.id,
    });
  }

  // Highest contribution first — the explainer reads top-down, and a stable
  // secondary sort on kind keeps two equal-point rows from swapping between
  // runs.
  contributions.sort((a, b) => (b.points - a.points) || a.kind.localeCompare(b.kind));

  const score = Math.min(100, Math.round(raw));

  return {
    score,
    band: bandForScore(score),
    rulesetVersion: PROSPECTING_RULESET_VERSION,
    profileVersion: profile?.version ?? 0,
    contributions,
    signalIds: contributions.map((c) => c.signalId),
  };
}
