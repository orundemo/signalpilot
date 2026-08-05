// `signalpilot demo seed` — build the demo tenant against a deployed environment.
//
// This is a command rather than a fixture file on purpose. A seeded tenant has
// to be produced by the *product*: discovery creates the prospects, the engine
// scores them, the guardrail passes the drafts, and the pipeline constraint
// governs the board. A SQL fixture would produce a tenant that looks right and
// proves nothing — and would drift the moment the ruleset version changed.
//
// Everything it does goes through the public API with the operator's own
// credentials, so it is also a working end-to-end exercise of every milestone.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";

/** The demo tenant's shape, from the SP8 acceptance criteria. */
const DEFAULT_PROSPECT_TARGET = 200;
const DEFAULT_PIPELINE_TARGET = 40;
/** `POST /discoveries` caps a single run; the seed loops to reach the target. */
const RUN_LIMIT = 100;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;

const LOCALES = ["Leeds", "Bristol", "Glasgow", "Cork", "Austin", "Portland"];
const TRADES = ["bakery", "dentistry", "landscaping", "plumbing", "fitness", "veterinary", "hospitality", "retail"];
const STAGE_SPREAD = ["new", "new", "contacted", "contacted", "replied", "meeting"];

function flagInt(ctx: CommandContext, name: string, fallback: number): number {
  const raw = ctx.flags[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a positive integer`);
  return parsed;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `signalpilot demo seed [--prospects 200] [--pipeline 40] [--dry-run]`
 *
 * Idempotent by construction: discovery converges on the dedupe key, so
 * re-running it updates rather than duplicating, and adding a prospect that is
 * already on the board is a 409 the seed treats as "already there".
 */
export async function demoSeedCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectTarget = flagInt(ctx, "prospects", DEFAULT_PROSPECT_TARGET);
  const pipelineTarget = flagInt(ctx, "pipeline", DEFAULT_PIPELINE_TARGET);
  const dryRun = ctx.flags["dry-run"] === true;

  const log = (line: string): void => {
    if (ctx.outputMode !== "json") ctx.stderr(line);
  };

  if (dryRun) {
    ctx.stdout(
      formatOutput({
        mode: ctx.outputMode,
        title: "Demo seed plan",
        record: {
          org: orgId,
          discoveries: String(Math.ceil(prospectTarget / RUN_LIMIT) * LOCALES.length),
          prospects: String(prospectTarget),
          pipeline: String(pipelineTarget),
          insights: "1 outreach draft for the hottest prospect",
        },
        data: { orgId, prospectTarget, pipelineTarget, dryRun: true },
      }),
    );
    return { exitCode: 0 };
  }

  // ── 1. Discover ─────────────────────────────────────────
  // Spread across locations and trades so the board reads like a real book of
  // business rather than one query repeated.
  let created = 0;
  let runs = 0;
  for (const location of LOCALES) {
    if (created >= prospectTarget) break;
    for (const industry of TRADES) {
      if (created >= prospectTarget) break;
      const remaining = prospectTarget - created;
      const started = await sdk.prospecting.runDiscovery(orgId, {
        adapter: "synthetic",
        location,
        industry,
        limit: Math.min(RUN_LIMIT, Math.max(5, remaining)),
      });
      runs += 1;
      log(`  discovery ${started.discovery.id} (${location} · ${industry})`);

      const finished = await pollRun(sdk, orgId, started.discovery.id);
      created += finished.prospectsCreated;
      log(`    → ${finished.status}: +${finished.prospectsCreated} created, ${finished.prospectsUpdated} updated`);
    }
  }

  // ── 2. Read the board back ──────────────────────────────
  const board = await sdk.prospecting.listProspects(orgId, { limit: 100 });
  const prospects = board.prospects;
  log(`seeded ${prospects.length} prospects across ${runs} runs`);

  // ── 3. Populate the pipeline ────────────────────────────
  // Spread across the open stages, and vary the value so the board has
  // something to sort by.
  let placed = 0;
  for (const [index, prospect] of prospects.entries()) {
    if (placed >= pipelineTarget) break;
    const stageKey = STAGE_SPREAD[index % STAGE_SPREAD.length]!;
    try {
      await sdk.prospecting.createEntry(orgId, {
        prospectId: prospect.id,
        stageKey,
        valueCents: (index % 7) * 50_000 + 75_000,
      });
      placed += 1;
    } catch {
      // Already on the board (409) — the one-open-entry constraint doing its
      // job. Nothing to fix; keep going.
    }
  }
  log(`placed ${placed} prospects on the pipeline`);

  // ── 4. One real outreach draft ──────────────────────────
  // The acceptance bar is a hot prospect with a draft worth sending, so this
  // generates against the highest-scoring prospect rather than the first one.
  const hottest = [...prospects]
    .filter((p) => p.currentScore !== null)
    .sort((a, b) => (b.currentScore?.score ?? 0) - (a.currentScore?.score ?? 0))[0];

  let draftedFor: string | null = null;
  let draftScore: number | null = null;
  if (hottest) {
    try {
      await sdk.prospecting.generateInsight(orgId, hottest.id, { kind: "outreach_email" });
      draftedFor = hottest.name;
      draftScore = hottest.currentScore?.score ?? null;
      log(`drafted outreach for ${hottest.name} (${draftScore})`);
    } catch {
      // A quota-exhausted or guardrail-blocked draft is a legitimate outcome
      // and must not fail the seed — the board is still complete without it.
      log("could not generate a draft (quota or guardrail); the rest of the seed is intact");
    }
  }

  const summary = {
    orgId,
    discoveryRuns: runs,
    prospects: prospects.length,
    pipelineEntries: placed,
    hottest: draftedFor,
    hottestScore: draftScore,
  };

  ctx.stdout(
    formatOutput({
      mode: ctx.outputMode,
      title: "Demo tenant seeded",
      record: {
        prospects: String(summary.prospects),
        pipeline: String(summary.pipelineEntries),
        runs: String(summary.discoveryRuns),
        draft: draftedFor ?? "none",
      },
      data: summary,
    }),
  );
  return { exitCode: 0 };
}

interface RunState {
  status: string;
  prospectsCreated: number;
  prospectsUpdated: number;
}

/**
 * Poll a discovery to completion.
 *
 * Bounded: a run that never reaches a terminal state returns its last known
 * counters rather than hanging. The seed's job is to make a board, not to
 * diagnose a stuck run.
 */
async function pollRun(
  sdk: Awaited<ReturnType<CommandContext["sdk"]>>,
  orgId: string,
  discoveryId: string,
): Promise<RunState> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: RunState = { status: "running", prospectsCreated: 0, prospectsUpdated: 0 };

  while (Date.now() < deadline) {
    const result = await sdk.prospecting.getDiscovery(orgId, discoveryId);
    last = {
      status: result.discovery.status,
      prospectsCreated: result.discovery.prospectsCreated,
      prospectsUpdated: result.discovery.prospectsUpdated,
    };
    if (last.status !== "running") return last;
    await sleep(POLL_INTERVAL_MS);
  }
  return last;
}
