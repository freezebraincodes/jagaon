import { describe, expect, it } from "vitest";
import { eventWorkItemSchema } from "@/application/contracts/event-work";
import {
  INTELLIGENCE_SUBSCRIPTIONS,
  LEARNING_HANDLER_VERSION,
  PATTERN_HANDLER_VERSION,
  intelligenceWorkItemsFor,
} from "./intelligence-subscriptions";

let n = 0;
const nextId = () => `00000000-0000-4000-8000-${(n += 1).toString().padStart(12, "0")}`;
const EVENT = "00000000-0000-4000-8000-999999999999";

function work(eventName: string, recordType: string) {
  return intelligenceWorkItemsFor({
    eventId: EVENT as never,
    eventName: eventName as never,
    recordType: recordType as never,
    createdAt: "2026-10-03T00:00:00.000Z" as never,
    workItemId: nextId as never,
  });
}

describe("Packet 7A static intelligence subscriptions", () => {
  it("lists one exact subscription per eligible health-record event and consumer", () => {
    expect(INTELLIGENCE_SUBSCRIPTIONS.map((s) => `${s.eventName}>${s.consumer}`)).toEqual([
      "GLUCOSE_READING_RECORDED>PATTERN_REEVALUATION",
      "GLUCOSE_READING_CORRECTED>PATTERN_REEVALUATION",
      "INTAKE_EVENT_RECORDED>PATTERN_REEVALUATION",
      "INTAKE_EVENT_RECORDED>LEARNING_REEVALUATION",
      "INTAKE_EVENT_CORRECTED>PATTERN_REEVALUATION",
      "INTAKE_EVENT_CORRECTED>LEARNING_REEVALUATION",
      "ACTIVITY_EVENT_RECORDED>PATTERN_REEVALUATION",
      "ACTIVITY_EVENT_RECORDED>LEARNING_REEVALUATION",
      "ACTIVITY_EVENT_CORRECTED>PATTERN_REEVALUATION",
      "ACTIVITY_EVENT_CORRECTED>LEARNING_REEVALUATION",
      "PATIENT_RECORD_DELETED>PATTERN_REEVALUATION",
      "PATIENT_RECORD_DELETED>LEARNING_REEVALUATION",
    ]);
    expect(PATTERN_HANDLER_VERSION).toBe("pattern-reevaluation.7a.1");
    expect(LEARNING_HANDLER_VERSION).toBe("learning-reevaluation.7a.1");
  });

  it("creates valid ordinary-intelligence work for enabled families only", () => {
    const glucose = work("GLUCOSE_READING_RECORDED", "GLUCOSE_READING");
    expect(glucose.map((item) => item.consumer)).toEqual(["PATTERN_REEVALUATION"]);
    for (const item of glucose) {
      expect(eventWorkItemSchema.safeParse(item).success).toBe(true);
      expect(item).toMatchObject({ priority: "ORDINARY_INTELLIGENCE", state: { state: "PENDING" }, attemptCount: 0, plannedCommands: [] });
    }
    expect(work("INTAKE_EVENT_RECORDED", "INTAKE_EVENT").map((item) => item.consumer)).toEqual([
      "PATTERN_REEVALUATION",
      "LEARNING_REEVALUATION",
    ]);
  });

  it("schedules no work for medication events, which only disabled families use", () => {
    expect(work("MEDICATION_EVENT_RECORDED", "MEDICATION_EVENT")).toEqual([]);
  });

  it("subscribes a deletion only when the deleted record type feeds an enabled family", () => {
    expect(work("PATIENT_RECORD_DELETED", "GLUCOSE_READING").map((item) => item.consumer)).toEqual(["PATTERN_REEVALUATION"]);
    expect(work("PATIENT_RECORD_DELETED", "MEDICATION_EVENT")).toEqual([]);
    expect(work("PATIENT_RECORD_DELETED", "PATTERN_OBSERVATION")).toEqual([]);
  });

  it("never subscribes to its own derived-record events", () => {
    expect(work("PATTERN_OBSERVATION_CREATED", "PATTERN_OBSERVATION")).toEqual([]);
    expect(work("LEARNED_KNOWLEDGE_CREATED", "LEARNED_KNOWLEDGE")).toEqual([]);
  });
});
