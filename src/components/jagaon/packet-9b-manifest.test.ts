import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CARE_PLAN_RECORD_TYPES } from "@/application/care-plan/care-plan-persistence";
import { CARE_ORGANISATION_EVENT_TARGETS, CARE_ORGANISATION_HEALTH_RECORD_TYPES } from "@/application/care-organisation/care-organisation-persistence";
import { FACT_GROUP_KEYS } from "@/application/care-organisation/care-organisation-contracts";
import { PACKET_9B_EVENT_OWNERSHIP } from "@/application/contracts/command-event-names";
import { PACKET_9_SUBSCRIPTIONS } from "@/application/packet9-subscriptions";
import { PREVENTIVE_CARE_CATALOGUE } from "@/domain/care-plan/preventive-care";
import { getMessages } from "@/i18n/get-messages";
import { PACKET_9B_CHILD_SCREENS, TOP_LEVEL_SCREENS } from "./screen-manifest";

/**
 * Packet 9B release manifest: separate records, exact events and
 * subscriptions, the two child routes, and the absence of any clinical date
 * calculation, eligibility or attendance inference are fixed by test.
 */

const ROOT = process.cwd();
const code = (file: string) =>
  readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const PACKET_9B_SOURCES = [
  "src/domain/care-plan/preventive-care.ts",
  "src/domain/care-plan/appointment.ts",
  "src/domain/health-records/preventive-care-record.ts",
  "src/domain/health-records/context-window.ts",
  "src/application/packet9-subscriptions.ts",
  "src/application/care-organisation/care-organisation-contracts.ts",
  "src/application/care-organisation/care-organisation-persistence.ts",
  "src/application/care-organisation/care-organisation-service.ts",
  "src/application/care-organisation/care-organisation-query.ts",
  "src/application/care-organisation/synthetic-care-organisation-seed.ts",
  "src/components/jagaon/care-organisation/AppointmentEditor.tsx",
  "src/components/jagaon/care-organisation/CareQuestionEditor.tsx",
  "src/components/jagaon/care-organisation/PreventiveCareDialogs.tsx",
  "src/components/jagaon/care-organisation/care-format.ts",
  "src/components/jagaon/care-organisation/use-care-load.ts",
  "src/components/jagaon/screens/PreventiveCareScreen.tsx",
  "src/components/jagaon/screens/CarePreparationScreen.tsx",
];

describe("Packet 9B manifest", () => {
  it("keeps plans, appointments, occurrences and context windows as separate records", () => {
    expect(CARE_PLAN_RECORD_TYPES).toEqual(expect.arrayContaining(["PREVENTIVE_CARE_ITEM", "APPOINTMENT", "CARE_QUESTION", "REMINDER"]));
    expect(CARE_ORGANISATION_HEALTH_RECORD_TYPES).toEqual(["PREVENTIVE_CARE_RECORD", "CONTEXT_WINDOW"]);
    for (const type of CARE_ORGANISATION_HEALTH_RECORD_TYPES) expect(CARE_PLAN_RECORD_TYPES).not.toContain(type);
    // Deleting a patient-reported occurrence or context purges its revisions.
    expect(code("src/storage/authoritative-command-transaction.ts")).toMatch(/PURGED_DERIVED_RECORD_TYPES[\s\S]*"PREVENTIVE_CARE_RECORD"[\s\S]*"CONTEXT_WINDOW"/);
  });

  it("registers exactly the eight Packet 9B events with their owning modules", () => {
    expect(Object.entries(PACKET_9B_EVENT_OWNERSHIP).map(([name, owner]) => [name, owner.producedBy, owner.recordType])).toEqual([
      ["PREVENTIVE_CARE_ITEM_CREATED", "CARE_PLAN", "PREVENTIVE_CARE_ITEM"],
      ["PREVENTIVE_CARE_ITEM_REVISED", "CARE_PLAN", "PREVENTIVE_CARE_ITEM"],
      ["APPOINTMENT_SCHEDULED", "CARE_PLAN", "APPOINTMENT"],
      ["APPOINTMENT_REVISED", "CARE_PLAN", "APPOINTMENT"],
      ["PREVENTIVE_CARE_OUTCOME_RECORDED", "HEALTH_RECORDS", "PREVENTIVE_CARE_RECORD"],
      ["PREVENTIVE_CARE_OUTCOME_CORRECTED", "HEALTH_RECORDS", "PREVENTIVE_CARE_RECORD"],
      ["CONTEXT_WINDOW_RECORDED", "HEALTH_RECORDS", "CONTEXT_WINDOW"],
      ["CONTEXT_WINDOW_REVISED", "HEALTH_RECORDS", "CONTEXT_WINDOW"],
    ]);
    for (const [name, target] of Object.entries(CARE_ORGANISATION_EVENT_TARGETS)) {
      if (target) expect(PACKET_9B_EVENT_OWNERSHIP[name as keyof typeof PACKET_9B_EVENT_OWNERSHIP]?.recordType ?? target).toBe(target);
    }
  });

  it("routes only plan, appointment and question changes to reminder review, never an occurrence", () => {
    expect(PACKET_9_SUBSCRIPTIONS.filter((entry) => entry.consumer === "REMINDER_RECONCILIATION").map((entry) => [entry.eventName, entry.recordType, entry.consumer, entry.handlerVersion])).toEqual([
      ["APPOINTMENT_REVISED", "APPOINTMENT", "REMINDER_RECONCILIATION", "reminder-reconciliation.8.1"],
      ["PATIENT_RECORD_DELETED", "APPOINTMENT", "REMINDER_RECONCILIATION", "reminder-reconciliation.8.1"],
      ["PREVENTIVE_CARE_ITEM_REVISED", "PREVENTIVE_CARE_ITEM", "REMINDER_RECONCILIATION", "reminder-reconciliation.8.1"],
      ["PATIENT_RECORD_DELETED", "PREVENTIVE_CARE_ITEM", "REMINDER_RECONCILIATION", "reminder-reconciliation.8.1"],
      ["CARE_QUESTION_REVISED", "CARE_QUESTION", "REMINDER_RECONCILIATION", "reminder-reconciliation.8.1"],
      ["PATIENT_RECORD_DELETED", "CARE_QUESTION", "REMINDER_RECONCILIATION", "reminder-reconciliation.8.1"],
    ]);
    // No preventive-care occurrence or context window queues any Packet 9 work.
    expect(PACKET_9_SUBSCRIPTIONS.some((entry) => entry.recordType === "PREVENTIVE_CARE_RECORD" || entry.recordType === "CONTEXT_WINDOW")).toBe(false);
  });

  it("adds exactly two child routes and leaves the four bottom tabs unchanged", () => {
    expect(PACKET_9B_CHILD_SCREENS).toEqual(["PREVENTIVE_CARE", "CARE_PREPARATION"]);
    expect(TOP_LEVEL_SCREENS).toEqual(["TODAY", "MEDICATION_SCHEDULE", "HISTORY", "MORE"]);
  });

  it("uses the reviewed four-entry catalogue and the four factual record groups only", () => {
    expect(PREVENTIVE_CARE_CATALOGUE.version).toBe("preventive-care-catalogue.1");
    expect(PREVENTIVE_CARE_CATALOGUE.entries.map((entry) => entry.key)).toEqual(["EYE_SCREENING", "BLOOD_TEST", "FOOT_CHECK", "FLU_VACCINE"]);
    expect(FACT_GROUP_KEYS).toEqual(["GLUCOSE", "INSULIN", "MEALS", "WALKS"]);
  });

  it("contains no clinical interval, due-date, eligibility, attendance or completion inference", () => {
    for (const file of PACKET_9B_SOURCES) {
      const source = code(file);
      expect(source, file).not.toMatch(/overdue|isDue|dueDate|nextDue|eligib(?!ilityFilterKey)|recommend|addMonths|addYears|setMonth|setFullYear|interval(?:Months|Years|Days)/i);
      // Only the canonical PATIENT_REPORTED_* statuses exist; no bare inferred status.
      expect(source, file).not.toMatch(/["'](?:MISSED|ATTENDED|COMPLETED|DUE|OVERDUE)["']/);
      // No AI composition, Safety routing, network or location reach.
      expect(source, file).not.toMatch(/from "@\/(?:ai|safety|domain\/safety|inquiry)\/|from "@\/application\/nearby-food|\bfetch\(|navigator\.geolocation|console\.(?:log|info|warn|error)/);
    }
  });

  it("only the patient changes an appointment's status; time passing never does", () => {
    const service = code("src/application/care-plan/care-plan-command-service.ts");
    expect(service).toMatch(/OUTCOME_REPORTED/);
    const query = code("src/application/care-organisation/care-organisation-query.ts");
    // The projection filters by recorded status and time; it never writes or relabels a status.
    expect(query).not.toMatch(/status:\s*["'](?:MISSED|ATTENDED|COMPLETED)/);
    expect(query).not.toMatch(/\.(?:put|add|bulkPut|update|delete)\(/);
  });

  it("ships the Screen 09 and 10 titles in both locales", () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    expect([en.preventiveCare.title, zh.preventiveCare.title]).toEqual(["My health checks", "我的健康检查"]);
    expect([en.carePreparation.title, zh.carePreparation.title]).toEqual(["Prepare for my visit", "为复诊做准备"]);
    expect([en.more.healthChecks, en.more.prepareVisit]).toEqual(expect.arrayContaining([expect.any(String), expect.any(String)]));
  });
});
