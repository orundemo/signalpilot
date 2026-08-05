import type { SignalKind, SignalSeverity, SizeBand } from "@saas/contracts/prospecting";
import type { AdapterContext, Candidate, DiscoveryAdapter, NormalisedQuery, SignalDraft } from "./types.js";
import { sha256Hex } from "./types.js";

/**
 * A deterministic corpus of small businesses.
 *
 * This adapter powers the demo tenant and every test, so its output must be
 * *reproducible*: the same query always yields the same businesses with the
 * same weaknesses. That is what lets a scoring test assert an exact number,
 * and what lets the demo be re-seeded without the board changing under
 * whoever is clicking it.
 *
 * Determinism comes from hashing the query and the candidate index into a
 * small integer — no `Math.random()`, no clock. `ctx.now` is the only time
 * input and it is fixed for the whole run.
 */

const TRADES = [
  { industry: "bakery", names: ["Corner Bakery", "Rise & Crumb", "The Daily Loaf", "Flour & Salt", "Morning Proof"] },
  { industry: "dentistry", names: ["Bright Smile Dental", "Riverside Dental Care", "The Dental Studio", "Oak Street Dentists"] },
  { industry: "landscaping", names: ["Green Acre Landscapes", "Hedgerow Gardens", "Stone & Fern", "Meadow Grounds"] },
  { industry: "plumbing", names: ["Ridgeway Plumbing", "Copper & Co", "Tapworks", "Fenwick Heating"] },
  { industry: "fitness", names: ["Ironworks Gym", "Studio Nine Pilates", "The Strength Room", "Riverbank Fitness"] },
  { industry: "veterinary", names: ["Willow Vets", "Paws & Claws Clinic", "Hilltop Veterinary", "The Animal Practice"] },
  { industry: "hospitality", names: ["The Blue Anchor", "Number Twelve", "The Copper Kettle", "Larder & Vine"] },
  { industry: "retail", names: ["Bramble & Thread", "The Corner Shop", "Fig & Feather", "Stationery House"] },
];

const LOCALITIES = [
  { locality: "Leeds", region: "England", country: "GB" },
  { locality: "Bristol", region: "England", country: "GB" },
  { locality: "Glasgow", region: "Scotland", country: "GB" },
  { locality: "Cork", region: "Munster", country: "IE" },
  { locality: "Austin", region: "Texas", country: "US" },
  { locality: "Portland", region: "Oregon", country: "US" },
];

const SIZE_BANDS: SizeBand[] = ["micro", "micro", "small", "small", "medium"];

/**
 * The weakness profiles a synthetic business can have, ordered from
 * "practically unsellable" to "already in good shape". A realistic corpus is
 * mostly warm: if every generated business were `hot`, the demo would prove
 * nothing about the scoring engine.
 */
const PROFILES: ReadonlyArray<{ weight: number; signals: Array<[SignalKind, SignalSeverity]> }> = [
  // No website at all — the strongest possible pitch.
  { weight: 1, signals: [["site_missing", 5], ["reviews_thin", 3]] },
  // Old site, no HTTPS, unusable on a phone.
  { weight: 2, signals: [["tls_missing", 5], ["mobile_unfriendly", 4], ["content_stale", 4], ["booking_absent", 3]] },
  // Modern-ish but slow and no way to book.
  { weight: 3, signals: [["perf_poor", 4], ["booking_absent", 4], ["analytics_absent", 3]] },
  // Fine site, no measurement, thin social proof.
  { weight: 4, signals: [["analytics_absent", 3], ["reviews_thin", 2], ["content_stale", 2]] },
  // Nearly nothing to sell them.
  { weight: 3, signals: [["analytics_absent", 2]] },
];

const PROFILE_LOTTERY: number[] = PROFILES.flatMap((p, i) => Array.from({ length: p.weight }, () => i));

const REASONS: Record<SignalKind, (severity: number) => Record<string, string | number | boolean>> = {
  site_missing: () => ({ resolved: false }),
  tls_missing: () => ({ scheme: "http", certificate: "absent" }),
  perf_poor: (s) => ({ lcp_ms: 3200 + s * 800, bucket: s >= 4 ? "poor" : "needs-improvement" }),
  mobile_unfriendly: () => ({ viewport_meta: false, layout: "fixed-width" }),
  booking_absent: () => ({ booking_form: false, contact_form: false }),
  analytics_absent: () => ({ analytics_tag: false, tag_manager: false }),
  content_stale: (s) => ({ months_since_change: 8 + s * 6 }),
  reviews_thin: (s) => ({ review_count: Math.max(0, 12 - s * 3), industry_floor: 25 }),
};

/** FNV-1a. Small, fast, and stable across runtimes — the point is repeatability. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: number): T {
  // `seed` arrives from an unsigned hash, but a shifted value can exceed the
  // signed-32-bit range and come back negative — which would index off the
  // front of the array. Normalise before the modulo.
  return items[Math.abs(seed) % items.length]!;
}

export function createSyntheticAdapter(): DiscoveryAdapter {
  return {
    id: "synthetic",
    requiresConnection: false,

    async *search(query: NormalisedQuery): AsyncIterable<Candidate> {
      const querySeed = hash(
        [query.location ?? "", query.industry ?? "", query.sizeBand ?? "", query.limit].join("|"),
      );

      const trades = query.industry
        ? TRADES.filter((t) => t.industry.includes(query.industry!.toLowerCase())) || TRADES
        : TRADES;
      const pool = trades.length > 0 ? trades : TRADES;

      const localities = query.location
        ? LOCALITIES.filter((l) => l.locality.toLowerCase() === query.location!.trim().toLowerCase())
        : LOCALITIES;
      const places = localities.length > 0 ? localities : LOCALITIES;

      for (let i = 0; i < query.limit; i++) {
        const seed = hash(`${querySeed}:${i}`);
        const trade = pick(pool, seed);
        const place = pick(places, seed >>> 3);
        const baseName = pick(trade.names, seed >>> 6);
        // Suffix keeps names unique across a run without a random component.
        const name = `${baseName} ${String.fromCharCode(65 + (seed % 26))}${((seed >>> 11) % 90) + 10}`;
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const profileIndex = PROFILE_LOTTERY[seed % PROFILE_LOTTERY.length]!;
        const hasSite = PROFILES[profileIndex]!.signals[0]![0] !== "site_missing";

        yield {
          name,
          domain: hasSite ? `${slug}.example` : null,
          industry: trade.industry,
          locality: place.locality,
          region: place.region,
          country: place.country,
          sizeBand: query.sizeBand ?? pick(SIZE_BANDS, seed >>> 9),
          sourceRef: `syn:${seed.toString(16)}`,
        };
      }
    },

    async observe(candidate: Candidate, ctx: AdapterContext): Promise<SignalDraft[]> {
      const seed = hash(candidate.sourceRef ?? candidate.name);
      const profile = PROFILES[PROFILE_LOTTERY[seed % PROFILE_LOTTERY.length]!]!;

      // One digest per candidate: the "document" this corpus derived from is
      // the corpus entry itself, and it is reproducible from the seed.
      const digest = await sha256Hex(`synthetic:v1:${candidate.sourceRef ?? candidate.name}`);

      return profile.signals.map(([kind, severity]) => ({
        kind,
        severity,
        features: {
          ...REASONS[kind](severity),
          observed_by: "synthetic",
          observed_on: ctx.now.toISOString().slice(0, 10),
        },
        sourceDigest: digest,
        expiresInDays: 30,
      }));
    },
  };
}
