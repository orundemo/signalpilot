import Anthropic from "@anthropic-ai/sdk";
import type { InsightPromptInput, ModelAdapter, ModelOutcome } from "./types.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

/**
 * The Claude adapter.
 *
 * The credential is resolved from environment configuration, so swapping
 * providers is a binding change rather than a code change — that is the whole
 * point of the `ModelAdapter` seam.
 */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Deliberately small. These are two-to-three sentences and a 120-word email;
 * a generous ceiling would only cap a runaway generation *after* paying for
 * it. The guardrail truncates anything longer anyway.
 */
const MAX_TOKENS = 1024;

export interface AnthropicAdapterOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests so the adapter can be exercised without a network call. */
  client?: Pick<Anthropic["beta"]["messages"], "create">;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions): ModelAdapter {
  const model = options.model ?? DEFAULT_MODEL;
  const messages =
    options.client ?? new Anthropic({ apiKey: options.apiKey }).beta.messages;

  return {
    id: `anthropic:${model}`,

    async generate(input: InsightPromptInput): Promise<ModelOutcome> {
      try {
        const response = await messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          // Short factual prose over a small, fully-specified input: low effort
          // is the right depth, and it keeps the per-generation cost — which
          // the tenant is metered for — predictable.
          output_config: { effort: "low" },
          // Server-side fallback: a policy decline is re-run on the recommended
          // model inside the same call, so a false positive on benign copy does
          // not surface to the user as a failed generation.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: [{ role: "user", content: buildUserPrompt(input) }],
        });

        // Check `stop_reason` before reading `content`: a refusal returns HTTP
        // 200 with an empty or partial content array, and indexing it blindly
        // is how a refusal becomes a crash.
        if (response.stop_reason === "refusal") {
          return { ok: false, reason: "declined" };
        }

        const text = response.content
          .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();

        if (text.length === 0) return { ok: false, reason: "declined" };

        return { ok: true, result: { content: text, model: response.model } };
      } catch {
        // Never leak a provider error shape to the caller: the handler turns
        // this into a 503 and the tenant is not metered.
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
