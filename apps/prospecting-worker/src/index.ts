import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // `ctx` is threaded through so `POST /discoveries` can finish its run past
    // the 202 in `waitUntil` — the console polls the run for completion.
    return route(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
