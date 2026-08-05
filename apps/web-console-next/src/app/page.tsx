"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { readStoredToken } from "@/lib/session";
import { readLastOrgSlug, entryDestination } from "@/lib/last-org";

/**
 * App entry. Sends the operator to their last-used org (if remembered) so
 * returning visits land in a working org scope; otherwise to /onboarding, which
 * forwards to an existing org or creates the first one — and to the storefront
 * when there's no session at all. localStorage is client-only, so this resolves
 * on the client and replaces history (no extra entry).
 */
export default function HomePage() {
  const router = useRouter();
  React.useEffect(() => {
    router.replace(entryDestination(Boolean(readStoredToken()), readLastOrgSlug()));
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}
