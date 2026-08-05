import Link from "next/link";
import type { Metadata } from "next";
import { DEFAULT_SIGNAL_WEIGHTS, SIGNAL_KINDS } from "@saas/contracts/prospecting";
import { PRODUCT_NAME } from "@/lib/app-config";

/**
 * The public storefront. The only unauthenticated ingress in the product.
 *
 * A server component with no client JS: it renders from the contracts module,
 * so the weights table on this page is the *same* table the engine scores
 * with. A marketing page that drifts from the product is the cheapest possible
 * way to lose the credibility the page exists to build.
 */
export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — find the businesses whose websites are costing them customers`,
  description:
    "Discover local businesses, see exactly what is wrong with their web presence, and get a defensible score with a reason for every point.",
};

const STEPS = [
  {
    title: "Discover",
    body: "Give it a place and a trade. It comes back with businesses and what is observably wrong with each one — no valid HTTPS, six-second loads, no way to book.",
  },
  {
    title: "Score",
    body: "A versioned rules engine turns those observations into a number, and stores the reason for every point. The same evidence always produces the same score.",
  },
  {
    title: "Explain",
    body: "The draft is written from the score and the observations, and nothing else. It cannot invent a fact, a contact, or a different number.",
  },
  {
    title: "Work",
    body: "Assign it, move it through your stages, and see at a glance what has been sitting still too long.",
  },
];

export default function StorefrontPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              S
            </div>
            <span className="text-base font-semibold tracking-tight">{PRODUCT_NAME}</span>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/login" className="text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
            <Link
              href="/signalpilot/signup"
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
            >
              Start free
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-6 py-20">
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Find the businesses whose websites are costing them customers.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
            {PRODUCT_NAME} finds local businesses, records what is measurably wrong with their web
            presence, and scores the opportunity — with a reason attached to every point, so you can open
            the conversation with something they can check themselves.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signalpilot/signup"
              className="rounded-md bg-primary px-5 py-2.5 font-medium text-primary-foreground"
            >
              Start free — 100 discoveries a month
            </Link>
            <Link href="/login" className="rounded-md border px-5 py-2.5 font-medium">
              Sign in
            </Link>
          </div>
        </section>

        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">A score you can defend</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              A list of businesses with a mystery number attached is a spreadsheet. Every score here is
              the sum of named, checkable observations — and the console shows you the arithmetic.
            </p>

            <div className="mt-8 overflow-x-auto">
              <table className="w-full max-w-2xl text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 font-medium">What we look for</th>
                    <th className="py-2 text-right font-medium">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {SIGNAL_KINDS.map((kind) => (
                    <tr key={kind} className="border-b last:border-0">
                      <td className="py-2 font-mono text-xs">{kind}</td>
                      <td className="py-2 text-right tabular-nums">{DEFAULT_SIGNAL_WEIGHTS[kind]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
              These are the defaults. You can retune any of them for your own book of business — and old
              scores keep the weights that produced them, so nothing changes retroactively.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <div className="mt-8 grid gap-8 sm:grid-cols-2">
            {STEPS.map((step, index) => (
              <div key={step.title}>
                <div className="text-sm font-mono text-muted-foreground">0{index + 1}</div>
                <h3 className="mt-1 text-lg font-medium">{step.title}</h3>
                <p className="mt-2 text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">What we do not keep</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              We look at a business&apos;s public website and keep the derived facts — a load time, whether a
              booking flow exists, how old the content is. The page itself is read and dropped in the same
              request; what remains is a hash proving which page the reading came from.
            </p>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              We hold business records only. No names, no personal email addresses, no phone numbers — and
              the AI drafting is blocked from inventing any.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Plans</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {[
              { name: "Free", price: "£0", discoveries: "100", insights: "10", seats: "1" },
              { name: "Starter", price: "£20", discoveries: "1,000", insights: "200", seats: "3" },
              { name: "Growth", price: "£99", discoveries: "10,000", insights: "2,000", seats: "10" },
            ].map((plan) => (
              <div key={plan.name} className="rounded-lg border p-6">
                <div className="text-lg font-medium">{plan.name}</div>
                <div className="mt-2 text-3xl font-semibold tracking-tight">
                  {plan.price}
                  <span className="text-base font-normal text-muted-foreground">/mo</span>
                </div>
                <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
                  <li>{plan.discoveries} discoveries a month</li>
                  <li>{plan.insights} AI drafts a month</li>
                  <li>
                    {plan.seats} {plan.seats === "1" ? "seat" : "seats"}
                  </li>
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted-foreground">
            Every plan includes the full product. The difference is how much of it you use in a month.
          </p>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground">
          <span>
            {PRODUCT_NAME} — built on the {PRODUCT_NAME} platform.
          </span>
          <Link href="/signalpilot/signup" className="hover:text-foreground">
            Start free
          </Link>
        </div>
      </footer>
    </div>
  );
}
