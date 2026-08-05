import type { InsightPromptInput, ModelAdapter, ModelOutcome } from "./types.js";

/**
 * A deterministic writer that composes prose from the contributions directly.
 *
 * Two jobs:
 *
 *  1. **Tests.** The guardrail and the caching path need generations that are
 *     byte-identical across runs. A model call cannot give that, and mocking
 *     the model in every test would mean the caching and metering paths are
 *     only ever exercised against a fiction.
 *  2. **No credential configured.** The demo tenant and any environment
 *     without `MODEL_API_KEY` still need the insights surface to work end to
 *     end. Falling back to this is honest — the row records `model: "template"`,
 *     so the console can say so — where returning a 503 would make an
 *     unconfigured environment look broken.
 *
 * It writes only from the contributions it was given, so it passes the same
 * guardrail the model output does.
 */
export function createTemplateAdapter(): ModelAdapter {
  return {
    id: "template",

    async generate(input: InsightPromptInput): Promise<ModelOutcome> {
      const top = input.contributions.slice(0, 3);
      if (top.length === 0) {
        return {
          ok: true,
          result: {
            model: "template",
            content:
              input.kind === "prospect_summary"
                ? `No weaknesses were observed for ${input.prospectName}. There is nothing concrete to open a conversation with yet — re-run discovery before reaching out.`
                : `We looked at ${input.prospectName} and did not find anything obviously wrong with the site. Rather than invent a reason to get in touch, we will wait until we have something specific to say.`,
          },
        };
      }

      const findings = top.map((c) => c.reason.replace(/^([A-Z])/, (m) => m.toLowerCase()));
      const list =
        findings.length === 1
          ? findings[0]
          : `${findings.slice(0, -1).join(", ")}, and ${findings[findings.length - 1]}`;

      if (input.kind === "prospect_summary") {
        const context = [input.industry, input.locality].filter(Boolean).join(" business in ");
        return {
          ok: true,
          result: {
            model: "template",
            content: [
              `${input.prospectName}${context ? ` is a ${context}` : ""} scoring ${input.score} of 100 (${input.band}).`,
              `The site shows ${list}.`,
              `The strongest opening is ${findings[0]} — it is checkable in under a minute and costs them customers today.`,
            ].join(" "),
          },
        };
      }

      return {
        ok: true,
        result: {
          model: "template",
          content: [
            `I had a look at ${input.prospectDomain ?? input.prospectName} this morning and noticed ${findings[0]}.`,
            findings.length > 1 ? `A couple of other things stood out too: ${findings.slice(1).join(", and ")}.` : "",
            `Each of those is a small, self-contained fix rather than a rebuild, and together they change how many enquiries the site actually produces.`,
            `Would it be useful if I sent over what I found in a bit more detail?`,
          ]
            .filter((line) => line.length > 0)
            .join(" "),
        },
      };
    },
  };
}
