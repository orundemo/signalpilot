"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Building2, RefreshCw, Target } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  ApiErrorNotice,
  BandBadge,
  LoadingRows,
  ScoreExplainer,
  type ApiErrorShape,
} from "@/components/prospecting/shared";
import {
  EMPTY_FILTERS,
  buildProspectQuery,
  hasActiveFilters,
  sortProspects,
  type ProspectFilterState,
} from "@/components/prospecting/prospecting";
import { SCORE_BANDS, SIGNAL_KINDS } from "@saas/contracts/prospecting";
import type { PublicActivity, PublicProspect, PublicSignal } from "@saas/contracts/prospecting";

export default function ProspectsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const [filters, setFilters] = React.useState<ProspectFilterState>(EMPTY_FILTERS);
  const [prospects, setProspects] = React.useState<PublicProspect[] | null>(null);
  const [error, setError] = React.useState<ApiErrorShape | null>(null);
  const [selected, setSelected] = React.useState<PublicProspect | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setProspects(null);
    setError(null);
    void wrap(() => client.prospecting.listProspects(orgId, buildProspectQuery(filters))).then((result) => {
      if (cancelled) return;
      if (result.ok) setProspects(sortProspects(result.data.prospects));
      else setError({ code: result.error.code, message: result.error.message, details: result.error.details });
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId, filters, refreshToken]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Prospects</h1>
        <p className="text-sm text-muted-foreground">
          Every business discovered for this organization, hottest first. Open one to see exactly why it scored
          what it scored.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" /> Board
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Filters filters={filters} onChange={setFilters} />

          {error ? (
            <ApiErrorNotice error={error} orgSlug={orgSlug} />
          ) : prospects === null ? (
            <LoadingRows count={6} />
          ) : prospects.length === 0 ? (
            <EmptyState
              icon={Building2}
              title={hasActiveFilters(filters) ? "Nothing matches these filters" : "No prospects yet"}
              description={
                hasActiveFilters(filters)
                  ? "Clear a filter, or widen the band you are looking at."
                  : "Run a discovery to populate the board."
              }
              {...(hasActiveFilters(filters)
                ? { primaryAction: { label: "Clear filters", onClick: () => setFilters(EMPTY_FILTERS) } }
                : { primaryAction: { label: "Run a discovery", href: `/orgs/${orgSlug}/discover` } })}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Band</TableHead>
                  <TableHead>Where</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prospects.map((prospect) => (
                  <TableRow
                    key={prospect.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(prospect)}
                  >
                    <TableCell className="font-medium">{prospect.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {prospect.domain ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {prospect.currentScore?.score ?? "—"}
                    </TableCell>
                    <TableCell>
                      <BandBadge band={prospect.currentScore?.band ?? null} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[prospect.locality, prospect.country].filter(Boolean).join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ProspectDrawer
        orgId={orgId}
        orgSlug={orgSlug}
        prospect={selected}
        onClose={() => setSelected(null)}
        onChanged={() => setRefreshToken((t) => t + 1)}
      />
    </div>
  );
}

// --- Filters ----------------------------------------------------------------

function Filters({
  filters,
  onChange,
}: {
  filters: ProspectFilterState;
  onChange: (next: ProspectFilterState) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label className="text-xs">Band</Label>
        <Select
          value={filters.band || "all"}
          onValueChange={(v) => onChange({ ...filters, band: v === "all" ? "" : (v as ProspectFilterState["band"]) })}
        >
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All bands</SelectItem>
            {SCORE_BANDS.map((band) => (
              <SelectItem key={band} value={band}>{band}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Signal</Label>
        <Select
          value={filters.signalKind || "all"}
          onValueChange={(v) =>
            onChange({ ...filters, signalKind: v === "all" ? "" : (v as ProspectFilterState["signalKind"]) })
          }
        >
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any signal</SelectItem>
            {SIGNAL_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>{kind}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasActiveFilters(filters) ? (
        <Button variant="ghost" onClick={() => onChange(EMPTY_FILTERS)}>Reset</Button>
      ) : null}
    </div>
  );
}

// --- Detail drawer ----------------------------------------------------------

function ProspectDrawer({
  orgId,
  orgSlug,
  prospect,
  onClose,
  onChanged,
}: {
  orgId: string;
  orgSlug: string;
  prospect: PublicProspect | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client } = useSession();
  const [signals, setSignals] = React.useState<PublicSignal[] | null>(null);
  const [activities, setActivities] = React.useState<PublicActivity[] | null>(null);
  const [error, setError] = React.useState<ApiErrorShape | null>(null);
  const [rescoring, setRescoring] = React.useState(false);

  const prospectId = prospect?.id ?? null;

  React.useEffect(() => {
    if (!prospectId) return;
    let cancelled = false;
    setSignals(null);
    setActivities(null);
    setError(null);
    void Promise.all([
      wrap(() => client.prospecting.listSignals(orgId, prospectId)),
      wrap(() => client.prospecting.listActivities(orgId, prospectId)),
    ]).then(([signalResult, activityResult]) => {
      if (cancelled) return;
      if (signalResult.ok) setSignals(signalResult.data.signals);
      else setError({ code: signalResult.error.code, message: signalResult.error.message, details: signalResult.error.details });
      if (activityResult.ok) setActivities(activityResult.data.activities);
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId, prospectId]);

  async function rescore() {
    if (!prospectId) return;
    setRescoring(true);
    const result = await wrap(() => client.prospecting.rescore(orgId, prospectId));
    setRescoring(false);
    if (result.ok) onChanged();
    else setError({ code: result.error.code, message: result.error.message, details: result.error.details });
  }

  return (
    <Sheet open={prospect !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {prospect ? (
          <>
            <SheetHeader>
              <SheetTitle>{prospect.name}</SheetTitle>
              <SheetDescription className="font-mono text-xs">
                {prospect.domain ?? "no website found"}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-6 space-y-8">
              <section>
                <h3 className="mb-3 text-sm font-medium">Why this score</h3>
                {prospect.currentScore ? (
                  <ScoreExplainer
                    score={prospect.currentScore.score}
                    band={prospect.currentScore.band}
                    rulesetVersion={prospect.currentScore.rulesetVersion}
                    profileVersion={prospect.currentScore.profileVersion}
                    contributions={prospect.currentScore.contributions}
                    computedAt={prospect.currentScore.computedAt}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Not scored yet. Rescore to compute one from the current observations.
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void rescore()} disabled={rescoring}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {rescoring ? "Rescoring…" : "Rescore"}
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/orgs/${orgSlug}/insights?prospect=${prospect.id}`}>Draft outreach</Link>
                  </Button>
                </div>
                {error ? <div className="mt-3"><ApiErrorNotice error={error} orgSlug={orgSlug} /></div> : null}
              </section>

              <section>
                <h3 className="mb-3 text-sm font-medium">Observations</h3>
                {signals === null ? (
                  <LoadingRows count={3} height="h-8" />
                ) : signals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No observations recorded yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {signals.map((signal) => (
                      <li key={signal.id} className="rounded-md border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs">{signal.kind}</span>
                          <Badge variant="outline" className="text-[10px]">severity {signal.severity}</Badge>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {JSON.stringify(signal.features)}
                        </div>
                        {/* The digest is shown because the payload it came from is not
                            stored: this line is the visible half of that claim. */}
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          derived from {signal.sourceDigest.slice(0, 16)}… · {signal.source}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-3 text-sm font-medium">Timeline</h3>
                {activities === null ? (
                  <LoadingRows count={2} height="h-8" />
                ) : activities.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing has happened to this prospect yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {activities.map((activity) => (
                      <li key={activity.id} className="flex items-start justify-between gap-3 text-sm">
                        <div className="min-w-0">
                          <span className="font-mono text-xs text-muted-foreground">{activity.kind}</span>
                          {activity.body ? <p className="mt-0.5">{activity.body}</p> : null}
                        </div>
                        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {new Date(activity.createdAt).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
