import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";

/**
 * The two notification templates this context owns.
 *
 * Both are `product` category, which is the category the preferences surface
 * already exposes — so a member who has turned product email off never
 * receives either, with no per-template opt-out to build. That is the point of
 * routing through the platform's category model rather than inventing a
 * prospecting-specific preference.
 *
 * `templateData` carries presentation values only. No signal features, no
 * generated prose, no contact data — an email is the one place this product's
 * data leaves the tenant boundary, so it carries the least it can.
 */
export const PROSPECTING_TEMPLATES = {
  hotProspectDigest: "prospecting.hot_prospects.digest",
  discoveryComplete: "prospecting.discovery.completed",
} as const;

export type ProspectingTemplateKey = (typeof PROSPECTING_TEMPLATES)[keyof typeof PROSPECTING_TEMPLATES];

/**
 * Runs below this size are not worth an email. A rep who asked for ten
 * prospects and is watching the page does not need to be told it finished.
 */
export const DISCOVERY_NOTIFY_THRESHOLD = 25;

export interface HotProspectDigestInput {
  orgPublicId: string;
  recipientUserPublicId: string;
  recipientEmail: string;
  /** Prospects that entered the `hot` band since the last send. */
  newlyHot: Array<{ name: string; score: number }>;
  consoleUrl: string;
}

/**
 * Daily per-org digest of prospects that entered the `hot` band.
 *
 * The subject line carries the count and the top score, because that is the
 * whole decision the recipient makes from the inbox: is this worth opening
 * now. The names are in the body, not the subject — a subject line listing
 * businesses reads as spam to a mail filter and to a person.
 */
export function buildHotProspectDigest(input: HotProspectDigestInput): EnqueueNotificationRequest {
  const top = input.newlyHot.reduce((acc, p) => Math.max(acc, p.score), 0);
  return {
    orgId: input.orgPublicId,
    category: "product",
    templateKey: PROSPECTING_TEMPLATES.hotProspectDigest,
    recipient: {
      channel: "email",
      address: input.recipientEmail,
      subjectKind: "user",
      subjectId: input.recipientUserPublicId,
    },
    templateData: {
      count: input.newlyHot.length,
      topScore: top,
      // A bounded preview: enough to be useful in the body, short enough that
      // a large digest does not become an unbounded payload.
      preview: input.newlyHot
        .slice(0, 5)
        .map((p) => `${p.name} (${p.score})`)
        .join(", "),
      truncated: input.newlyHot.length > 5,
      consoleUrl: input.consoleUrl,
    },
  };
}

export interface DiscoveryCompleteInput {
  orgPublicId: string;
  recipientUserPublicId: string;
  recipientEmail: string;
  adapter: string;
  status: string;
  prospectsCreated: number;
  prospectsUpdated: number;
  signalsRecorded: number;
  consoleUrl: string;
}

/**
 * Sent for runs above `DISCOVERY_NOTIFY_THRESHOLD`, and for failures at any
 * size — a run that stopped early is exactly the one the requester needs to
 * know about, however small it was.
 */
export function buildDiscoveryComplete(input: DiscoveryCompleteInput): EnqueueNotificationRequest {
  return {
    orgId: input.orgPublicId,
    category: "product",
    templateKey: PROSPECTING_TEMPLATES.discoveryComplete,
    recipient: {
      channel: "email",
      address: input.recipientEmail,
      subjectKind: "user",
      subjectId: input.recipientUserPublicId,
    },
    templateData: {
      adapter: input.adapter,
      status: input.status,
      prospectsCreated: input.prospectsCreated,
      prospectsUpdated: input.prospectsUpdated,
      signalsRecorded: input.signalsRecorded,
      consoleUrl: input.consoleUrl,
    },
  };
}

/** Whether a finished run warrants an email at all. */
export function shouldNotifyDiscovery(run: { status: string; prospectsCreated: number }): boolean {
  if (run.status === "failed") return true;
  return run.prospectsCreated >= DISCOVERY_NOTIFY_THRESHOLD;
}
