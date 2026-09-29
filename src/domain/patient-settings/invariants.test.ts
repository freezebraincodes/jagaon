import { describe, it, expect } from "vitest";
import { type RecordHead } from "../shared/revision";
import type { PatientPreferencePayload } from "./preferences";
import {
  validateSingleActiveProfile,
  validateOneActivePreferencePerKind,
  type PreferenceHead,
} from "./invariants";

const T0 = "2026-09-27T10:00:00Z";

function mkHead(recordId: string, recordType: string, state: "ACTIVE" | "DELETED" = "ACTIVE"): RecordHead {
  return {
    recordId: recordId as never,
    recordType: recordType as never,
    headRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
    headRevisionNumber: 1,
    state,
    updatedAt: T0 as never,
  };
}

function mkPrefHead(recordId: string, kind: PatientPreferencePayload["kind"], state: "ACTIVE" | "DELETED" = "ACTIVE"): PreferenceHead {
  return {
    kind,
    recordType: "PATIENT_PREFERENCE",
    recordId: recordId as never,
    headRevisionId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
    headRevisionNumber: 1,
    state,
    updatedAt: T0 as never,
  };
}

const FIVE_KINDS: PatientPreferencePayload["kind"][] = [
  "LANGUAGE",
  "GLUCOSE_DISPLAY_UNIT",
  "ACCESSIBILITY",
  "HOME_TIME_ZONE",
  "COMMUNICATION",
];

function mkAllFiveActive(): PreferenceHead[] {
  return FIVE_KINDS.map((kind, i) => mkPrefHead(`r${i + 1}`, kind));
}

describe("validateSingleActiveProfile", () => {
  it("accepts exactly one active PATIENT_PROFILE", () => {
    expect(validateSingleActiveProfile([mkHead("r1", "PATIENT_PROFILE", "ACTIVE")])).toBe(true);
  });

  it("rejects zero active profiles", () => {
    expect(validateSingleActiveProfile([])).toBe(false);
  });

  it("rejects two active profiles", () => {
    expect(validateSingleActiveProfile([
      mkHead("r1", "PATIENT_PROFILE", "ACTIVE"),
      mkHead("r2", "PATIENT_PROFILE", "ACTIVE"),
    ])).toBe(false);
  });

  it("accepts one active profile and ignores deleted ones", () => {
    expect(validateSingleActiveProfile([
      mkHead("r1", "PATIENT_PROFILE", "ACTIVE"),
      mkHead("r2", "PATIENT_PROFILE", "DELETED"),
    ])).toBe(true);
  });

  it("rejects zero when only deleted profiles exist", () => {
    expect(validateSingleActiveProfile([
      mkHead("r1", "PATIENT_PROFILE", "DELETED"),
    ])).toBe(false);
  });
});

describe("validateOneActivePreferencePerKind", () => {
  it("fails on an empty preference collection", () => {
    expect(validateOneActivePreferencePerKind([])).toBe(false);
  });

  it("passes with all five active kinds", () => {
    expect(validateOneActivePreferencePerKind(mkAllFiveActive())).toBe(true);
  });

  it("fails with only four of five kinds", () => {
    const four = mkAllFiveActive().filter(
      (h) => h.kind !== "COMMUNICATION",
    );
    expect(validateOneActivePreferencePerKind(four)).toBe(false);
  });

  it("fails when an active kind is duplicated", () => {
    const dup = [...mkAllFiveActive(), mkPrefHead("r6", "LANGUAGE")];
    expect(validateOneActivePreferencePerKind(dup)).toBe(false);
  });

  it("passes when one active plus one deleted of the same kind exist and all five active kinds remain present", () => {
    const result = [
      ...mkAllFiveActive(),
      mkPrefHead("r6", "LANGUAGE", "DELETED"),
    ];
    expect(validateOneActivePreferencePerKind(result)).toBe(true);
  });

  it("fails when a non-PATIENT_PREFERENCE head cannot satisfy a preference", () => {
    const heads = mkAllFiveActive().map((h, i) =>
      i === 0
        ? { ...h, recordType: "PATIENT_PROFILE" as never }
        : h,
    );
    expect(validateOneActivePreferencePerKind(heads)).toBe(false);
  });

  it("fails when the same record identity is reused across distinct preference kinds", () => {
    const heads: PreferenceHead[] = [
      mkPrefHead("shared-id", "LANGUAGE"),
      mkPrefHead("shared-id", "GLUCOSE_DISPLAY_UNIT"),
      mkPrefHead("r3", "ACCESSIBILITY"),
      mkPrefHead("r4", "HOME_TIME_ZONE"),
      mkPrefHead("r5", "COMMUNICATION"),
    ];
    expect(validateOneActivePreferencePerKind(heads)).toBe(false);
  });

  it("passes when distinct preference identities are used", () => {
    expect(validateOneActivePreferencePerKind(mkAllFiveActive())).toBe(true);
  });
});