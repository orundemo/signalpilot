import type {
  DiscoveryAdapterId,
  DiscoveryQuery,
  DiscoveryRunStatus,
  PublicDiscoveryRun,
  PublicProspect,
  PublicScore,
  PublicSignal,
  ScoreBand,
  ScoreContribution,
  SignalFeatures,
  SignalKind,
  SignalSeverity,
  SizeBand,
} from "@saas/contracts/prospecting";
import type { DiscoveryRun, Prospect, ProspectWithScore, Score, Signal } from "@saas/db/prospecting";
import { discoveryPublicId, orgPublicId, prospectPublicId, scorePublicId, signalPublicId, userPublicId } from "./ids.js";

export function toPublicScore(score: Score): PublicScore {
  return {
    id: scorePublicId(score.id),
    orgId: orgPublicId(score.orgId),
    prospectId: prospectPublicId(score.prospectId),
    score: score.score,
    band: score.band as ScoreBand,
    rulesetVersion: score.rulesetVersion,
    profileVersion: score.profileVersion,
    contributions: score.contributions as ScoreContribution[],
    signalIds: score.signalIds.map(signalPublicId),
    computedAt: score.computedAt.toISOString(),
  };
}

export function toPublicProspect(prospect: Prospect, score: Score | null): PublicProspect {
  return {
    id: prospectPublicId(prospect.id),
    orgId: orgPublicId(prospect.orgId),
    name: prospect.name,
    domain: prospect.domain,
    industry: prospect.industry,
    locality: prospect.locality,
    region: prospect.region,
    country: prospect.country,
    sizeBand: prospect.sizeBand as SizeBand,
    source: prospect.source,
    status: prospect.status as "active" | "archived",
    firstSeenAt: prospect.firstSeenAt.toISOString(),
    lastEnrichedAt: prospect.lastEnrichedAt ? prospect.lastEnrichedAt.toISOString() : null,
    createdAt: prospect.createdAt.toISOString(),
    updatedAt: prospect.updatedAt.toISOString(),
    archivedAt: prospect.archivedAt ? prospect.archivedAt.toISOString() : null,
    currentScore: score ? toPublicScore(score) : null,
  };
}

export function toPublicProspectWithScore(row: ProspectWithScore): PublicProspect {
  return toPublicProspect(row.prospect, row.score);
}

export function toPublicSignal(signal: Signal): PublicSignal {
  return {
    id: signalPublicId(signal.id),
    orgId: orgPublicId(signal.orgId),
    prospectId: prospectPublicId(signal.prospectId),
    kind: signal.kind as SignalKind,
    severity: signal.severity as SignalSeverity,
    features: signal.features as SignalFeatures,
    source: signal.source,
    sourceDigest: signal.sourceDigest,
    observedAt: signal.observedAt.toISOString(),
    expiresAt: signal.expiresAt ? signal.expiresAt.toISOString() : null,
  };
}

export function toPublicDiscoveryRun(run: DiscoveryRun): PublicDiscoveryRun {
  return {
    id: discoveryPublicId(run.id),
    orgId: orgPublicId(run.orgId),
    requestedBy: userPublicId(run.requestedBy),
    adapter: run.adapter as DiscoveryAdapterId,
    query: run.query as unknown as DiscoveryQuery,
    status: run.status as DiscoveryRunStatus,
    candidatesFound: run.candidatesFound,
    prospectsCreated: run.prospectsCreated,
    prospectsUpdated: run.prospectsUpdated,
    signalsRecorded: run.signalsRecorded,
    errorCode: run.errorCode,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}
