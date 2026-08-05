import type { DiscoveryAdapterId } from "@saas/contracts/prospecting";
import type { DiscoveryAdapter } from "./types.js";
import { createSyntheticAdapter } from "./synthetic.js";
import { createWebSignalsAdapter } from "./web-signals.js";

export type { AdapterContext, Candidate, DiscoveryAdapter, NormalisedQuery, SignalDraft } from "./types.js";
export { sha256Hex } from "./types.js";
export { createSyntheticAdapter } from "./synthetic.js";
export { createWebSignalsAdapter } from "./web-signals.js";

/**
 * The adapter registry. v1 ships two credential-free adapters; credentialed
 * providers bind through `integrations-worker` in a later milestone and are
 * added here without touching any caller — that is what the interface buys.
 */
export function resolveAdapter(id: DiscoveryAdapterId): DiscoveryAdapter {
  switch (id) {
    case "web-signals":
      return createWebSignalsAdapter();
    case "synthetic":
    default:
      return createSyntheticAdapter();
  }
}
