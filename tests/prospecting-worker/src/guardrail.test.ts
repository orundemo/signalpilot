import { runGuardrail } from "@prospecting-worker/engine/guardrail";
import type { GuardrailInput } from "@prospecting-worker/engine/guardrail";
import type { ScoreContribution, SignalKind } from "@saas/contracts/prospecting";

function contribution(kind: SignalKind, reason: string): ScoreContribution {
  return { kind, points: 20, reason, severity: 4, features: {}, signalId: "sig_1" };
}

function input(overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    content: "",
    allowedKinds: ["tls_missing", "perf_poor"],
    score: 45,
    contributions: [
      contribution("tls_missing", "No valid HTTPS"),
      contribution("perf_poor", "Page loads in 6.4s"),
    ],
    prospectName: "Ridgeway Plumbing",
    prospectDomain: "ridgeway.example",
    kind: "outreach_email",
    ...overrides,
  };
}

describe("guardrail — clean generation", () => {
  it("passes text that only claims observed weaknesses", () => {
    const result = runGuardrail(
      input({
        content:
          "I had a look at ridgeway.example and noticed the site has no valid HTTPS, so visitors see a security warning. It also loads slowly on a normal connection. Would it be useful if I sent over what I found?",
      }),
    );
    expect(result.verdict).toBe("pass");
    expect(result.notes).toEqual([]);
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe("guardrail — check 1: grounding", () => {
  it("strips a claim about a weakness that was never observed", () => {
    const result = runGuardrail(
      input({
        content:
          "Your site has no valid HTTPS, which is costing you trust. You also have no way for customers to book an appointment online. Happy to help either way.",
      }),
    );
    expect(result.verdict).toBe("revised");
    expect(result.content).not.toContain("book an appointment");
    expect(result.notes.some((n) => n.check === "grounding")).toBe(true);
  });

  it("names the unsupported signal kind in the note", () => {
    const result = runGuardrail(
      input({ content: "Your site has no analytics installed at all, so you cannot see what is happening. It also has no valid HTTPS." }),
    );
    expect(result.notes.find((n) => n.check === "grounding")!.detail).toContain("analytics_absent");
  });

  it("keeps a claim once the corresponding signal is in the input", () => {
    const result = runGuardrail(
      input({
        allowedKinds: ["tls_missing", "perf_poor", "booking_absent"],
        content: "Your site has no valid HTTPS. There is also no way to book an appointment online. Worth a quick look?",
      }),
    );
    expect(result.content).toContain("book an appointment");
  });
});

describe("guardrail — check 2: no score talk", () => {
  it("strips a sentence asserting a different score", () => {
    const result = runGuardrail(
      input({ content: "Your website scored 91 out of 100 overall. The site has no valid HTTPS, which is worth fixing quickly." }),
    );
    expect(result.verdict).toBe("revised");
    expect(result.content).not.toContain("91");
    expect(result.notes.some((n) => n.check === "score_talk")).toBe(true);
  });

  it("keeps a sentence stating the correct score", () => {
    const result = runGuardrail(
      input({ score: 45, content: "Your website scored 45 out of 100 overall, mostly because it has no valid HTTPS at all." }),
    );
    expect(result.content).toContain("45");
    expect(result.notes.some((n) => n.check === "score_talk")).toBe(false);
  });

  it("does not treat an ordinary number as a score claim", () => {
    const result = runGuardrail(
      input({ content: "The site has no valid HTTPS and it loads in about 6 seconds on a normal connection, which loses visitors." }),
    );
    expect(result.notes.some((n) => n.check === "score_talk")).toBe(false);
  });
});

describe("guardrail — check 3: no fabricated contacts", () => {
  it("blocks a generation that invents an email address", () => {
    const result = runGuardrail(
      input({ content: "Hi there, your site has no valid HTTPS. Reach me at hello@agency.example if that sounds useful to you." }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.content).toBe("");
    expect(result.notes.some((n) => n.check === "fabricated_contact" && n.action === "blocked")).toBe(true);
  });

  it("blocks a generation that invents a phone number", () => {
    const result = runGuardrail(
      input({ content: "Your site has no valid HTTPS. Give us a ring on 0113 496 0155 and we can talk it through properly." }),
    );
    expect(result.verdict).toBe("blocked");
  });

  it("blocks a generation that invents a person's name", () => {
    const result = runGuardrail(
      input({ content: "Hi Sarah Mitchell, I noticed your site has no valid HTTPS and thought it was worth flagging to you directly." }),
    );
    expect(result.verdict).toBe("blocked");
    expect(result.notes.find((n) => n.check === "fabricated_contact")!.detail).toContain("Sarah Mitchell");
  });

  it("does not treat the business's own name as a fabricated contact", () => {
    const result = runGuardrail(
      input({ content: "Ridgeway Plumbing has no valid HTTPS on its website, which shows visitors a browser security warning today." }),
    );
    expect(result.verdict).not.toBe("blocked");
  });

  it("stores nothing at all when it blocks — not a truncated draft", () => {
    const result = runGuardrail(
      input({ content: "Your site has no valid HTTPS and loads slowly. Contact me at rep@agency.example about it." }),
    );
    expect(result.content).toBe("");
  });
});

describe("guardrail — check 4: bounds", () => {
  it("strips fake urgency", () => {
    const result = runGuardrail(
      input({ content: "Your site has no valid HTTPS, which is worth fixing. Act now — this is your last chance to secure a slot. Shall I send details?" }),
    );
    expect(result.verdict).toBe("revised");
    expect(result.content.toLowerCase()).not.toContain("act now");
    expect(result.notes.some((n) => n.check === "bounds")).toBe(true);
  });

  it("strips invented client references", () => {
    const result = runGuardrail(
      input({ content: "Your site has no valid HTTPS. We've helped hundreds of businesses just like yours to fix exactly this problem. Interested?" }),
    );
    expect(result.verdict).toBe("revised");
    expect(result.content.toLowerCase()).not.toContain("helped hundreds");
  });

  it("truncates an over-long draft at a sentence boundary", () => {
    const sentence = "The site has no valid HTTPS which shows a browser warning to every visitor who arrives. ";
    const result = runGuardrail(input({ content: sentence.repeat(40) }));
    expect(result.verdict).toBe("revised");
    expect(result.content.length).toBeLessThanOrEqual(2000);
    expect(result.content.endsWith(".")).toBe(true);
  });

  it("blocks when nothing usable survives", () => {
    const result = runGuardrail(input({ content: "Act now! Last chance! Limited time only!" }));
    expect(result.verdict).toBe("blocked");
    expect(result.content).toBe("");
  });

  it("blocks an empty generation", () => {
    const result = runGuardrail(input({ content: "   " }));
    expect(result.verdict).toBe("blocked");
  });
});

describe("guardrail — verdict semantics", () => {
  it("reports pass only when nothing was changed", () => {
    const clean = runGuardrail(input({ content: "The site has no valid HTTPS today, so every visitor sees a browser security warning on arrival." }));
    expect(clean.verdict).toBe("pass");
    expect(clean.notes).toHaveLength(0);
  });

  it("reports revised with a note per edit, so the console can show what changed", () => {
    const result = runGuardrail(
      input({
        content:
          "Your site has no valid HTTPS. You also have no analytics at all installed. Act now to fix it. It loads slowly too, which loses visitors.",
      }),
    );
    expect(result.verdict).toBe("revised");
    expect(result.notes.length).toBeGreaterThanOrEqual(2);
    for (const note of result.notes) {
      expect(note.detail.length).toBeGreaterThan(0);
      expect(["grounding", "score_talk", "fabricated_contact", "bounds"]).toContain(note.check);
    }
  });

  it("is pure — the same input twice gives byte-identical output", () => {
    const args = input({ content: "Your site has no valid HTTPS. You also have no analytics installed at all. It loads slowly on mobile." });
    expect(JSON.stringify(runGuardrail(args))).toBe(JSON.stringify(runGuardrail(args)));
  });
});
