// Instance identity for the web console (saas-bootstrap-factory BF3 seam).
//
// Branding strings, deployment hostnames, contact addresses, and storage-key
// namespaces live here so a new instance of the starter retargets one file.
// Do not add behavior — values and trivial derivations only.

/** Product/brand name shown across the console. */
export const PRODUCT_NAME = "SignalPilot";

/** Browser/document title of the console. */
export const CONSOLE_TITLE = `${PRODUCT_NAME} Console`;

/** Marketing-facing product description (document metadata). */
export const PRODUCT_DESCRIPTION =
  "Find local businesses whose websites are costing them customers, scored with a reason behind every point.";

/**
 * Where a signed-out visitor to the app root lands.
 *
 * The storefront, not the login form: the root URL is the product's front door,
 * and a bare credential prompt tells a first-time visitor nothing about what
 * they would be signing in to. The storefront carries its own "Sign in" link.
 */
export const PUBLIC_LANDING_PATH = "/signalpilot";

/** The Cloudflare account's workers.dev subdomain serving this instance. */
export const WORKERS_DEV_SUBDOMAIN = "orundemo";

/** api-edge workers.dev URL for a given environment name. */
export function apiEdgeWorkersDevUrl(environment: string): string {
  return `https://signalpilot-api-edge-${environment}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
}

/** Sales contact surfaced by the billing upgrade UX. */
export const SALES_EMAIL = "sales@sourceplane.ai";

/** Namespace prefix for console localStorage keys. */
export const STORAGE_PREFIX = "signalpilot.next";
