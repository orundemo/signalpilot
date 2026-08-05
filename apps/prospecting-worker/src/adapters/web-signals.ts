import type { SignalKind, SignalSeverity } from "@saas/contracts/prospecting";
import type { AdapterContext, Candidate, DiscoveryAdapter, NormalisedQuery, SignalDraft } from "./types.js";
import { sha256Hex } from "./types.js";
import { normaliseDomain } from "../engine/dedupe.js";

/**
 * Derives observations from a single bounded fetch per candidate domain.
 *
 * Three rules govern this adapter, and all three exist because the alternative
 * is a product that is either untrustworthy or a liability:
 *
 * 1. **One request per candidate, capped and timed out.** This is not a
 *    crawler. It fetches the document at the apex and nothing else — no link
 *    following, no asset fetching, no sitemap walk.
 * 2. **A fetch failure is a *missing* signal, never a fabricated one.** If the
 *    request times out we record nothing about performance. Recording
 *    `perf_poor` because we could not measure it would put a number on the
 *    board that no one can defend, which is the exact failure this product
 *    exists to avoid.
 * 3. **The document is dropped in this function.** Only derived scalars and
 *    the sha256 of the body leave here. Nothing downstream has to remember to
 *    discard anything, because nothing downstream ever sees it.
 */

const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 512 * 1024;
const USER_AGENT = "signalpilot-prospecting/1.0 (+https://signalpilot.orun.new/bots)";

/** LCP-proxy buckets, in ms of time-to-first-byte-plus-body. */
const PERF_POOR_MS = 2500;
const PERF_BAD_MS = 4000;

const STALE_MONTHS = 12;

interface Observation {
  kind: SignalKind;
  severity: SignalSeverity;
  features: Record<string, string | number | boolean | null>;
}

/** Read at most `MAX_BODY_BYTES` — a huge page must not become a memory event. */
async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      chunks.push(value.slice(0, value.byteLength - (total - MAX_BODY_BYTES)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

/**
 * Everything derived from the document happens here, over a string that is
 * discarded when this function returns.
 */
function derive(
  html: string,
  meta: { scheme: string; elapsedMs: number; lastModified: string | null; truncated: boolean },
  now: Date,
): Observation[] {
  const observations: Observation[] = [];
  const lower = html.toLowerCase();

  if (meta.scheme !== "https") {
    observations.push({
      kind: "tls_missing",
      severity: 5,
      features: { scheme: meta.scheme, certificate: "absent" },
    });
  }

  const bucket = meta.elapsedMs >= PERF_BAD_MS ? "poor" : meta.elapsedMs >= PERF_POOR_MS ? "needs-improvement" : "good";
  if (bucket !== "good") {
    observations.push({
      kind: "perf_poor",
      severity: bucket === "poor" ? 4 : 2,
      features: { load_ms: Math.round(meta.elapsedMs), bucket, body_truncated: meta.truncated },
    });
  }

  const hasViewport = /<meta[^>]+name=["']?viewport/i.test(html);
  if (!hasViewport) {
    observations.push({
      kind: "mobile_unfriendly",
      severity: 4,
      features: { viewport_meta: false, layout: "fixed-width" },
    });
  }

  const BOOKING_MARKERS = ["book now", "book online", "calendly", "acuityscheduling", "squareup.com/appointments", "opentable", "resdiary", "setmore", "simplybook"];
  const FORM_MARKERS = ["<form", "mailto:", "type=\"email\"", "type='email'"];
  const hasBooking = BOOKING_MARKERS.some((m) => lower.includes(m));
  const hasForm = FORM_MARKERS.some((m) => lower.includes(m));
  if (!hasBooking && !hasForm) {
    observations.push({
      kind: "booking_absent",
      severity: 4,
      features: { booking_flow: false, contact_form: false },
    });
  } else if (!hasBooking) {
    observations.push({
      kind: "booking_absent",
      severity: 2,
      features: { booking_flow: false, contact_form: true },
    });
  }

  const ANALYTICS_MARKERS = ["googletagmanager.com", "google-analytics.com", "gtag(", "plausible.io", "matomo", "fathom", "segment.com", "posthog"];
  if (!ANALYTICS_MARKERS.some((m) => lower.includes(m))) {
    observations.push({
      kind: "analytics_absent",
      severity: 3,
      features: { analytics_tag: false, tag_manager: false },
    });
  }

  if (meta.lastModified) {
    const modified = new Date(meta.lastModified);
    if (!Number.isNaN(modified.getTime())) {
      const months = (now.getTime() - modified.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      if (months >= STALE_MONTHS) {
        observations.push({
          kind: "content_stale",
          severity: months >= 24 ? 5 : 3,
          features: { months_since_change: Math.round(months) },
        });
      }
    }
  }

  return observations;
}

export function createWebSignalsAdapter(fetchImpl: typeof fetch = fetch): DiscoveryAdapter {
  return {
    id: "web-signals",
    requiresConnection: false,

    /**
     * This adapter does not *find* businesses — it observes ones you already
     * named. `query.domains` is its input; a run with no domains yields
     * nothing rather than inventing candidates.
     */
    async *search(query: NormalisedQuery): AsyncIterable<Candidate> {
      const seen = new Set<string>();
      for (const raw of query.domains.slice(0, query.limit)) {
        const domain = normaliseDomain(raw);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        yield {
          name: domain,
          domain,
          industry: query.industry,
          locality: query.location,
          region: null,
          country: null,
          sizeBand: query.sizeBand ?? "unknown",
          sourceRef: domain,
        };
      }
    },

    async observe(candidate: Candidate, ctx: AdapterContext): Promise<SignalDraft[]> {
      const domain = candidate.domain;
      if (!domain) {
        const digest = await sha256Hex(`web-signals:v1:no-domain:${candidate.name}`);
        return [
          {
            kind: "site_missing",
            severity: 5,
            features: { resolved: false, reason: "no_domain" },
            sourceDigest: digest,
            expiresInDays: 30,
          },
        ];
      }

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), FETCH_TIMEOUT_MS);
      if (ctx.signal) ctx.signal.addEventListener("abort", () => timeout.abort(), { once: true });

      const started = Date.now();
      let response: Response;
      let scheme = "https";
      try {
        response = await fetchImpl(`https://${domain}/`, {
          method: "GET",
          redirect: "follow",
          signal: timeout.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html" },
        });
        scheme = new URL(response.url || `https://${domain}/`).protocol.replace(":", "");
      } catch {
        // The site did not answer over HTTPS. Try once over HTTP — a business
        // with an http-only site is a real and highly sellable observation,
        // and distinguishing it from "no site at all" matters to the pitch.
        try {
          response = await fetchImpl(`http://${domain}/`, {
            method: "GET",
            redirect: "follow",
            signal: timeout.signal,
            headers: { "user-agent": USER_AGENT, accept: "text/html" },
          });
          scheme = "http";
        } catch {
          clearTimeout(timer);
          const digest = await sha256Hex(`web-signals:v1:unreachable:${domain}`);
          // Unreachable. One honest signal; nothing is asserted about
          // performance, mobile, booking, or analytics — they were not
          // observed, so they are missing, not failing.
          return [
            {
              kind: "site_missing",
              severity: 5,
              features: { resolved: false, reason: "unreachable" },
              sourceDigest: digest,
              expiresInDays: 14,
            },
          ];
        }
      }

      try {
        if (!response.ok) {
          const digest = await sha256Hex(`web-signals:v1:status:${domain}:${response.status}`);
          return [
            {
              kind: "site_missing",
              severity: response.status >= 500 ? 4 : 3,
              features: { resolved: false, reason: "http_error", status: response.status },
              sourceDigest: digest,
              expiresInDays: 14,
            },
          ];
        }

        const { text, truncated } = await readCapped(response);
        const elapsedMs = Date.now() - started;
        const lastModified = response.headers.get("last-modified");

        // The one place the document exists. `digest` is the only thing
        // derived from it that is not a scalar, and it is a hash.
        const digest = await sha256Hex(text);
        const observations = derive(text, { scheme, elapsedMs, lastModified, truncated }, ctx.now);

        return observations.map((o) => ({
          kind: o.kind,
          severity: o.severity,
          features: { ...o.features, observed_by: "web-signals" },
          sourceDigest: digest,
          expiresInDays: 30,
        }));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
