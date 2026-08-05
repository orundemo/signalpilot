"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Radar, Search } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
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
import { ApiErrorNotice, LoadingRows, type ApiErrorShape } from "@/components/prospecting/shared";
import { isRunTerminal, runSummary } from "@/components/prospecting/prospecting";
import type { PublicDiscoveryRun } from "@saas/contracts/prospecting";

const POLL_MS = 2500;

export default function DiscoverPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Discover</h1>
        <p className="text-sm text-muted-foreground">
          Find businesses and record what is wrong with their web presence. Every run is metered on the
          prospects it creates, not the candidates it examines.
        </p>
      </header>

      <QueryBuilder
        orgId={orgId}
        orgSlug={orgSlug}
        onStarted={(id) => {
          setActiveRunId(id);
          setRefreshToken((t) => t + 1);
        }}
      />

      {activeRunId ? (
        <ActiveRun orgId={orgId} orgSlug={orgSlug} runId={activeRunId} onFinished={() => setRefreshToken((t) => t + 1)} />
      ) : null}

      <RunHistory orgId={orgId} orgSlug={orgSlug} refreshToken={refreshToken} />
    </div>
  );
}

// --- Query builder ----------------------------------------------------------

function QueryBuilder({
  orgId,
  orgSlug,
  onStarted,
}: {
  orgId: string;
  orgSlug: string;
  onStarted: (runId: string) => void;
}) {
  const { client } = useSession();
  const [adapter, setAdapter] = React.useState<"synthetic" | "web-signals">("synthetic");
  const [location, setLocation] = React.useState("");
  const [industry, setIndustry] = React.useState("");
  const [domains, setDomains] = React.useState("");
  const [limit, setLimit] = React.useState("25");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiErrorShape | null>(null);

  const domainList = domains
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  // `web-signals` observes domains you name; it does not find businesses.
  const needsDomains = adapter === "web-signals" && domainList.length === 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await wrap(() =>
      client.prospecting.runDiscovery(orgId, {
        adapter,
        ...(location ? { location } : {}),
        ...(industry ? { industry } : {}),
        ...(domainList.length > 0 ? { domains: domainList } : {}),
        limit: Number(limit) || 25,
      }),
    );
    setSubmitting(false);
    if (result.ok) onStarted(result.data.discovery.id);
    else setError({ code: result.error.code, message: result.error.message, details: result.error.details });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" /> New discovery
        </CardTitle>
        <CardDescription>
          {adapter === "synthetic"
            ? "The synthetic corpus produces a realistic mix of businesses for evaluation and demos."
            : "Web signals observes the domains you name — one bounded fetch each, no crawling."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid grid-cols-1 gap-3 sm:grid-cols-4" onSubmit={submit}>
          <div className="space-y-1">
            <Label className="text-xs">Source</Label>
            <Select value={adapter} onValueChange={(v) => setAdapter(v as "synthetic" | "web-signals")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="synthetic">Synthetic corpus</SelectItem>
                <SelectItem value="web-signals">Web signals</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="location" className="text-xs">Location</Label>
            <Input id="location" placeholder="Leeds" value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="industry" className="text-xs">Industry</Label>
            <Input id="industry" placeholder="plumbing" value={industry} onChange={(e) => setIndustry(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="limit" className="text-xs">Limit</Label>
            <Input id="limit" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>

          {adapter === "web-signals" ? (
            <div className="space-y-1 sm:col-span-4">
              <Label htmlFor="domains" className="text-xs">Domains</Label>
              <Input
                id="domains"
                placeholder="bakery.example, ridgeway.example"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Comma or space separated. This adapter observes what you name rather than searching.
              </p>
            </div>
          ) : null}

          <div className="sm:col-span-4">
            <Button type="submit" disabled={submitting || needsDomains}>
              {submitting ? "Starting…" : "Run discovery"}
            </Button>
          </div>
        </form>

        {error ? <ApiErrorNotice error={error} orgSlug={orgSlug} /> : null}
      </CardContent>
    </Card>
  );
}

// --- Active run -------------------------------------------------------------

function ActiveRun({
  orgId,
  orgSlug,
  runId,
  onFinished,
}: {
  orgId: string;
  orgSlug: string;
  runId: string;
  onFinished: () => void;
}) {
  const { client } = useSession();
  const [run, setRun] = React.useState<PublicDiscoveryRun | null>(null);
  const [error, setError] = React.useState<ApiErrorShape | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      const result = await wrap(() => client.prospecting.getDiscovery(orgId, runId));
      if (cancelled) return;
      if (!result.ok) {
        setError({ code: result.error.code, message: result.error.message, details: result.error.details });
        return;
      }
      setRun(result.data.discovery);
      if (isRunTerminal(result.data.discovery.status)) {
        onFinished();
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `onFinished` is intentionally excluded from the dependency list: it
    // changes identity on every parent render and would restart the poll loop
    // each time.
  }, [client, orgId, runId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Current run</CardTitle>
        <CardDescription className="font-mono text-xs">{runId}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <ApiErrorNotice error={error} orgSlug={orgSlug} />
        ) : !run ? (
          <LoadingRows count={1} height="h-8" />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge variant={run.status === "failed" ? "destructive" : run.status === "completed" ? "secondary" : "outline"}>
                {run.status}
              </Badge>
              <span className="text-sm text-muted-foreground">{runSummary(run)}</span>
            </div>
            {isRunTerminal(run.status) && run.prospectsCreated + run.prospectsUpdated > 0 ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/orgs/${orgSlug}/prospects`}>View prospects</Link>
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --- Run history ------------------------------------------------------------

function RunHistory({ orgId, orgSlug, refreshToken }: { orgId: string; orgSlug: string; refreshToken: number }) {
  const { client } = useSession();
  const [runs, setRuns] = React.useState<PublicDiscoveryRun[] | null>(null);
  const [error, setError] = React.useState<ApiErrorShape | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    void wrap(() => client.prospecting.listDiscoveries(orgId, { limit: 20 })).then((result) => {
      if (cancelled) return;
      if (result.ok) setRuns(result.data.discoveries);
      else setError({ code: result.error.code, message: result.error.message, details: result.error.details });
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId, refreshToken]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Radar className="h-4 w-4 text-muted-foreground" /> Recent runs
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <ApiErrorNotice error={error} orgSlug={orgSlug} />
        ) : runs === null ? (
          <LoadingRows />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={Radar}
            title="No discoveries yet"
            description="Run one above. A discovery creates prospects, records what is observably wrong with their sites, and scores them."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Signals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(run.startedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{run.adapter}</TableCell>
                  <TableCell>
                    <Badge variant={run.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">
                      {run.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{run.prospectsCreated}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.prospectsUpdated}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.signalsRecorded}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
