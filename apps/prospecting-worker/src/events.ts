import type { EventsRepository } from "@saas/db/events";
import type { ProspectingEventType } from "@saas/contracts/prospecting";
import type { Uuid } from "@saas/db/ids";
import type { ActorContext } from "./router.js";

/**
 * Domain events are written to the `events` schema in the same transaction as
 * the mutation that caused them, exactly as `projects-worker` does. This is
 * what makes the audit trail a *consequence* of the write rather than a
 * best-effort side channel that can silently fall behind.
 *
 * `events-worker` reads this log; `webhooks-worker` fans it out. Neither is
 * called from here, so neither can fail a product write.
 */
export interface EmitEventInput {
  type: ProspectingEventType;
  orgId: Uuid;
  actor: ActorContext | null;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  requestId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  /** Human-readable line for the audit console. */
  description: string;
}

export async function emitProspectingEvent(
  repo: EventsRepository,
  input: EmitEventInput,
): Promise<void> {
  const result = await repo.appendEventWithAudit({
    event: {
      id: crypto.randomUUID(),
      type: input.type,
      version: 1,
      source: "prospecting-worker",
      occurredAt: input.occurredAt,
      // A run that completes in `waitUntil` has no live actor; the platform
      // vocabulary for that is a system actor, not a fabricated user.
      actorType: input.actor?.subjectType ?? "system",
      actorId: input.actor?.subjectId ?? "system",
      orgId: input.orgId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      subjectName: input.subjectName,
      requestId: input.requestId,
      payload: input.payload,
    },
    audit: {
      id: crypto.randomUUID(),
      category: "prospecting",
      description: input.description,
    },
  });

  if (!result.ok) {
    throw new Error("event_append_failed");
  }
}
