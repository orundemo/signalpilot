import type { Env } from "../env.js";
import type { ModelAdapter } from "./types.js";
import { createAnthropicAdapter } from "./anthropic.js";
import { createTemplateAdapter } from "./template.js";

export type { InsightPromptInput, ModelAdapter, ModelOutcome, ModelResult } from "./types.js";
export { PROMPT_VERSION } from "./types.js";
export { SYSTEM_PROMPT, buildUserPrompt, inputDigest } from "./prompt.js";
export { createAnthropicAdapter, DEFAULT_MODEL } from "./anthropic.js";
export { createTemplateAdapter } from "./template.js";

/**
 * Resolve the model adapter from environment configuration.
 *
 * With no credential bound, this returns the deterministic template writer
 * rather than failing the request. That is a deliberate product call: an
 * environment without a model key should still show a working insights
 * surface, and the stored row records `model: "template"` so nothing is
 * misrepresented as a model generation.
 */
export function resolveModelAdapter(env: Env): ModelAdapter {
  if (env.MODEL_API_KEY && env.MODEL_API_KEY.length > 0) {
    return createAnthropicAdapter({
      apiKey: env.MODEL_API_KEY,
      ...(env.MODEL_ID ? { model: env.MODEL_ID } : {}),
    });
  }
  return createTemplateAdapter();
}
