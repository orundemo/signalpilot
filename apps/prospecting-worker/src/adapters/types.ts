import type { SignalFeatures, SignalKind, SignalSeverity, SizeBand } from "@saas/contracts/prospecting";

/** A candidate business, as an adapter reports it. Business records only. */
export interface Candidate {
  name: string;
  domain: string | null;
  industry: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  sizeBand: SizeBand;
  /** Adapter-local identifier, for a later re-fetch. Never a credential. */
  sourceRef: string | null;
}

/**
 * An observation, ready to persist.
 *
 * There is deliberately no field here that could carry a fetched document.
 * The drop happens *inside* the adapter, which is where the fetch happened —
 * so a payload never crosses this boundary and there is no later stage that
 * has to remember to discard it.
 */
export interface SignalDraft {
  kind: SignalKind;
  severity: SignalSeverity;
  features: SignalFeatures;
  /** sha256 of the document the observation was derived from. */
  sourceDigest: string;
  /** Staleness horizon in days; the caller turns this into `expires_at`. */
  expiresInDays: number;
}

/** The normalised discovery query. Adapters receive this, never a raw request. */
export interface NormalisedQuery {
  location: string | null;
  industry: string | null;
  sizeBand: SizeBand | null;
  domains: string[];
  limit: number;
}

export interface AdapterContext {
  /** Correlates adapter work with the request that started it. */
  requestId: string;
  /** Fixed for the whole run so a run is reproducible from its own clock. */
  now: Date;
  /**
   * Aborts in-flight network work when the run is cancelled or the Worker is
   * shutting down. Adapters that fetch must pass this to `fetch`.
   */
  signal?: AbortSignal;
}

export interface DiscoveryAdapter {
  readonly id: string;
  /**
   * True when the adapter needs a per-tenant credential brokered through
   * `integrations-worker`. Both v1 adapters are false; the flag exists from
   * day one so landing a credentialed provider is additive rather than an
   * interface change.
   */
  readonly requiresConnection: boolean;
  search(query: NormalisedQuery, ctx: AdapterContext): AsyncIterable<Candidate>;
  observe(candidate: Candidate, ctx: AdapterContext): Promise<SignalDraft[]>;
}

/** sha256 hex of a string — the provenance digest, computed once per document. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}
