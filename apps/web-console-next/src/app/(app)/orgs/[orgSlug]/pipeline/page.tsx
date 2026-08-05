"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Clock, KanbanSquare } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
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
import { STUCK_DAYS, buildBoard, isStuck, stageIsTerminal } from "@/components/prospecting/prospecting";
import type { GetPipelineResponse, PipelineBoardEntry } from "@saas/contracts/prospecting";

export default function PipelinePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const [board, setBoard] = React.useState<GetPipelineResponse | null>(null);
  const [error, setError] = React.useState<ApiErrorShape | null>(null);
  const [moving, setMoving] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await wrap(() => client.prospecting.getPipeline(orgId));
    if (result.ok) {
      setBoard(result.data);
      setError(null);
    } else {
      setError({ code: result.error.code, message: result.error.message, details: result.error.details });
    }
  }, [client, orgId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const move = React.useCallback(
    async (entryId: string, stageKey: string) => {
      setMoving(entryId);
      const result = await wrap(() => client.prospecting.updateEntry(orgId, entryId, { stageKey }));
      setMoving(null);
      if (result.ok) await load();
      else setError({ code: result.error.code, message: result.error.message, details: result.error.details });
    },
    [client, orgId, load],
  );

  const columns = board ? buildBoard(board.stages, board.entries) : [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Drag a card to move it, or use the stage picker on the card. A card sitting in one stage for{" "}
          {STUCK_DAYS} days or more is highlighted.
        </p>
      </header>

      {error ? <ApiErrorNotice error={error} orgSlug={orgSlug} /> : null}

      {board === null && !error ? (
        <LoadingRows count={4} height="h-24" />
      ) : board && board.entries.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title="Nothing on the board"
          description="Add a prospect to the pipeline from the prospects table to start working it."
          primaryAction={{ label: "Go to prospects", href: `/orgs/${orgSlug}/prospects` }}
        />
      ) : board ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <section
              key={column.stage.id}
              className={`w-72 shrink-0 rounded-lg border p-3 transition-colors ${
                dragOver === column.stage.key ? "border-primary bg-primary/5" : "bg-muted/30"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(column.stage.key);
              }}
              onDragLeave={() => setDragOver((current) => (current === column.stage.key ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(null);
                const entryId = event.dataTransfer.getData("text/plain");
                if (entryId) void move(entryId, column.stage.key);
              }}
            >
              <header className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium">{column.stage.label}</h2>
                  {stageIsTerminal(column.stage) ? (
                    <Badge variant="outline" className="text-[10px]">{column.stage.outcome}</Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                  {column.stuckCount > 0 ? (
                    <Badge variant="destructive" className="text-[10px]">
                      {column.stuckCount} stuck
                    </Badge>
                  ) : null}
                  <span className="text-xs tabular-nums text-muted-foreground">{column.entries.length}</span>
                </div>
              </header>

              <div className="space-y-2">
                {column.entries.length === 0 ? (
                  <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                    Drop a card here
                  </p>
                ) : (
                  column.entries.map((entry) => (
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      stages={board.stages.map((s) => ({ key: s.key, label: s.label }))}
                      busy={moving === entry.id}
                      onMove={(stageKey) => void move(entry.id, stageKey)}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EntryCard({
  entry,
  stages,
  busy,
  onMove,
}: {
  entry: PipelineBoardEntry;
  stages: Array<{ key: string; label: string }>;
  busy: boolean;
  onMove: (stageKey: string) => void;
}) {
  const stuck = isStuck(entry);
  return (
    <article
      draggable={!busy}
      onDragStart={(event) => event.dataTransfer.setData("text/plain", entry.id)}
      className={`space-y-2 rounded-md border bg-background p-3 shadow-sm ${
        stuck ? "border-destructive/50" : ""
      } ${busy ? "opacity-50" : "cursor-grab active:cursor-grabbing"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{entry.prospectName}</div>
          {entry.prospectDomain ? (
            <div className="truncate font-mono text-[11px] text-muted-foreground">{entry.prospectDomain}</div>
          ) : null}
        </div>
        {entry.score !== null ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-sm font-semibold tabular-nums">{entry.score}</span>
            <BandBadge band={entry.band} />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className={`inline-flex items-center gap-1 ${stuck ? "text-destructive" : ""}`}>
          <Clock className="h-3 w-3" />
          {entry.daysInStage}d in stage
        </span>
        {entry.valueCents !== null ? (
          <span className="tabular-nums">{(entry.valueCents / 100).toLocaleString()}</span>
        ) : null}
      </div>

      {/* The stage picker is not a fallback for the drag — it is the keyboard
          and touch path to the same action, and both go through one handler. */}
      <Select value={entry.stageKey} onValueChange={onMove} disabled={busy}>
        <SelectTrigger className="h-8 text-xs" aria-label={`Move ${entry.prospectName}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {stages.map((stage) => (
            <SelectItem key={stage.key} value={stage.key}>{stage.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </article>
  );
}
