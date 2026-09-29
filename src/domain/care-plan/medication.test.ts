import { describe, it, expect } from "vitest";
import {
  medicationPayloadSchema,
  medicationIdentitySchema,
  medicationDoseFormSchema,
  medicationRouteSchema,
  medicationDeliveryDeviceSchema,
  MEDICATION_REVISION_ACTIONS,
  MEDICATION_DELETION_POLICY,
} from "./medication";
import { DeletionPolicy } from "../shared/record-catalogue";

describe("medicationDoseFormSchema", () => {
  it("accepts all reviewed forms", () => {
    const forms = [
      "TABLET",
      "CAPSULE",
      "ORAL_LIQUID",
      "INJECTION_SOLUTION",
      "INHALATION_PREPARATION",
      "TOPICAL_PREPARATION",
      "PATCH",
      "OTHER",
      "UNKNOWN",
    ];
    for (const f of forms) {
      expect(medicationDoseFormSchema.parse(f)).toBe(f);
    }
  });

  it("rejects an unknown form", () => {
    expect(() => medicationDoseFormSchema.parse("SUPPOSITORY")).toThrow();
  });
});

describe("medicationRouteSchema", () => {
  it("accepts all reviewed routes", () => {
    const routes = [
      "ORAL",
      "SUBCUTANEOUS",
      "INTRAMUSCULAR",
      "INTRAVENOUS",
      "INHALED",
      "TOPICAL",
      "TRANSDERMAL",
      "OTHER",
      "UNKNOWN",
    ];
    for (const r of routes) {
      expect(medicationRouteSchema.parse(r)).toBe(r);
    }
  });

  it("rejects an unknown route", () => {
    expect(() => medicationRouteSchema.parse("BUCCAL")).toThrow();
  });
});

describe("medicationDeliveryDeviceSchema", () => {
  it("accepts all reviewed devices", () => {
    const devices = [
      "NONE",
      "INSULIN_PEN",
      "SYRINGE",
      "INSULIN_PUMP",
      "INHALER",
      "OTHER",
      "UNKNOWN",
    ];
    for (const d of devices) {
      expect(medicationDeliveryDeviceSchema.parse(d)).toBe(d);
    }
  });

  it("rejects an unknown device", () => {
    expect(() => medicationDeliveryDeviceSchema.parse("DROPPER")).toThrow();
  });
});

describe("medicationIdentitySchema", () => {
  it("accepts a REVIEWED_CATALOGUE_MATCH preserving patientEnteredName", () => {
    const result = medicationIdentitySchema.parse({
      kind: "REVIEWED_CATALOGUE_MATCH",
      patientEnteredName: "Insulin",
      catalogueEntryKey: "insulin-rapid-action",
      catalogueVersion: "2.0",
      matchedLabel: "Insulin (rapid-acting)",
      matchMethod: "STRUCTURED_PATIENT_SELECTION",
    });
    expect(result.kind).toBe("REVIEWED_CATALOGUE_MATCH");
    if (result.kind === "REVIEWED_CATALOGUE_MATCH") {
      expect(result.patientEnteredName).toBe("Insulin");
      expect(result.matchedLabel).toBe("Insulin (rapid-acting)");
    }
  });

  it("accepts an UNMAPPED identity preserving patientEnteredName", () => {
    const result = medicationIdentitySchema.parse({
      kind: "UNMAPPED",
      patientEnteredName: "My herbal supplement",
    });
    expect(result.kind).toBe("UNMAPPED");
    if (result.kind === "UNMAPPED") {
      expect(result.patientEnteredName).toBe("My herbal supplement");
    }
  });

  it("keeps REVIEWED_CATALOGUE_MATCH and UNMAPPED distinct", () => {
    const reviewed = medicationIdentitySchema.parse({
      kind: "REVIEWED_CATALOGUE_MATCH",
      patientEnteredName: "A",
      catalogueEntryKey: "a",
      catalogueVersion: "1",
      matchedLabel: "A",
      matchMethod: "DETERMINISTIC_ALIAS",
    });
    const unmapped = medicationIdentitySchema.parse({
      kind: "UNMAPPED",
      patientEnteredName: "A",
    });
    expect(reviewed.kind).not.toBe(unmapped.kind);
  });

  it("rejects unknown keys on REVIEWED_CATALOGUE_MATCH", () => {
    expect(() =>
      medicationIdentitySchema.parse({
        kind: "REVIEWED_CATALOGUE_MATCH",
        patientEnteredName: "A",
        catalogueEntryKey: "a",
        catalogueVersion: "1",
        matchedLabel: "A",
        matchMethod: "STRUCTURED_PATIENT_SELECTION",
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects unknown keys on UNMAPPED", () => {
    expect(() =>
      medicationIdentitySchema.parse({
        kind: "UNMAPPED",
        patientEnteredName: "A",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("medicationPayloadSchema", () => {
  function mkInsulinPen() {
    return {
      identity: {
        kind: "REVIEWED_CATALOGUE_MATCH" as const,
        patientEnteredName: "Insulin",
        catalogueEntryKey: "insulin-rapid-action",
        catalogueVersion: "2.0",
        matchedLabel: "Insulin (rapid-acting)",
        matchMethod: "STRUCTURED_PATIENT_SELECTION" as const,
      },
      doseForm: "INJECTION_SOLUTION" as const,
      route: "SUBCUTANEOUS" as const,
      deliveryDevice: "INSULIN_PEN" as const,
    };
  }

  it("accepts insulin pen with separate form, route, and device fields", () => {
    const result = medicationPayloadSchema.parse(mkInsulinPen());
    expect(result.doseForm).toBe("INJECTION_SOLUTION");
    expect(result.route).toBe("SUBCUTANEOUS");
    expect(result.deliveryDevice).toBe("INSULIN_PEN");
  });

  it("preserves patientEnteredName through reviewed catalogue match", () => {
    const result = medicationPayloadSchema.parse(mkInsulinPen());
    expect(result.identity.kind).toBe("REVIEWED_CATALOGUE_MATCH");
    if (result.identity.kind === "REVIEWED_CATALOGUE_MATCH") {
      expect(result.identity.patientEnteredName).toBe("Insulin");
    }
  });

  it("accepts an optional patientNote", () => {
    const result = medicationPayloadSchema.parse({
      ...mkInsulinPen(),
      patientNote: { text: "Morning insulin", language: "en-SG" },
    });
    expect(result.patientNote!.text).toBe("Morning insulin");
  });

  it("rejects unknown keys on the payload", () => {
    expect(() =>
      medicationPayloadSchema.parse({ ...mkInsulinPen(), extra: true }),
    ).toThrow();
  });
});

describe("MEDICATION shared boundaries", () => {
  it("is PATIENT_DELETABLE", () => {
    expect(MEDICATION_DELETION_POLICY).toBe(DeletionPolicy.PATIENT_DELETABLE);
  });

  it("has exactly CREATE, CORRECT, CONFIRM", () => {
    expect(MEDICATION_REVISION_ACTIONS).toEqual([
      "CREATE",
      "CORRECT",
      "CONFIRM",
    ]);
  });

  it("does not include SYSTEM_DERIVE", () => {
    expect(MEDICATION_REVISION_ACTIONS).not.toContain("SYSTEM_DERIVE");
  });
});