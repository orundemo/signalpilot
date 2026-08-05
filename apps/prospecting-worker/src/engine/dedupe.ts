/**
 * Identity resolution. Pure: no clock, no randomness, no I/O.
 *
 * The whole file exists to answer one question — "is this the same business we
 * already have?" — and it answers it **conservatively on purpose**.
 *
 * Merging two distinct businesses is strictly worse than showing two rows for
 * one business. A false merge silently destroys pipeline state: two reps'
 * notes, stages, and owners collapse into one record and there is no undo a
 * user can perform. A false split is a visible annoyance the user resolves by
 * archiving one row. So the key is derived from facts that are either
 * unambiguous (a registrable domain) or tightly scoped (name + country +
 * locality), and never from fuzzy similarity.
 *
 * A manual merge endpoint is a named follow-on, not a v1 heuristic.
 */

/**
 * Public suffixes that take a second label to reach the registrable domain.
 * A full PSL is not vendored: this list covers the country-code second-level
 * domains a UK/EU/AU/NZ-facing agency actually encounters, and an unlisted
 * suffix degrades to "one label less specific", which splits rather than
 * merges — the safe direction.
 */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "com.br", "com.mx", "com.ar", "com.sg", "com.hk", "com.tr", "com.cn",
  "co.za", "co.jp", "co.kr", "co.in", "co.il",
]);

/**
 * Normalise a URL or bare host into a registrable domain.
 *
 * Returns null when there is nothing usable — an IP address, a single label,
 * or an empty string. Null is a legitimate outcome: the caller falls back to
 * the name key rather than inventing a domain.
 */
export function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null;

  let host = input.trim().toLowerCase();
  if (host.length === 0) return null;

  // Accept a full URL or a bare host.
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split("/")[0]!.split("?")[0]!;
  }

  // Strip credentials, port, and a trailing dot.
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  host = host.split(":")[0]!.replace(/\.$/, "");

  if (host.length === 0) return null;
  // An IPv4 literal is not a business identity.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null;

  const lastTwo = labels.slice(-2).join(".");
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return null;

  return labels.slice(-take).join(".");
}

/**
 * Slugify a business name for the fallback key.
 *
 * Diacritics are folded and common legal-form suffixes are dropped, so
 * "Café Zoë Ltd." and "Cafe Zoe Limited" agree. Nothing else is normalised —
 * no stemming, no stop-word removal, no edit distance.
 */
export function slugifyName(name: string): string {
  const folded = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const LEGAL_FORMS = new Set([
    "ltd", "limited", "llc", "llp", "plc", "inc", "incorporated",
    "corp", "corporation", "co", "company", "gmbh", "bv", "nv", "sa",
    "srl", "pty", "pte", "ag", "oy", "ab", "as",
  ]);

  const words = folded.split(" ").filter((w) => w.length > 0);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1]!)) {
    words.pop();
  }

  return words.join("-");
}

export interface DedupeInput {
  name: string;
  domain?: string | null;
  country?: string | null;
  locality?: string | null;
}

/**
 * The identity key stored in `prospects.dedupe_key`, unique per org.
 *
 *  1. a registrable domain, when one is present → `d:<domain>`
 *  2. otherwise name + country + locality → `n:<slug>|<country>|<locality>`
 *
 * Rule 1 wins whenever a domain exists, because two records sharing a
 * registrable domain are the same business by any definition a salesperson
 * would accept. Rule 2 is scoped by geography so two unrelated "The Corner
 * Bakery" in different towns stay distinct.
 */
export function dedupeKey(input: DedupeInput): string {
  const domain = normaliseDomain(input.domain);
  if (domain) return `d:${domain}`;

  const slug = slugifyName(input.name) || "unknown";
  const country = (input.country ?? "").trim().toLowerCase();
  const locality = (input.locality ?? "").trim().toLowerCase();
  return `n:${slug}|${country}|${locality}`;
}
