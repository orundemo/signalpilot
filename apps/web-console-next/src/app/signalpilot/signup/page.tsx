"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PRODUCT_NAME } from "@/lib/app-config";

/**
 * Self-serve signup into the Free plan.
 *
 * This is deliberately a redirect rather than a second identity form. The
 * platform already owns magic-link and OAuth sign-in at `/login`, and
 * `/onboarding` already creates the first organization — which the billing
 * worker bootstraps onto the default (Free) plan. A separate signup form here
 * would be a second copy of an authentication flow, which is exactly the kind
 * of duplication that drifts and then quietly breaks.
 *
 * What this page adds is the storefront's promise, stated once more at the
 * moment of commitment, and the hand-off.
 */
export default function SignupPage() {
  const router = useRouter();

  React.useEffect(() => {
    const timer = setTimeout(() => router.push("/login?next=/onboarding"), 1200);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Start with {PRODUCT_NAME} Free</h1>
        <p className="mt-3 text-muted-foreground">
          100 discoveries and 10 AI drafts a month. No card. We&apos;ll sign you in first, then create your
          workspace.
        </p>
        <p className="mt-6 text-sm text-muted-foreground">Taking you to sign-in…</p>
        <Link href="/login?next=/onboarding" className="mt-4 inline-block text-sm underline">
          Continue now
        </Link>
      </div>
    </div>
  );
}
