# web-console-next

Next.js 15 + opennextjs/cloudflare delivery of the SignalPilot web console (per-environment, Workers + Static Assets)

The signalpilot console UI — Next.js compiled to a Cloudflare Worker with
Static Assets, configured against the API edge. Public at
`https://signalpilot-web-console-next-{stage,prod}.orundemo.workers.dev`.

## Depends on

- **api-edge** — Cloudflare Worker for the API edge Runtime
