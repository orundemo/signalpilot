import { createSyntheticAdapter } from "@prospecting-worker/adapters/synthetic";
import { createWebSignalsAdapter } from "@prospecting-worker/adapters/web-signals";
import { resolveAdapter } from "@prospecting-worker/adapters/index";
import type { Candidate, NormalisedQuery } from "@prospecting-worker/adapters/types";
import { SIGNAL_KINDS, isSignalFeatures, isSourceDigest } from "@saas/contracts/prospecting";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const CTX = { requestId: "req_test", now: NOW };

function query(overrides: Partial<NormalisedQuery> = {}): NormalisedQuery {
  return { location: null, industry: null, sizeBand: null, domains: [], limit: 10, ...overrides };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("adapter registry", () => {
  it("resolves both v1 adapters, and neither needs a per-tenant credential", () => {
    expect(resolveAdapter("synthetic").id).toBe("synthetic");
    expect(resolveAdapter("web-signals").id).toBe("web-signals");
    expect(resolveAdapter("synthetic").requiresConnection).toBe(false);
    expect(resolveAdapter("web-signals").requiresConnection).toBe(false);
  });
});

describe("synthetic adapter", () => {
  const adapter = createSyntheticAdapter();

  it("yields exactly the requested number of candidates", async () => {
    const candidates = await collect(adapter.search(query({ limit: 7 }), CTX));
    expect(candidates).toHaveLength(7);
  });

  it("is deterministic — the same query yields the same corpus", async () => {
    const first = await collect(adapter.search(query({ location: "Leeds", limit: 5 }), CTX));
    const second = await collect(adapter.search(query({ location: "Leeds", limit: 5 }), CTX));
    expect(first).toEqual(second);
  });

  it("yields a different corpus for a different query", async () => {
    const leeds = await collect(adapter.search(query({ location: "Leeds", limit: 5 }), CTX));
    const bristol = await collect(adapter.search(query({ location: "Bristol", limit: 5 }), CTX));
    expect(leeds.map((c) => c.name)).not.toEqual(bristol.map((c) => c.name));
  });

  it("honours a location filter", async () => {
    const candidates = await collect(adapter.search(query({ location: "Leeds", limit: 8 }), CTX));
    for (const candidate of candidates) expect(candidate.locality).toBe("Leeds");
  });

  it("produces a realistic mix, not a corpus of uniformly hot prospects", async () => {
    const candidates = await collect(adapter.search(query({ limit: 40 }), CTX));
    const counts = await Promise.all(candidates.map(async (c) => (await adapter.observe(c, CTX)).length));
    expect(Math.min(...counts)).toBeLessThan(Math.max(...counts));
  });

  it("emits only catalog kinds, scalar features, and a real digest", async () => {
    const candidates = await collect(adapter.search(query({ limit: 20 }), CTX));
    for (const candidate of candidates) {
      for (const draft of await adapter.observe(candidate, CTX)) {
        expect(SIGNAL_KINDS as readonly string[]).toContain(draft.kind);
        expect(isSignalFeatures(draft.features)).toBe(true);
        expect(isSourceDigest(draft.sourceDigest)).toBe(true);
        expect(draft.severity).toBeGreaterThanOrEqual(1);
        expect(draft.severity).toBeLessThanOrEqual(5);
      }
    }
  });

  it("observes the same candidate identically on a re-run", async () => {
    const [candidate] = await collect(adapter.search(query({ limit: 1 }), CTX));
    expect(await adapter.observe(candidate!, CTX)).toEqual(await adapter.observe(candidate!, CTX));
  });
});

describe("web-signals adapter", () => {
  const WEAK_PAGE = `<!doctype html><html><head><title>Ridgeway Plumbing</title></head>
    <body><h1>Ridgeway Plumbing</h1><p>Call us on the number in the window.</p></body></html>`;

  function candidate(domain: string | null = "ridgeway.example"): Candidate {
    return {
      name: domain ?? "Ridgeway Plumbing",
      domain,
      industry: null,
      locality: null,
      region: null,
      country: null,
      sizeBand: "unknown",
      sourceRef: domain,
    };
  }

  function respondWith(html: string, init: { status?: number; url?: string; headers?: Record<string, string> } = {}) {
    return async (): Promise<Response> =>
      new Response(html, {
        status: init.status ?? 200,
        headers: { "content-type": "text/html", ...(init.headers ?? {}) },
      });
  }

  it("derives six of the eight catalog kinds from one weak page", async () => {
    // http-only, no viewport, no booking or contact route, no analytics, stale
    // Last-Modified, and slow enough to bucket as poor.
    const slowFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://")) throw new Error("no tls");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(WEAK_PAGE, {
        status: 200,
        headers: { "content-type": "text/html", "last-modified": "Mon, 01 Jan 2018 00:00:00 GMT" },
      });
    };
    const adapter = createWebSignalsAdapter(slowFetch as unknown as typeof fetch);

    const drafts = await adapter.observe(candidate(), CTX);
    const kinds = drafts.map((d) => d.kind);

    expect(kinds).toContain("tls_missing");
    expect(kinds).toContain("mobile_unfriendly");
    expect(kinds).toContain("booking_absent");
    expect(kinds).toContain("analytics_absent");
    expect(kinds).toContain("content_stale");
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(4);
  });

  it("records nothing it did not observe when the site is unreachable", async () => {
    const adapter = createWebSignalsAdapter((() => Promise.reject(new Error("dns"))) as unknown as typeof fetch);
    const drafts = await adapter.observe(candidate(), CTX);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.kind).toBe("site_missing");
    expect(drafts[0]!.features.reason).toBe("unreachable");
    // The crucial assertion: no performance, mobile, booking, or analytics
    // claim is fabricated from a failed fetch.
    for (const fabricated of ["perf_poor", "mobile_unfriendly", "booking_absent", "analytics_absent"]) {
      expect(drafts.map((d) => d.kind)).not.toContain(fabricated);
    }
  });

  it("distinguishes an HTTP error from an unreachable host", async () => {
    const adapter = createWebSignalsAdapter(respondWith("", { status: 503 }) as unknown as typeof fetch);
    const drafts = await adapter.observe(candidate(), CTX);
    expect(drafts[0]!.kind).toBe("site_missing");
    expect(drafts[0]!.features.reason).toBe("http_error");
    expect(drafts[0]!.features.status).toBe(503);
  });

  it("reports a healthy modern page as having almost nothing to sell", async () => {
    const strong = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <script src="https://www.googletagmanager.com/gtag/js"></script></head>
      <body><a href="https://calendly.com/x">Book now</a><form></form></body></html>`;
    const adapter = createWebSignalsAdapter(
      respondWith(strong, { headers: { "last-modified": new Date(NOW).toUTCString() } }) as unknown as typeof fetch,
    );
    const drafts = await adapter.observe(candidate(), CTX);
    expect(drafts.map((d) => d.kind)).not.toContain("mobile_unfriendly");
    expect(drafts.map((d) => d.kind)).not.toContain("analytics_absent");
    expect(drafts.map((d) => d.kind)).not.toContain("booking_absent");
  });

  it("never lets a payload out — only scalars and a sha256 cross the boundary", async () => {
    const adapter = createWebSignalsAdapter(respondWith(WEAK_PAGE) as unknown as typeof fetch);
    const drafts = await adapter.observe(candidate(), CTX);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(isSignalFeatures(draft.features)).toBe(true);
      expect(isSourceDigest(draft.sourceDigest)).toBe(true);
      expect(JSON.stringify(draft)).not.toContain("<html");
      expect(JSON.stringify(draft)).not.toContain("Ridgeway");
    }
  });

  it("hashes the document it read, so two different pages get different digests", async () => {
    const a = createWebSignalsAdapter(respondWith("<html><body>one</body></html>") as unknown as typeof fetch);
    const b = createWebSignalsAdapter(respondWith("<html><body>two</body></html>") as unknown as typeof fetch);
    const [da] = await a.observe(candidate(), CTX);
    const [db] = await b.observe(candidate(), CTX);
    expect(da!.sourceDigest).not.toBe(db!.sourceDigest);
  });

  it("observes only the domains it was given, deduplicated", async () => {
    const adapter = createWebSignalsAdapter(respondWith(WEAK_PAGE) as unknown as typeof fetch);
    const candidates = await collect(
      adapter.search(query({ domains: ["https://www.a.example", "a.example", "b.example"], limit: 10 }), CTX),
    );
    expect(candidates.map((c) => c.domain)).toEqual(["a.example", "b.example"]);
  });

  it("reports a candidate with no domain as site_missing rather than fetching nothing", async () => {
    const adapter = createWebSignalsAdapter(respondWith(WEAK_PAGE) as unknown as typeof fetch);
    const drafts = await adapter.observe(candidate(null), CTX);
    expect(drafts[0]!.kind).toBe("site_missing");
    expect(drafts[0]!.features.reason).toBe("no_domain");
  });
});
