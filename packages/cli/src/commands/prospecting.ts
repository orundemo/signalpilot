// Prospecting command group: `discover`, `prospects`, `insights`, `pipeline`.
//
// The CLI walkthrough is the milestone's verification mechanism, not a
// convenience: a run of
//
//   signalpilot discover run → prospects list → prospects explain →
//   insights generate → pipeline move
//
// exercises every layer — edge routing, tenancy, the scoring engine's
// explainability, the guardrail verdict, and the stage clock — against a
// deployed environment. Anything that cannot be seen from these commands is
// not verifiable on stage.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { readIdempotencyKey, resolveOrgId } from "./helpers.js";

function flagString(ctx: CommandContext, name: string): string | undefined {
  const value = ctx.flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function flagInt(ctx: CommandContext, name: string): number | undefined {
  const raw = flagString(ctx, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new UsageError(`--${name} must be an integer`);
  return parsed;
}

function requirePositional(ctx: CommandContext, index: number, what: string): string {
  const value = ctx.args[index];
  if (value === undefined || value.length === 0) throw new UsageError(`Expected ${what}`);
  return value;
}

function requestOpts(ctx: CommandContext): { idempotencyKey?: string } {
  const key = readIdempotencyKey(ctx);
  return key !== undefined ? { idempotencyKey: key } : {};
}

// ── discover ───────────────────────────────────────────────

/** `signalpilot discover run [--adapter] [--location] [--industry] [--limit] [--domains a,b]` */
export async function discoverRunCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);

  const domains = flagString(ctx, "domains");
  const body = {
    ...(flagString(ctx, "adapter") !== undefined ? { adapter: flagString(ctx, "adapter") as "synthetic" | "web-signals" } : {}),
    ...(flagString(ctx, "location") !== undefined ? { location: flagString(ctx, "location")! } : {}),
    ...(flagString(ctx, "industry") !== undefined ? { industry: flagString(ctx, "industry")! } : {}),
    ...(flagInt(ctx, "limit") !== undefined ? { limit: flagInt(ctx, "limit")! } : {}),
    ...(domains !== undefined ? { domains: domains.split(",").map((d) => d.trim()).filter(Boolean) } : {}),
  };

  const result = await sdk.prospecting.runDiscovery(orgId, body, requestOpts(ctx));

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: "Discovery started",
        record: {
          id: result.discovery.id,
          adapter: result.discovery.adapter,
          status: result.discovery.status,
          poll: `signalpilot discover status ${result.discovery.id}`,
        },
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot discover status <discoveryId>` */
export async function discoverStatusCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const id = requirePositional(ctx, 0, "a discovery id");

  const result = await sdk.prospecting.getDiscovery(orgId, id);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    const run = result.discovery;
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: `Discovery ${run.id}`,
        record: {
          status: run.status,
          adapter: run.adapter,
          candidates: String(run.candidatesFound),
          created: String(run.prospectsCreated),
          updated: String(run.prospectsUpdated),
          signals: String(run.signalsRecorded),
          error: run.errorCode ?? "-",
        },
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot discover list` */
export async function discoverListCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const result = await sdk.prospecting.listDiscoveries(orgId, {});

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["id", "adapter", "status", "created", "started"],
        rows: result.discoveries.map((run) => ({
          id: run.id,
          adapter: run.adapter,
          status: run.status,
          created: String(run.prospectsCreated),
          started: run.startedAt,
        })),
      }),
    );
  }
  return { exitCode: 0 };
}

// ── prospects ──────────────────────────────────────────────

/** `signalpilot prospects list [--band] [--signal-kind] [--stage] [--limit]` */
export async function prospectsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);

  const filters = {
    ...(flagString(ctx, "band") !== undefined ? { band: flagString(ctx, "band") as "hot" | "warm" | "cold" } : {}),
    ...(flagString(ctx, "signal-kind") !== undefined ? { signalKind: flagString(ctx, "signal-kind") as never } : {}),
    ...(flagString(ctx, "stage") !== undefined ? { stageKey: flagString(ctx, "stage")! } : {}),
    ...(flagInt(ctx, "limit") !== undefined ? { limit: flagInt(ctx, "limit")! } : {}),
  };

  const result = await sdk.prospecting.listProspects(orgId, filters);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["id", "name", "domain", "score", "band"],
        rows: result.prospects.map((prospect) => ({
          id: prospect.id,
          name: prospect.name,
          domain: prospect.domain ?? "-",
          score: prospect.currentScore ? String(prospect.currentScore.score) : "-",
          band: prospect.currentScore?.band ?? "-",
        })),
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot prospects signals <prospectId>` */
export async function prospectsSignalsCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");

  const result = await sdk.prospecting.listSignals(orgId, prospectId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["kind", "severity", "observed", "digest", "features"],
        rows: result.signals.map((signal) => ({
          kind: signal.kind,
          severity: String(signal.severity),
          observed: signal.observedAt,
          // The first 12 characters are enough to see the digest is a digest —
          // and to see that the payload it came from is not stored anywhere.
          digest: `${signal.sourceDigest.slice(0, 12)}…`,
          features: JSON.stringify(signal.features),
        })),
      }),
    );
  }
  return { exitCode: 0 };
}

/**
 * `signalpilot prospects explain <prospectId>`
 *
 * The score with its full derivation. This command is the answer to "why is
 * this 82" — if it cannot print the breakdown, the product's central claim is
 * not verifiable from outside the console.
 */
export async function prospectsExplainCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");

  const result = await sdk.prospecting.getProspect(orgId, prospectId);
  const prospect = result.prospect;
  const score = prospect.currentScore;

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { prospect, score } }));
    return { exitCode: 0 };
  }

  if (!score) {
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: prospect.name,
        record: { score: "not yet scored", next: `signalpilot prospects rescore ${prospect.id}` },
      }),
    );
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      title: `${prospect.name} — ${score.score}/100 (${score.band})`,
      record: {
        rulesetVersion: String(score.rulesetVersion),
        profileVersion: String(score.profileVersion),
        computedAt: score.computedAt,
      },
    }),
  );
  ctx.stdout("");
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["points", "signal", "reason"],
      rows: score.contributions.map((contribution) => ({
        points: String(contribution.points),
        signal: contribution.kind,
        reason: contribution.reason,
      })),
    }),
  );
  return { exitCode: 0 };
}

/** `signalpilot prospects rescore <prospectId>` */
export async function prospectsRescoreCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");

  const result = await sdk.prospecting.rescore(orgId, prospectId, requestOpts(ctx));

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: "Rescored",
        record: {
          score: String(result.score.score),
          band: result.score.band,
          contributions: String(result.score.contributions.length),
        },
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot prospects archive <prospectId>` */
export async function prospectsArchiveCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");

  const result = await sdk.prospecting.archiveProspect(orgId, prospectId, requestOpts(ctx));

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({ mode: "human", title: "Archived", record: { id: result.prospect.id, name: result.prospect.name } }),
    );
  }
  return { exitCode: 0 };
}

// ── insights ───────────────────────────────────────────────

/** `signalpilot insights generate <prospectId> [--kind outreach_email]` */
export async function insightsGenerateCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");
  const kind = (flagString(ctx, "kind") ?? "prospect_summary") as "prospect_summary" | "outreach_email";

  const result = await sdk.prospecting.generateInsight(orgId, prospectId, { kind }, requestOpts(ctx));

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    const insight = result.insight;
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: `${insight.kind} — guardrail: ${insight.guardrailVerdict}${insight.cached ? " (cached)" : ""}`,
        record: { model: insight.model ?? "-", promptVersion: String(insight.promptVersion ?? "-") },
      }),
    );
    ctx.stdout("");
    ctx.stdout(insight.content);
    if (insight.guardrailNotes.length > 0) {
      ctx.stdout("");
      // The edits are the feature. A draft the guardrail changed without
      // saying so would be worse than one it refused outright.
      ctx.stdout(
        formatOutput({
          mode: "human",
          columns: ["check", "action", "detail"],
          rows: insight.guardrailNotes.map((note) => ({
            check: note.check,
            action: note.action,
            detail: note.detail,
          })),
        }),
      );
    }
  }
  return { exitCode: 0 };
}

/** `signalpilot insights list <prospectId>` */
export async function insightsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");

  const result = await sdk.prospecting.listInsights(orgId, prospectId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["id", "kind", "guardrail", "model", "created"],
        rows: result.insights.map((insight) => ({
          id: insight.id,
          kind: insight.kind,
          guardrail: insight.guardrailVerdict,
          model: insight.model ?? "-",
          created: insight.createdAt,
        })),
      }),
    );
  }
  return { exitCode: 0 };
}

// ── pipeline ───────────────────────────────────────────────

/** `signalpilot pipeline board` */
export async function pipelineBoardCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const result = await sdk.prospecting.getPipeline(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["stage", "prospect", "score", "owner", "days"],
        rows: result.entries.map((entry) => ({
          stage: entry.stageKey,
          prospect: entry.prospectName,
          score: entry.score === null ? "-" : String(entry.score),
          owner: entry.ownerUserId ?? "-",
          days: String(entry.daysInStage),
        })),
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot pipeline add <prospectId> [--stage new] [--owner usr_…] [--value 250000]` */
export async function pipelineAddCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const prospectId = requirePositional(ctx, 0, "a prospect id");

  const result = await sdk.prospecting.createEntry(
    orgId,
    {
      prospectId,
      ...(flagString(ctx, "stage") !== undefined ? { stageKey: flagString(ctx, "stage")! } : {}),
      ...(flagString(ctx, "owner") !== undefined ? { ownerUserId: flagString(ctx, "owner")! } : {}),
      ...(flagInt(ctx, "value") !== undefined ? { valueCents: flagInt(ctx, "value")! } : {}),
    },
    requestOpts(ctx),
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: "Added to pipeline",
        record: { entry: result.entry.id, stage: result.entry.stageKey },
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot pipeline move <entryId> --stage contacted [--owner] [--value]` */
export async function pipelineMoveCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const entryId = requirePositional(ctx, 0, "a pipeline entry id");

  const stage = flagString(ctx, "stage");
  const owner = flagString(ctx, "owner");
  const value = flagInt(ctx, "value");
  if (stage === undefined && owner === undefined && value === undefined) {
    throw new UsageError("Pass at least one of --stage, --owner, or --value");
  }

  const result = await sdk.prospecting.updateEntry(
    orgId,
    entryId,
    {
      ...(stage !== undefined ? { stageKey: stage } : {}),
      ...(owner !== undefined ? { ownerUserId: owner } : {}),
      ...(value !== undefined ? { valueCents: value } : {}),
    },
    requestOpts(ctx),
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        title: "Pipeline entry updated",
        record: {
          entry: result.entry.id,
          stage: result.entry.stageKey,
          enteredStageAt: result.entry.enteredStageAt,
          closedAt: result.entry.closedAt ?? "-",
        },
      }),
    );
  }
  return { exitCode: 0 };
}

/** `signalpilot pipeline stages` */
export async function pipelineStagesCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const orgId = await resolveOrgId(ctx, true);
  const result = await sdk.prospecting.listStages(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["position", "key", "label", "outcome"],
        rows: result.stages.map((stage) => ({
          position: String(stage.position),
          key: stage.key,
          label: stage.label,
          outcome: stage.outcome,
        })),
      }),
    );
  }
  return { exitCode: 0 };
}
