import type { DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { ConsumerKey, EventWorkItem, WorkItemId, WorkPriority } from "@/application/contracts/event-work";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { Instant } from "@/domain/shared/time";

/**
 * Packet 8 static subscription registry (event-contracts Section 10.2).
 *
 * Only an explicitly recorded medication event can schedule Inquiry
 * eligibility work, and only a prescription correction or deletion can
 * schedule reminder reconciliation. Reminder, care-question and Inquiry
 * events intentionally have no asynchronous consumer here, so a reminder
 * interaction or an answer never feeds Learning, Pattern or Inquiry.
 */

export const INQUIRY_ELIGIBILITY_HANDLER_VERSION = "inquiry-eligibility.8.1";
export const REMINDER_RECONCILIATION_HANDLER_VERSION = "reminder-reconciliation.8.1";

export type Packet8Subscription = {
  eventName: string;
  recordType: RecordType;
  consumer: Extract<ConsumerKey, "INQUIRY_ELIGIBILITY" | "REMINDER_RECONCILIATION">;
  handlerVersion: string;
  priority: WorkPriority;
  /** Versioned deterministic eligibility filter (event-contracts Section 10.1). */
  eligibilityFilterKey: "ALL_EVENTS.1" | "EXPLICIT_SKIPPED_OR_UNSURE.1";
};

/** Medication states a newly recorded event must carry before Inquiry work exists. */
export const INQUIRY_TRIGGER_MEDICATION_STATES = Object.freeze(["MISSED", "UNSURE"] as const);

export const PACKET_8_SUBSCRIPTIONS: readonly Packet8Subscription[] = Object.freeze(
  [
    ["MEDICATION_EVENT_RECORDED", "MEDICATION_EVENT", "INQUIRY_ELIGIBILITY"],
    ["MEDICATION_EVENT_CORRECTED", "MEDICATION_EVENT", "INQUIRY_ELIGIBILITY"],
    ["PATIENT_RECORD_DELETED", "MEDICATION_EVENT", "INQUIRY_ELIGIBILITY"],
    ["PRESCRIPTION_VERSION_REVISED", "PRESCRIPTION_VERSION", "REMINDER_RECONCILIATION"],
    ["PATIENT_RECORD_DELETED", "PRESCRIPTION_VERSION", "REMINDER_RECONCILIATION"],
  ].map(([eventName, recordType, consumer]) =>
    Object.freeze({
      eventName: eventName!,
      recordType: recordType as RecordType,
      consumer: consumer as Packet8Subscription["consumer"],
      handlerVersion: consumer === "INQUIRY_ELIGIBILITY" ? INQUIRY_ELIGIBILITY_HANDLER_VERSION : REMINDER_RECONCILIATION_HANDLER_VERSION,
      priority: (consumer === "INQUIRY_ELIGIBILITY" ? "ORDINARY_INTELLIGENCE" : "PATIENT_VISIBLE_CURRENT_STATE") as WorkPriority,
      // A new taken or declined record never schedules a question; corrections
      // and deletions always do, so open questions can be withdrawn.
      eligibilityFilterKey: (eventName === "MEDICATION_EVENT_RECORDED" ? "EXPLICIT_SKIPPED_OR_UNSURE.1" : "ALL_EVENTS.1") as Packet8Subscription["eligibilityFilterKey"],
    }),
  ),
);

/** Work items committed in the same transaction as the triggering event. */
export function packet8WorkItemsFor(event: {
  eventId: DomainEventId;
  eventName: string;
  recordType: RecordType;
  createdAt: Instant;
  workItemId: () => WorkItemId;
  /** The recorded medication-event state, when the event is a medication event. */
  medicationEventState?: string;
}): EventWorkItem[] {
  return PACKET_8_SUBSCRIPTIONS.filter(
    (subscription) =>
      subscription.eventName === event.eventName &&
      subscription.recordType === event.recordType &&
      (subscription.eligibilityFilterKey === "ALL_EVENTS.1" ||
        (INQUIRY_TRIGGER_MEDICATION_STATES as readonly string[]).includes(event.medicationEventState ?? "")),
  ).map((subscription) => ({
    workItemId: event.workItemId(),
    eventId: event.eventId,
    consumer: subscription.consumer,
    handlerVersion: subscription.handlerVersion,
    priority: subscription.priority,
    createdAt: event.createdAt,
    attemptCount: 0,
    state: { state: "PENDING" },
    plannedCommands: [],
  }));
}
