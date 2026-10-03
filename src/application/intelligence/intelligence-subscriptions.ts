import type { DomainEventId } from "@/application/contracts/command-event-identifiers";
import type { EventWorkItem, WorkItemId } from "@/application/contracts/event-work";
import type { RecordType } from "@/domain/shared/record-catalogue";
import type { Instant } from "@/domain/shared/time";
import { enabledLearningFamilies, enabledPatternFamilies } from "./activation-manifest";

/**
 * Packet 7A static subscription registry (event-contracts Section 10).
 *
 * Health-record events schedule ordinary-intelligence work only for families
 * the compile-time manifest enables. Medication events feed only disabled
 * families, so they schedule nothing; derived-record events have no
 * intelligence subscription, which prevents reevaluation cycles.
 */

export const PATTERN_HANDLER_VERSION = "pattern-reevaluation.7a.1";
export const LEARNING_HANDLER_VERSION = "learning-reevaluation.7a.1";

type IntelligenceConsumer = "PATTERN_REEVALUATION" | "LEARNING_REEVALUATION";

/** Source record types each enabled family evaluates. */
const PATTERN_SOURCE_TYPES: Readonly<Record<string, readonly RecordType[]>> = Object.freeze({
  COMPARABLE_SLOT_TREND: ["GLUCOSE_READING"],
  FAMILIAR_OR_FREQUENT_ITEM: ["INTAKE_EVENT", "ACTIVITY_EVENT"],
});
const LEARNING_SOURCE_TYPES: Readonly<Record<string, readonly RecordType[]>> = Object.freeze({
  FAMILIAR_ITEM: ["INTAKE_EVENT", "ACTIVITY_EVENT"],
});

function sourceTypesFor(consumer: IntelligenceConsumer): Set<RecordType> {
  const families = consumer === "PATTERN_REEVALUATION" ? enabledPatternFamilies() : enabledLearningFamilies();
  const table = consumer === "PATTERN_REEVALUATION" ? PATTERN_SOURCE_TYPES : LEARNING_SOURCE_TYPES;
  return new Set(families.flatMap((family) => table[family] ?? []));
}

export type IntelligenceSubscription = {
  eventName: string;
  consumer: IntelligenceConsumer;
  handlerVersion: string;
  priority: "ORDINARY_INTELLIGENCE";
};

const EVENT_SOURCE: ReadonlyArray<[string, RecordType | "ANY_DELETED_SOURCE"]> = [
  ["GLUCOSE_READING_RECORDED", "GLUCOSE_READING"],
  ["GLUCOSE_READING_CORRECTED", "GLUCOSE_READING"],
  ["INTAKE_EVENT_RECORDED", "INTAKE_EVENT"],
  ["INTAKE_EVENT_CORRECTED", "INTAKE_EVENT"],
  ["ACTIVITY_EVENT_RECORDED", "ACTIVITY_EVENT"],
  ["ACTIVITY_EVENT_CORRECTED", "ACTIVITY_EVENT"],
  ["PATIENT_RECORD_DELETED", "ANY_DELETED_SOURCE"],
];

export const INTELLIGENCE_SUBSCRIPTIONS: readonly IntelligenceSubscription[] = Object.freeze(
  EVENT_SOURCE.flatMap(([eventName, recordType]) =>
    (["PATTERN_REEVALUATION", "LEARNING_REEVALUATION"] as const)
      .filter((consumer) => recordType === "ANY_DELETED_SOURCE" || sourceTypesFor(consumer).has(recordType))
      .map((consumer) => ({
        eventName,
        consumer,
        handlerVersion: consumer === "PATTERN_REEVALUATION" ? PATTERN_HANDLER_VERSION : LEARNING_HANDLER_VERSION,
        priority: "ORDINARY_INTELLIGENCE" as const,
      })),
  ),
);

/** Work items created in the same transaction as the triggering event. */
export function intelligenceWorkItemsFor(event: {
  eventId: DomainEventId;
  eventName: string;
  recordType: RecordType;
  createdAt: Instant;
  workItemId: () => WorkItemId;
}): EventWorkItem[] {
  return INTELLIGENCE_SUBSCRIPTIONS.filter(
    (subscription) => subscription.eventName === event.eventName && sourceTypesFor(subscription.consumer).has(event.recordType),
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
