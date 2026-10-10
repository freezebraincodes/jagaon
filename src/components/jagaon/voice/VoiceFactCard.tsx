"use client";

import { useId, useState } from "react";
import type { VoiceFactDecision } from "@/application/voice/voice-review-contract";
import { glucoseValueInRange, type VoiceFactCandidate, type VoiceLanguage } from "@/domain/voice/voice-contracts";
import { isRememberableTerminologyPhrase } from "@/domain/terminology/patient-terminology";
import { normaliseVoicePhrase } from "@/domain/voice/voice-candidate-extractor";
import { MedicineClarificationDialog, type VoiceMedicineOption } from "./MedicineClarificationDialog";
import { ReportedAmount } from "./ReportedAmount";
import { reportedAmountTaken } from "./voice-journal-save";
import type { VoiceScreenCopy } from "./voice-screen-copy";

/**
 * Packet 13 (P13S): one fact card. Each fact is reviewed and saved SEPARATELY, only by its own Save button.
 * - Glucose: the value as said; the unit as said, "from the app setting (mmol/L)" (owner #2) or, unstated, an explicit tick. No unit
 *   selector anywhere.
 * - Negation, uncertainty, correction or several numbers: the proposal cannot be saved as is; Edit opens an EMPTY form (review M5:
 *   never prefilled with the negated proposal) or the person uses manual entry.
 * - Another person's fact: never saved here; manual entry only.
 * - Medicine: an unresolved description opens the clarification dialog (pick or leave out; "remember" is a separate choice); an
 *   unclear status asks; a PLANNED dose is not an event (Edit to record it otherwise).
 * - 13s.3: a glucose value outside 0 < value ≤ 50 mmol/L is never offered for a one-tap save; the card says so plainly (OUT_OF_RANGE)
 *   and offers Edit (an empty field) and manual entry. The review's own OUT_OF_RANGE refusal (for example a typed value) shows the same.
 * - 13s.3: a reported amount is shown exactly as kept, with a plain line saying whether it will be stored (only on a TAKEN event saved
 *   through the review, never through an edit).
 * The authoritative check is the review contract (the screen builds a decision; `onDecide` returns the outcome).
 */
export type VoiceFactOutcome = "SAVED" | "NOT_SAVED" | "REJECTED" | "OUT_OF_RANGE";

type Props = {
  candidate: VoiceFactCandidate;
  index: number;
  copy: VoiceScreenCopy;
  language: VoiceLanguage;
  medicines: readonly VoiceMedicineOption[];
  onDecide: (decision: VoiceFactDecision) => Promise<VoiceFactOutcome>;
  onRemember: (phrase: string, choice: VoiceMedicineOption) => Promise<boolean>;
  onManualEntry: () => void;
  /** Review I-1: called on any interaction inside the card (a save, a choice, an edit), so a pending remote merge is not applied over it. */
  onInteract?: () => void;
  /** Whether the save path carries a reported amount (only for TAKEN); false until the intent and the journal mapping carry it. */
  amountSaveSupported: boolean;
};

const EDIT_ONLY = ["NEGATION", "UNCERTAINTY", "CORRECTION", "MULTIPLE_NUMBERS"] as const;
const SLOTS = ["BREAKFAST", "LUNCH", "DINNER", "SUPPER"] as const;
type Slot = (typeof SLOTS)[number];
type EventStatus = "TAKEN" | "SKIPPED" | "UNKNOWN";
const VALUE = /^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/;

export function VoiceFactCard({ candidate, index, copy, language, medicines, onDecide, onRemember, onManualEntry, onInteract, amountSaveSupported }: Props) {
  const ids = useId();
  const [outcome, setOutcome] = useState<VoiceFactOutcome | "LEFT_OUT" | null>(null);
  const [busy, setBusy] = useState(false);
  const [unitTicked, setUnitTicked] = useState(false);
  const [picked, setPicked] = useState<VoiceMedicineOption | null>(null);
  const [asking, setAsking] = useState(false);
  const [rememberNote, setRememberNote] = useState<string | null>(null);
  const [status, setStatus] = useState<EventStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editSlot, setEditSlot] = useState<Slot | "">("");
  const [editItems, setEditItems] = useState("");
  const [editMedicine, setEditMedicine] = useState("");
  const [editStatus, setEditStatus] = useState<EventStatus | "">("");

  const otherPerson = candidate.ambiguity.includes("OTHER_PERSON");
  const needsEdit = candidate.ambiguity.some((reason) => (EDIT_ONLY as readonly string[]).includes(reason)) || (candidate.kind === "MEDICATION_OCCURRENCE" && candidate.status === "PLANNED");
  const done = outcome === "SAVED" || outcome === "LEFT_OUT";
  const outOfRange = candidate.kind === "GLUCOSE_READING" && !glucoseValueInRange(candidate.valueText);
  const heading = candidate.kind === "GLUCOSE_READING" ? copy.card.glucose : candidate.kind === "MEAL_NOTE" ? copy.card.meal : copy.card.medicine;

  async function decide(decision: VoiceFactDecision) {
    if (busy || done) return;
    setBusy(true);
    try {
      setOutcome(await onDecide(decision));
    } catch {
      setOutcome("NOT_SAVED");
    } finally {
      setBusy(false);
    }
  }

  function editDecision(): VoiceFactDecision | null {
    if (candidate.kind === "GLUCOSE_READING") return VALUE.test(editValue.trim()) ? { candidateIndex: index, action: "SAVE", edit: { kind: "GLUCOSE_READING", valueText: editValue.trim(), unit: "MMOL_PER_L" } } : null;
    if (candidate.kind === "MEAL_NOTE") return editSlot !== "" || editItems.trim() !== "" ? { candidateIndex: index, action: "SAVE", edit: { kind: "MEAL_NOTE", slot: editSlot === "" ? null : editSlot, itemText: editItems.trim() === "" ? null : editItems.trim().slice(0, 120) } } : null;
    const medicine = medicines.find((option) => option.medication.recordId === editMedicine);
    return medicine && editStatus !== "" ? { candidateIndex: index, action: "SAVE", edit: { kind: "MEDICATION_OCCURRENCE", medication: medicine.medication, status: editStatus } } : null;
  }

  function directDecision(): VoiceFactDecision | null {
    if (candidate.kind === "GLUCOSE_READING") return candidate.unit === "UNSTATED" && !unitTicked ? null : { candidateIndex: index, action: "SAVE", ...(candidate.unit === "UNSTATED" ? { answers: { unit: "MMOL_PER_L" } } : {}) };
    if (candidate.kind === "MEAL_NOTE") return { candidateIndex: index, action: "SAVE" };
    const unresolved = candidate.medicineRef.kind === "UNRESOLVED";
    if (unresolved && !picked) return null;
    if (candidate.status === "UNKNOWN" && !status) return null;
    const answers = { ...(unresolved && picked ? { medication: picked.medication } : {}), ...(candidate.status === "UNKNOWN" && status ? { status } : {}) };
    return { candidateIndex: index, action: "SAVE", ...(Object.keys(answers).length > 0 ? { answers } : {}) };
  }

  const decision = editing ? editDecision() : !needsEdit && !otherPerson && !outOfRange ? directDecision() : null;
  // 13s.3: an edit's intent carries no amount, so only the reviewed TAKEN occurrence (as said, or "not sure" answered Taken) stores it.
  const takenWithAmount =
    amountSaveSupported &&
    !editing &&
    !needsEdit &&
    candidate.kind === "MEDICATION_OCCURRENCE" &&
    (candidate.status === "TAKEN" || (candidate.status === "UNKNOWN" && status === "TAKEN")) &&
    reportedAmountTaken(candidate.reportedAmount).kind === "KNOWN";

  return (
    <article className="card voice-fact-card" aria-labelledby={`${ids}-heading`} onClickCapture={onInteract} onChangeCapture={onInteract}>
      <h3 id={`${ids}-heading`} className="voice-fact-heading">
        {heading}
      </h3>
      <p className="voice-fact-phrase">“{candidate.sourcePhrase}”</p>

      {candidate.kind === "GLUCOSE_READING" && !editing ? (
        <div className="voice-fact-body">
          {outOfRange && !needsEdit && !otherPerson ? <p className="voice-fact-warning">{copy.card.outOfRange}</p> : null}
          {!needsEdit && !otherPerson && !outOfRange ? <p className="voice-fact-value">{candidate.valueText}</p> : null}
          {!needsEdit && !otherPerson && !outOfRange && candidate.unitSource === "SPOKEN" ? <p>{copy.card.unitSpoken}</p> : null}
          {!needsEdit && !otherPerson && !outOfRange && candidate.unitSource === "APP_DEFAULT" ? <p>{copy.card.unitAppDefault}</p> : null}
          {!needsEdit && !otherPerson && !outOfRange && candidate.unit === "UNSTATED" ? (
            <>
              <p>{copy.review.unitUnstated}</p>
              <label className="choice-row">
                <input type="checkbox" checked={unitTicked} disabled={done} onChange={(event) => setUnitTicked(event.target.checked)} />
                <span>{copy.card.confirmUnit}</span>
              </label>
            </>
          ) : null}
        </div>
      ) : null}

      {candidate.kind === "MEAL_NOTE" && !editing && !needsEdit && !otherPerson ? (
        <div className="voice-fact-body">
          <p>{candidate.slot === "UNSTATED" ? copy.card.slotUnstated : copy.card.slots[candidate.slot]}</p>
          <p>{candidate.itemText ?? copy.card.noItems}</p>
        </div>
      ) : null}

      {candidate.kind === "MEDICATION_OCCURRENCE" && !editing && !otherPerson ? (
        <div className="voice-fact-body">
          {candidate.medicineRef.kind === "MAPPED" ? (
            <p>{medicines.find((option) => option.medication.recordId === (candidate.medicineRef as { medication: { recordId: string } }).medication.recordId)?.name ?? candidate.medicineRef.phrase}</p>
          ) : picked ? (
            <p>{picked.name}</p>
          ) : (
            <>
              <p>{copy.card.medicineUnresolved(candidate.medicineRef.phrase)}</p>
              {!needsEdit ? (
                <button type="button" className="btn btn-secondary" disabled={done} onClick={() => setAsking(true)}>
                  {copy.card.chooseMedicine}
                </button>
              ) : null}
            </>
          )}
          {rememberNote ? <p role="status">{rememberNote}</p> : null}
          {candidate.status === "PLANNED" ? <p>{copy.card.planned}</p> : null}
          {candidate.status === "UNKNOWN" && !needsEdit ? (
            <fieldset className="voice-status-question">
              <legend>{copy.card.statusQuestion}</legend>
              {(["TAKEN", "SKIPPED", "UNKNOWN"] as const).map((option) => (
                <label key={option} className="choice-row">
                  <input type="radio" name={`${ids}-status`} checked={status === option} disabled={done} onChange={() => setStatus(option)} />
                  <span>{option === "TAKEN" ? copy.card.statusTaken : option === "SKIPPED" ? copy.card.statusSkipped : copy.card.statusUnknown}</span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {/* Review M-8: a status that needs editing is not shown as if it were settled. */}
          {!needsEdit && (candidate.status === "TAKEN" || candidate.status === "SKIPPED") ? <p>{candidate.status === "TAKEN" ? copy.card.statusTaken : copy.card.statusSkipped}</p> : null}
          <ReportedAmount candidate={candidate} copy={copy} willBeSaved={takenWithAmount} />
        </div>
      ) : null}

      {otherPerson ? <p className="voice-fact-warning">{copy.card.otherPerson}</p> : null}
      {needsEdit && !otherPerson && !editing && candidate.ambiguity.some((reason) => (EDIT_ONLY as readonly string[]).includes(reason)) ? <p className="voice-fact-warning">{copy.card.needsEdit}</p> : null}

      {editing ? (
        <div className="voice-fact-edit">
          {candidate.kind === "GLUCOSE_READING" ? (
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-value`}>
                {copy.card.valueLabel}
              </label>
              <input id={`${ids}-value`} className="input" inputMode="decimal" autoComplete="off" value={editValue} onChange={(event) => setEditValue(event.target.value)} aria-describedby={`${ids}-value-hint`} />
              <p id={`${ids}-value-hint`} className="field-hint">
                {copy.card.enterValueYourself}
              </p>
            </div>
          ) : null}
          {candidate.kind === "MEAL_NOTE" ? (
            <>
              <div className="field">
                <label className="field-label" htmlFor={`${ids}-slot`}>
                  {copy.card.slotLabel}
                </label>
                <select id={`${ids}-slot`} className="input" value={editSlot} onChange={(event) => setEditSlot(event.target.value as Slot | "")}>
                  <option value="">{copy.card.slotUnstated}</option>
                  {SLOTS.map((slot) => (
                    <option key={slot} value={slot}>
                      {copy.card.slots[slot]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`${ids}-items`}>
                  {copy.card.itemsLabel}
                </label>
                <input id={`${ids}-items`} className="input" maxLength={120} value={editItems} onChange={(event) => setEditItems(event.target.value)} />
              </div>
            </>
          ) : null}
          {candidate.kind === "MEDICATION_OCCURRENCE" ? (
            <>
              <div className="field">
                <label className="field-label" htmlFor={`${ids}-medicine`}>
                  {copy.card.chooseMedicine}
                </label>
                <select id={`${ids}-medicine`} className="input" value={editMedicine} onChange={(event) => setEditMedicine(event.target.value)}>
                  <option value="" />
                  {medicines.map((option) => (
                    <option key={option.medication.recordId} value={option.medication.recordId}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`${ids}-status-edit`}>
                  {copy.card.statusQuestion}
                </label>
                <select id={`${ids}-status-edit`} className="input" value={editStatus} onChange={(event) => setEditStatus(event.target.value as EventStatus | "")}>
                  <option value="" />
                  <option value="TAKEN">{copy.card.statusTaken}</option>
                  <option value="SKIPPED">{copy.card.statusSkipped}</option>
                  <option value="UNKNOWN">{copy.card.statusUnknown}</option>
                </select>
              </div>
              <ReportedAmount candidate={candidate} copy={copy} willBeSaved={takenWithAmount} />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="voice-fact-actions">
        {!otherPerson ? (
          <button type="button" className="btn btn-primary" disabled={decision === null || busy || done} aria-busy={busy || undefined} onClick={() => decision && void decide(decision)}>
            {copy.card.save}
          </button>
        ) : null}
        {!otherPerson && !editing && !done ? (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>
            {copy.card.edit}
          </button>
        ) : null}
        {!done ? (
          <button type="button" className="btn btn-ghost" onClick={() => setOutcome("LEFT_OUT")}>
            {copy.card.leaveOut}
          </button>
        ) : null}
        {/* Finding N-1: the card's manual-entry button names its destination (blank entry; nothing is carried over). */}
        <button type="button" className="btn btn-ghost" onClick={onManualEntry}>
          {candidate.kind === "GLUCOSE_READING" ? copy.card.manualGlucose : candidate.kind === "MEAL_NOTE" ? copy.card.manualMeal : copy.card.manualMedicine}
        </button>
      </div>
      <p role="status" className="voice-fact-status">
        {outcome === "SAVED" ? copy.card.saved : outcome === "OUT_OF_RANGE" ? copy.card.outOfRange : outcome === "NOT_SAVED" || outcome === "REJECTED" ? copy.card.notSaved : ""}
      </p>

      {asking && candidate.kind === "MEDICATION_OCCURRENCE" ? (
        <MedicineClarificationDialog
          phrase={candidate.medicineRef.phrase}
          options={medicines}
          copy={copy}
          rememberable={isRememberableTerminologyPhrase(normaliseVoicePhrase(candidate.medicineRef.phrase, language), language)}
          onLeaveOut={() => setAsking(false)}
          onChoose={(choice, remember) => {
            setPicked(choice);
            setAsking(false);
            if (remember) {
              void onRemember(candidate.medicineRef.phrase, choice)
                .then((ok) => setRememberNote(ok ? copy.card.remembered : copy.card.rememberFailed))
                .catch(() => setRememberNote(copy.card.rememberFailed));
            }
          }}
        />
      ) : null}
    </article>
  );
}
