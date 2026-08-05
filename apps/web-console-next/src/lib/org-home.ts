/**
 * Where an organization's scope "lands".
 *
 * Every surface that sends someone into an org — the org list, the two org
 * switchers, the post-create redirect, the Settings back button, the post-auth
 * destination, the app root — has to answer the same question, and each of them
 * used to answer it by writing `/orgs/${slug}/projects` inline. When the home
 * surface changed, six call sites had to change with it; the one that didn't
 * would send the operator to a page the API suppresses.
 *
 * So the answer lives here, once. Dependency-free and not a client module, so
 * anything can import it.
 */

/** The org's home surface: the board, which is what the operator came for. */
export function orgHomePath(orgSlug: string): string {
  return `/orgs/${orgSlug}/prospects`;
}
