/**
 * Which console routes the Solo (M0) profile suppresses.
 *
 * The api-edge is the enforcer — `isSoloSuppressed` there 404s the underlying
 * routes — and the console's job is to not offer a door to a room the edge has
 * locked. The sidebar and the settings rail each already did that with their
 * own inline lists. The command palette did not: it registered Projects, Usage,
 * Members, Invitations, API keys, Webhooks, Audit log, Environments and four
 * Create commands unconditionally, so under Solo ⌘K was a menu of dead links.
 *
 * A predicate over the path, rather than a condition per command, is what makes
 * that hard to get wrong again: a command added later is filtered by where it
 * points, without anyone having to remember the profile exists.
 *
 * Keep in step with `apps/api-edge/src/solo-mode.ts` — the two suppress the same
 * capabilities, one by path and one by API route.
 */

/**
 * Org-scoped first segments the profile hides. `projects` and `usage` are the
 * platform plumbing the sidebar drops; the rest are the collaboration,
 * credential, and developer-integration surfaces the settings rail drops.
 */
const SUPPRESSED_SEGMENTS = new Set([
  "projects",
  "usage",
  "members",
  "invitations",
  "api-keys",
  "webhooks",
  "integrations",
  "audit",
]);

/**
 * True when the Solo profile hides `path`. Accepts query strings, since the
 * Create commands carry `?new=1`.
 *
 * Paths outside `/orgs/...` are never suppressed by this rule — the account
 * surfaces (`/account`, `/account/security`) are exactly the ones Solo keeps.
 */
export function isSoloSuppressedPath(path: string): boolean {
  const [pathname = "", query = ""] = path.split("?");
  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== "orgs") return false;

  // The user is the tenant: never offer a second organization. Listing and
  // reading the personal one stay open, so bare `/orgs` is fine.
  if (segments.length === 1) return new URLSearchParams(query).get("new") === "1";

  // `/orgs/:slug/...` — the org slug is segments[1]; everything after it is the
  // surface. `/settings/members` and `/members` suppress alike, so scan the
  // whole tail rather than only its head.
  return segments.slice(2).some((segment) => SUPPRESSED_SEGMENTS.has(segment));
}
