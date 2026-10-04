import type { DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { ConsumerKey, EventWorkItem, WorkItemId, WorkPriority } from "@/application/contracts/event-work";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { Instant } from "@/domain/shared/time";
import { REMINDER_RECONCILIATION_HANDLER_VERSION } from "./packet8-subscriptions";

/**
 * Packet 9 static subscriptions (event-contracts Section 10.2). Each entry is
 * an exact event name, target record type and consumer; there is no wildcard.
 *
 * Reminder reconciliation reuses the single registered handler version so
 * one runner processes every reminder-source change; the handler follows the
 * exact reverse-dependency edges of the changed source revision.
 */

export type Packet9Subscription = {
  eventName: string;
  recordType: RecordType;
  consumer: Extract<ConsumerKey, "REMINDER_RECONCILIATION" | "CARE_SUMMARY_INVALIDATION">;
  handlerVersion: string;
  priority: WorkPriority;
  eligibilityFilterKey: "ALL_EVENTS.1";
};

const reminderSource = (eventName: string, recordType: RecordType): Packet9Subscription =>
  Object.freeze({
    eventName,
    recordType,
    consumer: "REMINDER_RECONCILIATION",
    handlerVersion: REMINDER_RECONCILIATION_HANDLER_VERSION,
    priority: "PATIENT_VISIBLE_CURRENT_STATE",
    eligibilityFilterKey: "ALL_EVENTS.1",
  });

/** Packet 9C: one handler version invalidates or purges dependent care summaries. */
export const CARE_SUMMARY_INVALIDATION_HANDLER_VERSION = "care-summary-invalidation.9c.1";

const summarySource = (eventName: string, recordType: RecordType): Packet9Subscription =>
  Object.freeze({
    eventName,
    recordType,
    consumer: "CARE_SUMMARY_INVALIDATION",
    handlerVersion: CARE_SUMMARY_INVALIDATION_HANDLER_VERSION,
    priority: "PATIENT_VISIBLE_CURRENT_STATE",
    eligibilityFilterKey: "ALL_EVENTS.1",
  });

/** Record types a care summary may be built from (plan 9C Task 3 allowlist). */
export const CARE_SUMMARY_SOURCE_RECORD_TYPES = Object.freeze(["GLUCOSE_READING", "MEDICATION_EVENT", "INTAKE_EVENT", "ACTIVITY_EVENT", "MEDICATION", "APPOINTMENT", "CARE_QUESTION"] as const);

export const PACKET_9_SUBSCRIPTIONS: readonly Packet9Subscription[] = Object.freeze([
  reminderSource("APPOINTMENT_REVISED", "APPOINTMENT"),
  reminderSource("PATIENT_RECORD_DELETED", "APPOINTMENT"),
  reminderSource("PREVENTIVE_CARE_ITEM_REVISED", "PREVENTIVE_CARE_ITEM"),
  reminderSource("PATIENT_RECORD_DELETED", "PREVENTIVE_CARE_ITEM"),
  reminderSource("CARE_QUESTION_REVISED", "CARE_QUESTION"),
  reminderSource("PATIENT_RECORD_DELETED", "CARE_QUESTION"),
  // A correction or revision of an exact summary source (event-contracts 10.2–10.3).
  summarySource("GLUCOSE_READING_CORRECTED", "GLUCOSE_READING"),
  summarySource("MEDICATION_EVENT_CORRECTED", "MEDICATION_EVENT"),
  summarySource("INTAKE_EVENT_CORRECTED", "INTAKE_EVENT"),
  summarySource("ACTIVITY_EVENT_CORRECTED", "ACTIVITY_EVENT"),
  summarySource("MEDICATION_REVISED", "MEDICATION"),
  summarySource("APPOINTMENT_REVISED", "APPOINTMENT"),
  summarySource("CARE_QUESTION_REVISED", "CARE_QUESTION"),
  // Permanent source deletion is owned by Packet 10A's confirmed deletion
  // transaction, so Packet 9 queues no summary work for it.
]);

/** Work items committed in the same transaction as the triggering event. */
export function packet9WorkItemsFor(event: {
  eventId: DomainEventId;
  eventName: string;
  recordType: RecordType;
  createdAt: Instant;
  workItemId: () => WorkItemId;
}): EventWorkItem[] {
  return PACKET_9_SUBSCRIPTIONS.filter((subscription) => subscription.eventName === event.eventName && subscription.recordType === event.recordType).map(
    (subscription) => ({
      workItemId: event.workItemId(),
      eventId: event.eventId,
      consumer: subscription.consumer,
      handlerVersion: subscription.handlerVersion,
      priority: subscription.priority,
      createdAt: event.createdAt,
      attemptCount: 0,
      state: { state: "PENDING" },
      plannedCommands: [],
    }),
  );
}
