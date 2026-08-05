"use client";

import * as React from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Sparkles, Wand2 } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ApiErrorNotice, BandBadge, LoadingRows, type ApiErrorShape } from "@/components/prospecting/shared";
import { guardrailExplanation, guardrailVariant, sortProspects } from "@/components/prospecting/prospecting";
import type { InsightKind, PublicInsight, PublicProspect } from "@saas/contracts/prospecting";

export default function InsightsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const searchParams = useSearchParams();
  const preselected = searchParams?.get("prospect") ?? null;

  const [prospects, setProspects] = React.useState<PublicProspect[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(preselected);
  const [kind, setKind] = React.useState<InsightKind>("outreach_email");
  const [insights, setInsights] = React.useState<PublicInsight[] | null>(null);
  const [listError, setListError] = React.useState<ApiErrorShape | null>(null);
  const [generateError, setGenerateError] = React.useState<ApiErrorShape | null>(null);
  const [generating, setGenerating] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void wrap(() => client.prospecting.listProspects(orgId, { band: "hot" })).then(async (hot) => {
      // Prefer hot prospects — they are what a rep would draft for first — but
      // fall back to the whole board so the page is never empty by accident.
      const result = hot.ok && hot.data.prospects.length > 0
        ? hot
        : await wrap(() => client.prospecting.listProspects(orgId, {}));
      if (cancelled) return;
      if (result.ok) {
        const sorted = sortProspects(result.data.prospects);
        setProspects(sorted);
        setSelectedId((current) => current ?? sorted[0]?.id ?? null);
      } else {
        setListError({ code: result.error.code, message: result.error.message, details: result.error.details });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  const loadInsights = React.useCallback(
    async (prospectId: string) => {
      setInsights(null);
      const result = await wrap(() => client.prospecting.listInsights(orgId, prospectId));
      if (result.ok) setInsights(result.data.insights);
      else setListError({ code: result.error.code, message: result.error.message, details: result.error.details });
    },
    [client, orgId],
  );

  React.useEffect(() => {
    if (selectedId) void loadInsights(selectedId);
  }, [selectedId, loadInsights]);

  const selected = prospects?.find((p) => p.id === selectedId) ?? null;

  async function generate() {
    if (!selectedId) return;
    setGenerating(true);
    setGenerateError(null);
    const result = await wrap(() => client.prospecting.generateInsight(orgId, selectedId, { kind }));
    setGenerating(false);
    if (result.ok) await loadInsights(selectedId);
    else setGenerateError({ code: result.error.code, message: result.error.message, details: result.error.details });
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Insights</h1>
        <p className="text-sm text-muted-foreground">
          Drafts written from a prospect&apos;s score and the observations behind it. The model cannot move the
          number and cannot cite anything it was not given — every draft carries the guardrail&apos;s verdict.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-muted-foreground" /> Generate
          </CardTitle>
          <CardDescription>
            A repeat request for an unchanged prospect replays the stored draft and costs nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {listError ? (
            <ApiErrorNotice error={listError} orgSlug={orgSlug} />
          ) : prospects === null ? (
            <LoadingRows count={2} height="h-9" />
          ) : prospects.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No prospects to write about"
              description="Run a discovery first — a draft is written from a score, and a score is written from observations."
              primaryAction={{ label: "Run a discovery", href: `/orgs/${orgSlug}/discover` }}
            />
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Prospect</Label>
                <Select value={selectedId ?? ""} onValueChange={setSelectedId}>
                  <SelectTrigger className="w-72"><SelectValue placeholder="Choose a prospect" /></SelectTrigger>
                  <SelectContent>
                    {prospects.map((prospect) => (
                      <SelectItem key={prospect.id} value={prospect.id}>
                        {prospect.name}
                        {prospect.currentScore ? ` · ${prospect.currentScore.score}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as InsightKind)}>
                  <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="outreach_email">Outreach email</SelectItem>
                    <SelectItem value="prospect_summary">Prospect summary</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button onClick={() => void generate()} disabled={generating || !selectedId}>
                {generating ? "Writing…" : "Generate"}
              </Button>

              {selected?.currentScore ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="tabular-nums font-medium text-foreground">{selected.currentScore.score}</span>
                  <BandBadge band={selected.currentScore.band} />
                </div>
              ) : null}
            </div>
          )}

          {generateError ? <ApiErrorNotice error={generateError} orgSlug={orgSlug} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {selected ? `Drafts for ${selected.name}` : "Drafts"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!selectedId ? (
            <EmptyState icon={Sparkles} title="Choose a prospect" description="Pick one above to see its drafts." />
          ) : insights === null ? (
            <LoadingRows count={2} height="h-24" />
          ) : insights.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No drafts yet"
              description="Generate one above. It will be written only from what was observed about this business."
            />
          ) : (
            <ul className="space-y-4">
              {insights.map((insight) => (
                <li key={insight.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">{insight.kind}</Badge>
                    <Badge variant={guardrailVariant(insight.guardrailVerdict)} className="text-[10px]">
                      guardrail: {insight.guardrailVerdict}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {insight.model ?? "unknown model"} · {new Date(insight.createdAt).toLocaleString()}
                    </span>
                    <div className="ml-auto">
                      <CopyButton value={insight.content} />
                    </div>
                  </div>

                  <p className="mt-3 whitespace-pre-wrap text-sm">{insight.content}</p>

                  <p className="mt-3 text-xs text-muted-foreground">
                    {guardrailExplanation(insight.guardrailVerdict, insight.guardrailNotes.length)}
                  </p>

                  {insight.guardrailNotes.length > 0 ? (
                    // Showing the edits is the feature. A draft changed
                    // silently would be worse than one refused outright.
                    <ul className="mt-2 space-y-1">
                      {insight.guardrailNotes.map((note, index) => (
                        <li key={`${note.check}-${index}`} className="text-xs text-muted-foreground">
                          <span className="font-mono">{note.check}</span> · {note.action} · {note.detail}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
