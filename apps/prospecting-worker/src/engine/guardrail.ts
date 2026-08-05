import type { GuardrailNote, GuardrailVerdict, ScoreContribution, SignalKind } from "@saas/contracts/prospecting";

/**
 * The guardrail. Pure: no clock, no randomness, no network, no model.
 *
 * The model is given the business record, the current score, and the
 * contributions — and nothing else. This file is what stands between that
 * generation and the database.
 *
 * The design commitment it enforces: **a model that quietly hallucinates is a
 * liability; a model whose edits are shown is a feature.** So the verdict is
 * stored and rendered next to the draft. `pass` means the text came back
 * unchanged, `revised` means checks stripped something, and `blocked` means
 * the generation was unsalvageable — in which case nothing is stored, the
 * request returns a typed error, and the tenant is **not** billed for it.
 *
 * Four checks, in the order they run:
 *
 *  1. **Grounding** — every factual claim must map to a signal kind present in
 *     the input. A sentence asserting a weakness we never observed is stripped.
 *  2. **No score talk** — the text may not assert a number other than the one
 *     on the score row. The engine owns the number; the model writes about it.
 *  3. **No fabricated contacts** — no names, emails, or phone numbers may
 *     appear that were not in the input. v1 handles business records only, so
 *     the correct count is zero.
 *  4. **Bounds** — length, and a banned-phrase list (no fake urgency, no
 *     invented client references, no fabricated social proof).
 */

export interface GuardrailInput {
  /** The generated text, as the model returned it. */
  content: string;
  /** Exactly the signal kinds the prompt was given. */
  allowedKinds: SignalKind[];
  /** The score the engine computed. The text may reference this and no other. */
  score: number;
  /** The contributions the prompt was given, for grounding phrases. */
  contributions: ScoreContribution[];
  /** The business name — the one proper noun the text is allowed to use. */
  prospectName: string;
  /** The business domain, when known — also allowed. */
  prospectDomain: string | null;
  kind: "prospect_summary" | "outreach_email";
}

export interface GuardrailResult {
  verdict: GuardrailVerdict;
  /** Empty when `verdict` is `blocked`. */
  content: string;
  notes: GuardrailNote[];
}

const MAX_LENGTH = { prospect_summary: 1200, outreach_email: 2000 } as const;
const MIN_LENGTH = 40;

/**
 * Phrases that make an outreach email worse, not better. Fake urgency and
 * invented social proof are the two failure modes that turn a helpful draft
 * into something a recipient reports as spam — which costs the agency its
 * domain reputation, not ours.
 */
const BANNED_PHRASES = [
  "act now",
  "limited time",
  "only a few spots",
  "last chance",
  "urgent",
  "don't miss out",
  "risk-free",
  "guaranteed results",
  "guarantee results",
  "as seen on",
  "our clients have",
  "we've helped hundreds",
  "we have helped hundreds",
  "trusted by thousands",
  "100% satisfaction",
  "no obligation",
  "free trial",
  "click here",
];

/**
 * Claim phrases per signal kind. A sentence containing any of these asserts
 * that observation, so the observation had better be in the input.
 */
const KIND_CLAIM_PHRASES: Record<SignalKind, string[]> = {
  site_missing: ["no website", "without a website", "don't have a website", "do not have a website", "lack a website"],
  tls_missing: ["https", "ssl", "tls", "not secure", "security warning", "insecure connection"],
  perf_poor: ["slow", "load time", "loading time", "page speed", "loads in", "performance issue"],
  mobile_unfriendly: ["mobile", "phone screen", "responsive", "viewport", "small screen"],
  booking_absent: ["book", "booking", "schedule online", "appointment", "contact form", "enquiry form", "inquiry form"],
  analytics_absent: ["analytics", "tracking", "tag manager", "measure traffic", "visitor data"],
  content_stale: ["out of date", "outdated", "hasn't been updated", "has not been updated", "stale content", "last updated"],
  // "reviews" plural, not "review" — the singular appears in innocent phrases
  // like "in our review of your site", and stripping those is a false positive
  // that costs the user a sentence they wanted.
  reviews_thin: ["reviews", "testimonial", "star rating", "social proof"],
};

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{3,4})?/g;
/**
 * A run of two or more consecutive capitalised words — a person's name, most
 * often. Matched as a whole run rather than as pairs: a pair regex consumes
 * "Hi Sarah" and never sees "Sarah Mitchell" behind it.
 */
const PERSON_NAME_RUN_RE = /\b[A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})+\b/g;

/**
 * Capitalised words that routinely start a sentence or a greeting. Without
 * these, "Hi Sarah" and "Your Website" both read as names.
 */
const NAME_OPENERS: ReadonlySet<string> = new Set([
  "hi", "hello", "hey", "dear", "the", "your", "our", "we", "i", "it", "they",
  "thanks", "thank", "best", "kind", "good", "great", "if", "and", "but", "so",
  "that", "this", "there", "when", "while", "would", "could", "happy", "one",
  "a", "an", "no", "not", "each", "most", "every", "right", "worth",
]);

/**
 * Proper nouns that are products, not people. The check errs toward blocking —
 * a blocked generation stores nothing, bills nothing, and can be regenerated —
 * but blocking on "Google Analytics" would make the analytics signal
 * unmentionable, which defeats the point of the draft.
 */
const NON_PERSON_PROPER_NOUNS: ReadonlySet<string> = new Set([
  "google analytics", "google business", "google search", "tag manager",
  "search console", "core web", "web vitals", "google maps", "apple maps",
]);
const NUMBER_RE = /\b\d{1,3}\b/g;

/** Split on sentence terminators, keeping the terminator with its sentence. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function rejoin(sentences: string[]): string {
  return sentences.join(" ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

export function runGuardrail(input: GuardrailInput): GuardrailResult {
  const notes: GuardrailNote[] = [];
  const allowed = new Set(input.allowedKinds);

  let sentences = splitSentences(input.content);
  if (sentences.length === 0) {
    return {
      verdict: "blocked",
      content: "",
      notes: [{ check: "bounds", action: "blocked", detail: "The model returned no usable text" }],
    };
  }

  // ── 1. Grounding ────────────────────────────────────────
  // A sentence that asserts a weakness we did not observe is not a style
  // problem — it is a false statement about someone's business that a
  // salesperson would then repeat to them.
  const grounded: string[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let unmapped: SignalKind | null = null;
    for (const [kind, phrases] of Object.entries(KIND_CLAIM_PHRASES) as Array<[SignalKind, string[]]>) {
      if (allowed.has(kind)) continue;
      if (phrases.some((phrase) => lower.includes(phrase))) {
        unmapped = kind;
        break;
      }
    }
    if (unmapped) {
      notes.push({
        check: "grounding",
        action: "stripped",
        detail: `Claim about "${unmapped}" is not supported by any signal in the input`,
      });
      continue;
    }
    grounded.push(sentence);
  }
  sentences = grounded;

  // ── 2. No score talk ────────────────────────────────────
  // The engine owns the number. A generation that asserts a different one
  // makes the explainer and the prose disagree, and the user believes the
  // prose.
  const scoreTalk: string[] = [];
  for (const sentence of sentences) {
    // "out of 100" is the scale, not a claim. Strip the denominator before
    // looking for a contradicting number, or every correctly-stated score
    // trips its own check.
    const scaleFree = sentence.replace(/\b(?:out\s+of\s+100|of\s+100)\b/gi, "").replace(/\/\s*100\b/g, "");
    const numbers = scaleFree.match(NUMBER_RE) ?? [];
    const contradicts = numbers.some((raw) => {
      const value = Number(raw);
      if (value === input.score) return false;
      // Only treat a number as a score claim when the sentence frames it as one.
      return /\b(score|scored|rating|rated|out of 100|opportunity)\b/i.test(sentence);
    });
    if (contradicts) {
      notes.push({
        check: "score_talk",
        action: "stripped",
        detail: `Sentence asserts a score other than ${input.score}`,
      });
      continue;
    }
    scoreTalk.push(sentence);
  }
  sentences = scoreTalk;

  // ── 3. No fabricated contacts ───────────────────────────
  // v1 stores business records only. Any personal contact detail in the output
  // was invented, because none was ever in the input.
  let text = rejoin(sentences);
  const allowedTokens = new Set(
    [input.prospectName, input.prospectDomain ?? ""]
      .join(" ")
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => t.toLowerCase()),
  );

  const emails = text.match(EMAIL_RE) ?? [];
  const foreignEmails = emails.filter((e) => !allowedTokens.has(e.toLowerCase()));
  if (foreignEmails.length > 0) {
    return {
      verdict: "blocked",
      content: "",
      notes: [
        ...notes,
        {
          check: "fabricated_contact",
          action: "blocked",
          detail: `Generated ${foreignEmails.length} email address(es) that were not in the input`,
        },
      ],
    };
  }

  const phones = (text.match(PHONE_RE) ?? []).filter((p) => p.replace(/\D/g, "").length >= 7);
  if (phones.length > 0) {
    return {
      verdict: "blocked",
      content: "",
      notes: [
        ...notes,
        {
          check: "fabricated_contact",
          action: "blocked",
          detail: "Generated a phone number that was not in the input",
        },
      ],
    };
  }

  const names: string[] = [];
  for (const run of text.match(PERSON_NAME_RUN_RE) ?? []) {
    const words = run.split(/\s+/);
    // Drop a leading greeting or sentence opener — "Hi Sarah Mitchell" is a
    // greeting followed by the name we actually care about.
    while (words.length > 0 && NAME_OPENERS.has(words[0]!.toLowerCase())) words.shift();
    if (words.length < 2) continue;
    const candidate = words.join(" ");
    const lowerWords = words.map((w) => w.toLowerCase());
    // A run drawn entirely from the business name is the business name.
    if (lowerWords.every((w) => allowedTokens.has(w))) continue;
    if (NON_PERSON_PROPER_NOUNS.has(candidate.toLowerCase())) continue;
    names.push(candidate);
  }
  if (names.length > 0) {
    return {
      verdict: "blocked",
      content: "",
      notes: [
        ...notes,
        {
          check: "fabricated_contact",
          action: "blocked",
          detail: `Generated a person's name that was not in the input: "${names[0]}"`,
        },
      ],
    };
  }

  // ── 4. Bounds ───────────────────────────────────────────
  const lower = text.toLowerCase();
  const banned = BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
  if (banned.length > 0) {
    const kept = splitSentences(text).filter((s) => {
      const l = s.toLowerCase();
      return !BANNED_PHRASES.some((phrase) => l.includes(phrase));
    });
    for (const phrase of banned) {
      notes.push({ check: "bounds", action: "stripped", detail: `Removed banned phrase "${phrase}"` });
    }
    text = rejoin(kept);
  }

  if (text.length > MAX_LENGTH[input.kind]) {
    // Truncate at a sentence boundary rather than mid-word — a draft cut
    // mid-sentence reads as broken, and the user pastes it anyway.
    const kept: string[] = [];
    let total = 0;
    for (const sentence of splitSentences(text)) {
      if (total + sentence.length + 1 > MAX_LENGTH[input.kind]) break;
      kept.push(sentence);
      total += sentence.length + 1;
    }
    text = rejoin(kept);
    notes.push({ check: "bounds", action: "stripped", detail: `Truncated to ${MAX_LENGTH[input.kind]} characters` });
  }

  if (text.trim().length < MIN_LENGTH) {
    return {
      verdict: "blocked",
      content: "",
      notes: [
        ...notes,
        { check: "bounds", action: "blocked", detail: "Nothing usable survived the guardrail checks" },
      ],
    };
  }

  return {
    verdict: notes.length > 0 ? "revised" : "pass",
    content: text.trim(),
    notes,
  };
}
