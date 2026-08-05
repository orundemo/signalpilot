"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScoreBand, ScoreContribution } from "@saas/contracts/prospecting";
import {
  asQuotaState,
  bandLabel,
  bandVariant,
  contributionBars,
  quotaSummary,
  scoreProvenance,
} from "./prospecting";

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

/** Band pill. Reads the server's band; never derives one from the number. */
export function BandBadge({ band }: { band: ScoreBand | null }) {
  return (
    <Badge variant={bandVariant(band)} className="text-[10px] uppercase tracking-wide">
      {bandLabel(band)}
    </Badge>
  );
}

/**
 * The quota-exhausted state.
 *
 * Rendered entirely from the 402's `details` payload — meter, limit, usage,
 * reset date — which is the contract's reason for carrying them. It links to
 * billing, because "you are blocked" without "here is how to unblock" is a
 * dead end.
 */
export function QuotaNotice({
  error,
  orgSlug,
}: {
  error: ApiErrorShape;
  orgSlug: string;
}) {
  const state = asQuotaState(error);
  if (!state) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 space-y-2">
          <div className="font-medium">{state.message}</div>
          <div className="text-sm text-muted-foreground">{quotaSummary(state)}</div>
          <div className="text-xs font-mono text-muted-foreground">{state.meter}</div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/orgs/${orgSlug}/settings/billing`}>Review plan</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Every non-quota error. Shows the code so a support conversation can start. */
export function ErrorNotice({ error }: { error: ApiErrorShape }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">{error.code}</div>
          <div className="text-sm text-muted-foreground">{error.message}</div>
        </div>
      </div>
    </div>
  );
}

/** Error router: the quota case gets its own treatment, everything else the generic one. */
export function ApiErrorNotice({ error, orgSlug }: { error: ApiErrorShape; orgSlug: string }) {
  return asQuotaState(error) ? <QuotaNotice error={error} orgSlug={orgSlug} /> : <ErrorNotice error={error} />;
}

export function LoadingRows({ count = 4, height = "h-10" }: { count?: number; height?: string }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={`${height} w-full`} />
      ))}
    </div>
  );
}

/**
 * The score explainer — the centrepiece of the prospect drawer.
 *
 * Every contribution gets a labelled bar with its points and the reason string
 * the engine produced, plus the ruleset and profile versions underneath. "Why
 * is this 82" is answered here, in full, without a support ticket.
 */
export function ScoreExplainer({
  score,
  band,
  rulesetVersion,
  profileVersion,
  contributions,
  computedAt,
}: {
  score: number;
  band: ScoreBand;
  rulesetVersion: number;
  profileVersion: number;
  contributions: ScoreContribution[];
  computedAt: string;
}) {
  const bars = contributionBars(contributions);
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <div className="text-4xl font-semibold tracking-tight tabular-nums">{score}</div>
        <div className="text-sm text-muted-foreground">/ 100</div>
        <BandBadge band={band} />
      </div>

      {bars.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No live signals contributed to this score. Re-run discovery to refresh the observations.
        </p>
      ) : (
        <ul className="space-y-3">
          {bars.map((bar) => (
            <li key={`${bar.kind}-${bar.points}`} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{bar.kind}</span>
                <span className="tabular-nums font-medium">+{bar.points}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted">
                <div className="h-2 rounded-full bg-primary" style={{ width: `${bar.percent}%` }} />
              </div>
              <p className="text-sm">{bar.reason}</p>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        {scoreProvenance(rulesetVersion, profileVersion)} · computed {new Date(computedAt).toLocaleString()}
      </p>
    </div>
  );
}
