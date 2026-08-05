# prospecting — Market context

Why this epic exists, what the buyer is actually buying, and what has to be in
the envelope alongside the code.

> Sourced from the shortlist analysis in `~/sourceplane/orun-upwork-top5.md`
> (prepared 3 Aug 2026). Upwork disallows automated fetching, so the figures
> below are as recorded at that time and should be re-checked in the browser
> before a proposal is sent.

## The originating job

**"Full-Stack Developer for SaaS MVP" (LeadPilot)** — ranked #2 of five and
selected as the **flagship** demo build.

- **Link:** https://www.upwork.com/jobs/Full-Stack-Developer-for-span-class-highlight-SaaS-span-span-class-highlight-MVP-span_~022082540505112874517/
- **Budget:** $10,000 fixed — the largest genuine budget in the shortlist
- **Posted:** 30 Jul 2026 · 50+ proposals · 2 interviewing · last viewed 4 days ago
- **Client:** Italy; payment and phone verified; 1 job posted, 0% hire rate,
  member since 26 Jul 2026 — a funded founder writing his first brief
- **Connects:** 16

**What he says he wants:** an MVP for LeadPilot, a B2B SaaS helping web
agencies and freelancers discover potential customers by analysing business
signals and generating outreach suggestions. Auth, business discovery,
opportunity scoring, AI-generated insights, pipeline management. Milestones.
*"Source code and infrastructure ownership retained by me."*

**What he actually wants**, from three tells in the post:

1. **$10,000 with one job posted and zero hires.** The money is real; the
   process is naive. 50+ proposals have already buried him and he has
   interviewed 2 in 5 days. He is drowning in identical "8 years of
   experience" pitches.
2. **The skill tags say JavaScript, HTML5, CSS3, jQuery** — auto-tagged, which
   means he cannot evaluate technical claims. He will decide on evidence he can
   see with his own eyes.
3. **"Source code and infrastructure ownership retained by me"** is the
   sentence of someone who has heard horror stories about agencies holding a
   product hostage.

So the winning move is not a better pitch. It is a working LeadPilot-shaped
product he can click, plus proof that *he* owns it.

## Why this shape wins

Structural coverage, not rhetoric. Roughly 75% of the brief is platform that is
already live per environment:

| Brief requirement | Status |
|---|---|
| Auth, users, sessions | shipped |
| Agencies as tenants, seats, invitations | shipped |
| Roles and permissions | shipped |
| Usage limits on discovery and AI credits | shipped — and critical here: discovery credits *are* the commercial model |
| Plans, subscriptions, checkout | shipped, live end to end |
| Audit and activity history | shipped |
| Transactional email and preferences | shipped |
| Console shell, org switching, settings, billing UI | shipped |
| Business discovery, signals, scoring, insights, pipeline | **this epic** |

The reference product born from the same baseline needed roughly 6,000 lines to
turn the platform into a product: one worker, eleven migrations totalling ~216
SQL lines, one contracts module, an ~89-LOC edge facade, four console route
groups, and a test package. This epic is scoped to that same ratio.

## What goes in the envelope

The code is one of four artefacts. Consistency across all four is what makes it
read as a productised service rather than a freelancer improvising.

1. **The live product** — `https://signalpilot.orun.dev`, with a seeded demo
   tenant and credentials **in the proposal body**, not "happy to share on
   request". One line on what to try first. This is SP8.
2. **The workspace** — a read-only Orun Cloud workspace link showing the
   component catalog with typed relations, the docs set pinned to a commit,
   real deployment history, and the integrations/secrets/config/flags/usage
   surfaces. Framed in one sentence: *"this is the operations console you get
   on day one, not a status page I made for this proposal."*
3. **The onboarding pack** — `docs/{overview,architecture,runbook}.md`,
   `ai/context/{deployment,operations}.md`, plus per-client `ONBOARDING.md` and
   `HANDOVER.md`/`EXIT.md`.
4. **The cover letter** — four short paragraphs, live URL and login in
   paragraph one because Upwork truncates previews at about two lines. Then two
   sentences proving the post was read (quote the ownership clause). Then
   what is already solved versus what is genuinely new, in three lines. Then
   his own questions answered literally, in his order.

**Answer the ownership anxiety first**, because nobody else will: repo in his
GitHub org from commit one; Cloudflare and Supabase provisioned into his
accounts by Terraform; an `EXIT.md` he did not ask for.

**Pricing.** Bid at or slightly above $10,000 across four milestones mapped to
the SP clusters. Do not discount — a first-time client who discounted his first
hire never respects the second invoice.

**Risk.** Unproven payer, 50+ proposals. Apply immediately; lead with the live
URL in the first line.

## The other four in the shortlist

This epic is the flagship because its shape — a metered B2B SaaS with a
pipeline UI — produces the most reusable screenshot set. The other four are
built as thin verticals (one headline workflow each) on the same baseline.

| # | Job | Budget | Link |
|---|-----|--------|------|
| 1 | TaxViewr — Senior Full-Stack TypeScript Engineer, sales tax compliance | $2,500 (wedge into $9–12K) | https://www.upwork.com/jobs/Senior-Full-Stack-TypeScript-Engineer-Sales-Tax-Compliance-Platform-Hard-Deadline-Sept_~022083385915536323194/ |
| 2 | **LeadPilot — Full-Stack Developer for SaaS MVP** | **$10,000** | https://www.upwork.com/jobs/Full-Stack-Developer-for-span-class-highlight-SaaS-span-span-class-highlight-MVP-span_~022082540505112874517/ |
| 3 | Prima Assets — investment marketplace (Next.js + Supabase + Sanity) | $3,500 (+$5K sibling job) | https://www.upwork.com/jobs/Senior-Full-Stack-Developer-Team-Investment-Marketplace-Platform-Next-span-class-highlight-Supabase-span-Sanity_~022083609979342656667/ |
| 4 | Hexona — multi-tenant white-label fintech SaaS | $4,000 (+channel) | https://www.upwork.com/jobs/Multi-Tenant-Fintech-span-class-highlight-SaaS-span_~022079584437221826762/ |
| 5 | AUSTRAC AML/CTF — multi-tenant compliance SaaS | audit $1.2–1.8K → replatform | https://www.upwork.com/jobs/Full-Stack-Engineer-Multi-Tenant-Compliance-span-class-highlight-SaaS-span-Next-TypeScript-span-class-highlight-Supabase-span_~022083729748137972891/ |

Connects required across all five: 92 against 88 available at the time of the
analysis — a small top-up is needed to send the full batch.
