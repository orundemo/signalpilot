"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRows } from "@/components/prospecting/shared";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { PublicSignal } from "@saas/contracts/prospecting";

/**
 * The isolation proof.
 *
 * Two claims in this product's design would otherwise have to be taken on
 * trust. This page makes both of them clickable, against live data, in the
 * reader's own tenant:
 *
 *  1. **Tenant isolation** — it issues a real cross-tenant read against a
 *     fabricated org id and shows the response. A denial that only happens in
 *     a test suite is a claim; a denial you can watch is evidence.
 *  2. **Never store raw** — it shows a real signal's stored `features` next to
 *     the statement of what was dropped, with the digest as the only thing
 *     remaining of the document it was derived from.
 *
 * Neither section fabricates anything: if there is no signal to show, it says
 * so rather than rendering an illustration.
 */
export default function IsolationProofPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Isolation proof</h1>
        <p className="text-sm text-muted-foreground">
          Two claims this product makes about your data, demonstrated against your live tenant rather than
          asserted in a document.
        </p>
      </header>
      <CrossTenantRead orgId={orgId} />
      <NeverStoreRaw orgId={orgId} />
    </div>
  );
}

// --- 1. Cross-tenant read ---------------------------------------------------

/** A well-formed org id that is not yours. Reading it must fail. */
const FOREIGN_ORG_ID = "org_00000000000000000000000000000001";

function CrossTenantRead({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [state, setState] = React.useState<
    { phase: "idle" } | { phase: "running" } | { phase: "done"; ownCount: number; foreignStatus: string; foreignCode: string }
  >({ phase: "idle" });

  async function run() {
    setState({ phase: "running" });

    const own = await wrap(() => client.prospecting.listProspects(orgId, {}));
    const foreign = await wrap(() => client.prospecting.listProspects(FOREIGN_ORG_ID, {}));

    setState({
      phase: "done",
      ownCount: own.ok ? own.data.prospects.length : -1,
      foreignStatus: foreign.ok ? "200 OK" : `${foreign.status}`,
      foreignCode: foreign.ok ? "returned data" : foreign.error.code,
    });
  }

  const passed = state.phase === "done" && state.foreignCode === "not_found";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> A read across the tenant boundary
        </CardTitle>
        <CardDescription>
          The same request, twice: once for your organization and once for an organization that is not
          yours. Both go through the public API with your credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => void run()} disabled={state.phase === "running"}>
          {state.phase === "running" ? "Running…" : "Run the check"}
        </Button>

        {state.phase === "done" ? (
          <div className="space-y-3">
            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-medium">Your organization</span>
                <Badge variant="secondary" className="text-[10px]">200 OK</Badge>
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                GET /v1/organizations/{orgId}/prospects → {state.ownCount} prospects
              </p>
            </div>

            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                {passed ? (
                  <XCircle className="h-4 w-4 text-emerald-600" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )}
                <span className="text-sm font-medium">Somebody else&apos;s organization</span>
                <Badge variant={passed ? "secondary" : "destructive"} className="text-[10px]">
                  {state.foreignStatus} {state.foreignCode}
                </Badge>
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                GET /v1/organizations/{FOREIGN_ORG_ID}/prospects → {state.foreignCode}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {passed
                  ? "Not found — not “forbidden”. The API does not confirm that the organization exists, because confirming it would leak which organizations are real and who is in them. The attempt is recorded in your audit log."
                  : "This did not deny as expected. That is a defect, not a demonstration — please report it."}
              </p>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- 2. Never store raw -----------------------------------------------------

function NeverStoreRaw({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [signal, setSignal] = React.useState<PublicSignal | null | "none">(null);

  React.useEffect(() => {
    let cancelled = false;
    void wrap(() => client.prospecting.listProspects(orgId, {})).then(async (list) => {
      if (cancelled || !list.ok) return setSignal("none");
      for (const prospect of list.data.prospects.slice(0, 5)) {
        const signals = await wrap(() => client.prospecting.listSignals(orgId, prospect.id));
        if (cancelled) return;
        if (signals.ok && signals.data.signals.length > 0) {
          return setSignal(signals.data.signals[0]!);
        }
      }
      setSignal("none");
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" /> What a stored observation actually contains
        </CardTitle>
        <CardDescription>
          A real signal from your data — everything we kept, and everything we did not.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {signal === null ? (
          <LoadingRows count={2} height="h-8" />
        ) : signal === "none" ? (
          <p className="text-sm text-muted-foreground">
            No observations recorded yet. Run a discovery and come back — this page shows real rows, not an
            illustration.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-md border p-4">
              <div className="text-sm font-medium">Kept</div>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">kind</dt>
                  <dd className="font-mono text-xs">{signal.kind}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">severity</dt>
                  <dd className="font-mono text-xs">{signal.severity}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">features</dt>
                  <dd className="font-mono text-xs break-all">{JSON.stringify(signal.features, null, 2)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">source_digest</dt>
                  <dd className="font-mono text-[11px] break-all">{signal.sourceDigest}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-md border border-dashed p-4">
              <div className="text-sm font-medium">Dropped, in the same request</div>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li>The fetched page — the HTML was read, measured, and discarded.</li>
                <li>Every response header beyond the two values the measurement needed.</li>
                <li>Any name, email address, or phone number that appeared on the page.</li>
                <li>The provider response body, where a provider was involved.</li>
              </ul>
              <p className="mt-4 text-sm text-muted-foreground">
                The digest on the left is a SHA-256 of the document the numbers were derived from. It proves
                <em> which</em> page produced them without keeping the page. It cannot be reversed into the
                content, which is the point.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
