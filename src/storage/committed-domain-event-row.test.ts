import { describe, expect, it } from "vitest";
import { committedDomainEventRowCodec } from "./committed-domain-event-row";
import { StorageRowValidationError } from "./storage-row-codec";

const row = {
  eventId: "00000000-0000-4000-8000-000000000001",
  eventName: "PATTERN_OBSERVATION_CREATED",
  localSequence: 3,
  transactionIndex: 1,
  transactionId: "00000000-0000-4000-8000-000000000002",
  commandId: "00000000-0000-4000-8000-000000000003",
  correlationId: "00000000-0000-4000-8000-000000000004",
  committedAt: "2026-10-03T16:00:00.000Z",
  change: {
    kind: "REVISION_CREATED",
    recordType: "PATTERN_OBSERVATION",
    recordId: "00000000-0000-4000-8000-000000000005",
    action: "CREATE",
    previousRevisionId: null,
    resultingRevisionId: "00000000-0000-4000-8000-000000000006",
    resultingRevisionNumber: 1,
  },
  payload: { evaluationId: null, reasonCode: "PATTERN_OBSERVATION_CREATED" },
};

describe("committed domain-event read codec", () => {
  it("reads any owner's committed event envelope from the shared table", () => {
    expect(committedDomainEventRowCodec.validateAfterRead(row)).toEqual(row);
    expect(
      committedDomainEventRowCodec.validateAfterRead({
        ...row,
        eventName: "GLUCOSE_READING_RECORDED",
        change: { ...row.change, recordType: "GLUCOSE_READING" },
        payload: { measurement: {} },
      }),
    ).toMatchObject({ eventName: "GLUCOSE_READING_RECORDED" });
  });

  it("fails integrity for unknown event names, malformed changes and extra fields", () => {
    for (const bad of [{ ...row, eventName: "SOMETHING_HAPPENED" }, { ...row, change: { kind: "PATCHED" } }, { ...row, extra: 1 }]) {
      expect(() => committedDomainEventRowCodec.validateAfterRead(bad)).toThrow(StorageRowValidationError);
    }
  });

  it("is read-only: writes go through each owner's exact codec", () => {
    expect(() => committedDomainEventRowCodec.validateForWrite(row)).toThrow(StorageRowValidationError);
  });
});
