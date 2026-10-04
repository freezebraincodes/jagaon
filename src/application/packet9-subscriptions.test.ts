import { describe, expect, it } from "vitest";
import { PACKET_9_SUBSCRIPTIONS, packet9WorkItemsFor } from "./packet9-subscriptions";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Packet 9B static subscriptions", () => {
  it("reconciles reminders only for revised or deleted appointment, preventive-item and question sources", () => {
    expect(PACKET_9_SUBSCRIPTIONS.filter((entry) => entry.consumer === "REMINDER_RECONCILIATION").map((entry) => [entry.eventName, entry.recordType])).toEqual([
      ["APPOINTMENT_REVISED", "APPOINTMENT"],
      ["PATIENT_RECORD_DELETED", "APPOINTMENT"],
      ["PREVENTIVE_CARE_ITEM_REVISED", "PREVENTIVE_CARE_ITEM"],
      ["PATIENT_RECORD_DELETED", "PREVENTIVE_CARE_ITEM"],
      ["CARE_QUESTION_REVISED", "CARE_QUESTION"],
      ["PATIENT_RECORD_DELETED", "CARE_QUESTION"],
    ]);
    for (const entry of PACKET_9_SUBSCRIPTIONS) {
      if (entry.consumer === "REMINDER_RECONCILIATION") expect(entry.handlerVersion).toBe("reminder-reconciliation.8.1");
    }
  });

  it("creates no reminder work for a preventive-care outcome, context window or new appointment", () => {
    for (const [eventName, recordType] of [
      ["PREVENTIVE_CARE_OUTCOME_RECORDED", "PREVENTIVE_CARE_RECORD"],
      ["CONTEXT_WINDOW_RECORDED", "CONTEXT_WINDOW"],
      ["APPOINTMENT_SCHEDULED", "APPOINTMENT"],
    ] as const) {
      const items = packet9WorkItemsFor({ eventId: ID(1) as never, eventName, recordType, createdAt: "2026-10-04T00:00:00.000Z" as never, workItemId: () => ID(2) as never });
      expect(items.filter((item) => item.consumer === "REMINDER_RECONCILIATION")).toEqual([]);
    }
  });

  it("emits one pending work item per matching subscription", () => {
    const items = packet9WorkItemsFor({ eventId: ID(1) as never, eventName: "APPOINTMENT_REVISED", recordType: "APPOINTMENT", createdAt: "2026-10-04T00:00:00.000Z" as never, workItemId: () => ID(2) as never });
    expect(items).toEqual([
      expect.objectContaining({ consumer: "REMINDER_RECONCILIATION", eventId: ID(1), state: { state: "PENDING" }, attemptCount: 0, plannedCommands: [] }),
      expect.objectContaining({ consumer: "CARE_SUMMARY_INVALIDATION", handlerVersion: "care-summary-invalidation.9c.1", eventId: ID(1) }),
    ]);
  });
});

describe("Packet 9C care-summary invalidation subscriptions", () => {
  it("subscribes exactly to corrections and revisions of allowlisted summary sources, never to deletions", () => {
    expect(PACKET_9_SUBSCRIPTIONS.filter((entry) => entry.consumer === "CARE_SUMMARY_INVALIDATION").map((entry) => `${entry.eventName}:${entry.recordType}`)).toEqual([
      "GLUCOSE_READING_CORRECTED:GLUCOSE_READING",
      "MEDICATION_EVENT_CORRECTED:MEDICATION_EVENT",
      "INTAKE_EVENT_CORRECTED:INTAKE_EVENT",
      "ACTIVITY_EVENT_CORRECTED:ACTIVITY_EVENT",
      "MEDICATION_REVISED:MEDICATION",
      "APPOINTMENT_REVISED:APPOINTMENT",
      "CARE_QUESTION_REVISED:CARE_QUESTION",
    ]);
    // Deletion purges dependent summaries inside the deletion transaction itself.
    expect(PACKET_9_SUBSCRIPTIONS.some((entry) => entry.consumer === "CARE_SUMMARY_INVALIDATION" && entry.eventName === "PATIENT_RECORD_DELETED")).toBe(false);
  });

  it("never queues summary work for a new record or for a summary's own events", () => {
    for (const [eventName, recordType] of [
      ["GLUCOSE_READING_RECORDED", "GLUCOSE_READING"],
      ["CARE_SUMMARY_SNAPSHOT_PREPARED", "CARE_SUMMARY_SNAPSHOT"],
      ["CARE_SUMMARY_EXPORT_REQUESTED", "CARE_SUMMARY_EXPORT"],
    ] as const) {
      expect(packet9WorkItemsFor({ eventId: ID(1) as never, eventName, recordType, createdAt: "2026-10-04T00:00:00.000Z" as never, workItemId: () => ID(2) as never })).toEqual([]);
    }
  });
});
