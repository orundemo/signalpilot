import { dedupeKey, normaliseDomain, slugifyName } from "@prospecting-worker/engine/dedupe";

describe("normaliseDomain", () => {
  it("reduces a URL to its registrable domain", () => {
    expect(normaliseDomain("https://www.bakery.example/menu?x=1")).toBe("bakery.example");
    expect(normaliseDomain("http://shop.bakery.example")).toBe("bakery.example");
    expect(normaliseDomain("BAKERY.EXAMPLE")).toBe("bakery.example");
  });

  it("keeps the extra label on a multi-label public suffix", () => {
    expect(normaliseDomain("https://www.bakery.co.uk/")).toBe("bakery.co.uk");
    expect(normaliseDomain("shop.bakery.com.au")).toBe("bakery.com.au");
    expect(normaliseDomain("bakery.co.nz")).toBe("bakery.co.nz");
  });

  it("strips a port, credentials, and a trailing dot", () => {
    expect(normaliseDomain("bakery.example:8443")).toBe("bakery.example");
    expect(normaliseDomain("user:pw@bakery.example")).toBe("bakery.example");
    expect(normaliseDomain("bakery.example.")).toBe("bakery.example");
  });

  it("returns null rather than inventing a domain", () => {
    expect(normaliseDomain(null)).toBeNull();
    expect(normaliseDomain("")).toBeNull();
    expect(normaliseDomain("   ")).toBeNull();
    expect(normaliseDomain("localhost")).toBeNull();
    expect(normaliseDomain("192.168.0.1")).toBeNull();
    expect(normaliseDomain("not a domain!")).toBeNull();
  });

  it("treats www and the apex as the same business", () => {
    expect(normaliseDomain("www.bakery.example")).toBe(normaliseDomain("bakery.example"));
  });
});

describe("slugifyName", () => {
  it("folds diacritics and punctuation", () => {
    expect(slugifyName("Café Zoë")).toBe("cafe-zoe");
    expect(slugifyName("Smith & Sons")).toBe("smith-and-sons");
  });

  it("drops trailing legal forms so Ltd and Limited agree", () => {
    expect(slugifyName("Corner Bakery Ltd.")).toBe(slugifyName("Corner Bakery Limited"));
    expect(slugifyName("Ridgeway Plumbing LLC")).toBe("ridgeway-plumbing");
  });

  it("never strips the last remaining word", () => {
    expect(slugifyName("Limited")).toBe("limited");
  });
});

describe("dedupeKey", () => {
  it("prefers the domain when one is present", () => {
    expect(dedupeKey({ name: "Corner Bakery", domain: "https://www.cornerbakery.example" })).toBe(
      "d:cornerbakery.example",
    );
  });

  it("converges for the same business written two ways", () => {
    const a = dedupeKey({ name: "Corner Bakery Ltd", domain: "https://www.cornerbakery.example/" });
    const b = dedupeKey({ name: "corner bakery limited", domain: "cornerbakery.example" });
    expect(a).toBe(b);
  });

  it("falls back to name plus geography with no domain", () => {
    expect(dedupeKey({ name: "Corner Bakery", country: "GB", locality: "Leeds" })).toBe(
      "n:corner-bakery|gb|leeds",
    );
  });

  it("keeps two same-named businesses in different towns distinct — a false merge destroys pipeline state", () => {
    const leeds = dedupeKey({ name: "The Corner Bakery", country: "GB", locality: "Leeds" });
    const bristol = dedupeKey({ name: "The Corner Bakery", country: "GB", locality: "Bristol" });
    expect(leeds).not.toBe(bristol);
  });

  it("does not merge two businesses that merely share a word", () => {
    const a = dedupeKey({ name: "Corner Bakery", country: "GB", locality: "Leeds" });
    const b = dedupeKey({ name: "Corner Dental", country: "GB", locality: "Leeds" });
    expect(a).not.toBe(b);
  });

  it("produces a usable key even with an unusable name", () => {
    expect(dedupeKey({ name: "!!!", country: "GB", locality: "Leeds" })).toBe("n:unknown|gb|leeds");
  });
});
