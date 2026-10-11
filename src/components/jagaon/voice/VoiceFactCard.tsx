"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoiceFactDecision } from "@/application/voice/voice-review-contract";
import { glucoseHedgeMarked, glucoseNeedsConfirmation, type VoiceFactCandidate, type VoiceLanguage } from "@/domain/voice/voice-contracts";
import { formatMmolEntry, isMmolEntryTyping } from "@/domain/voice/glucose-entry-format";
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
 * - CR-11 (owner decisions 2026-10-11, design v3.1; replaces the 13s.3 OUT_OF_RANGE refusal): a glucose value above 50 mmol/L, or
 *   zero, opens the confirmation panel INSIDE this card: the formatted value and unit as its heading ("60.0 mmol/L"), the approved
 *   verification copy, and Save as shown / Edit reading / Cancel (nothing preselected; focus moves to the heading when the person
 *   opens it). The panel is a per-reading LATCH: once triggered, every later save of this reading (also an edit to 45) goes through
 *   it. Cancel writes nothing and returns the card to its unsaved state. An unstated unit outside the app-default window needs the
 *   explicit "Yes, mmol/L" inside the panel. Values are always shown formatted to one decimal ("60" → "60.0"); the edit field
 *   refuses more than one decimal digit (typing or paste), never trimming or rounding. No warning, advice or "verified" wording.
 * - 13s.3: a reported amount is shown exactly as kept, with a plain line saying whether it will be stored (only on a TAKEN event saved
 *   through the review, never through an edit).
 * The authoritative check is the review contract (the screen builds a decision; `onDecide` returns the outcome).
 */
export type VoiceFactOutcome = "SAVED" | "NOT_SAVED" | "REJECTED";

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
  // CR-11: the proposal is shown formatted (one decimal) and, above 50 or at zero, starts with the confirmation panel open (the latch).
  const proposalShown = candidate.kind === "GLUCOSE_READING" && !needsEdit && !otherPerson;
  const proposedValue = candidate.kind === "GLUCOSE_READING" ? (formatMmolEntry(candidate.valueText) ?? candidate.valueText) : "";
  // Round 5 (revised B): a hedged proposal ("about 7.8", "~7", 七点八左右) always starts with the confirmation panel open too (latched).
  const triggeredAtStart = proposalShown && (glucoseNeedsConfirmation(proposedValue) || glucoseHedgeMarked(candidate.sourcePhrase));
  const [latched, setLatched] = useState(triggeredAtStart);
  const [confirming, setConfirming] = useState(triggeredAtStart);
  /** The edited value awaiting confirmation (formatted), or null when the panel confirms the proposal itself. */
  const [confirmEdit, setConfirmEdit] = useState<string | null>(null);
  const [formatRefused, setFormatRefused] = useState(false);
  const [rawEdit, setRawEdit] = useState<string | null>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const focusPanel = useRef(false);
  useEffect(() => {
    if (confirming && focusPanel.current) {
      focusPanel.current = false;
      panelHeading.current?.focus();
    }
  }, [confirming]);
  // CR-11 fix round 1 (I-2): where focus goes after the panel closes, so it never falls back to the page body.
  const cardHeading = useRef<HTMLHeadingElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const focusAfter = useRef<"EDIT" | "CANCEL" | "SAVED" | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    if (target === "EDIT" && editing) valueInput.current?.focus();
    else if (target === "CANCEL" && !confirming) (saveButton.current && !saveButton.current.disabled ? saveButton.current : cardHeading.current)?.focus();
    else if (target === "SAVED" && outcome !== null) {
      if (outcome === "SAVED") statusLine.current?.focus();
    } else return;
    focusAfter.current = null;
  }, [editing, confirming, outcome]);
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
    if (candidate.kind === "GLUCOSE_READING") {
      const formatted = formatMmolEntry(editValue);
      return formatted === null ? null : { candidateIndex: index, action: "SAVE", edit: { kind: "GLUCOSE_READING", valueText: formatted, unit: "MMOL_PER_L" } };
    }
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

  const decision = editing ? editDecision() : !needsEdit && !otherPerson ? directDecision() : null;

  /** CR-11: open the confirmation panel (by the person's action, so focus moves to its heading). */
  function openPanel(editedValue: string | null) {
    focusPanel.current = true;
    setLatched(true);
    setConfirmEdit(editedValue);
    setEditing(false);
    setConfirming(true);
  }

  /** The card's own Save: a latched or triggering glucose reading goes to the confirmation panel instead of saving. */
  function save() {
    if (!decision) return;
    if (candidate.kind === "GLUCOSE_READING") {
      const value = editing ? formatMmolEntry(editValue) : proposedValue;
      if (value !== null && (latched || glucoseNeedsConfirmation(value))) return openPanel(editing ? value : null);
    }
    void decide(decision);
  }

  /** Save as shown: the decision for exactly what the panel shows, with the explicit confirmation. */
  const confirmedDecision: VoiceFactDecision | null =
    candidate.kind !== "GLUCOSE_READING"
      ? null
      : confirmEdit !== null
        ? { candidateIndex: index, action: "SAVE", edit: { kind: "GLUCOSE_READING", valueText: confirmEdit, unit: "MMOL_PER_L" }, confirmed: true }
        : (() => {
            const direct = !needsEdit && !otherPerson ? directDecision() : null;
            return direct && direct.action === "SAVE" ? { ...direct, confirmed: true as const } : null;
          })();

  function editReading() {
    focusAfter.current = "EDIT";
    setConfirming(false);
    setEditing(true);
    if (confirmEdit === null) setEditValue("");
  }

  function cancelConfirmation() {
    focusAfter.current = "CANCEL";
    setConfirming(false);
    setConfirmEdit(null);
    setEditing(false);
  }

  function changeEditValue(next: string) {
    setRawEdit(null);
    if (!isMmolEntryTyping(next)) {
      setFormatRefused(true);
      return;
    }
    setFormatRefused(false);
    setEditValue(next);
  }

  /** Completion formatting on leaving the field ("9" → "9.0"); returning to the field restores what was typed. */
  function completeEditValue() {
    const formatted = formatMmolEntry(editValue);
    if (formatted !== null && formatted !== editValue) {
      setRawEdit(editValue);
      setEditValue(formatted);
    }
  }

  function resumeEditValue() {
    if (rawEdit !== null) {
      setEditValue(rawEdit);
      setRawEdit(null);
    }
  }

  const unitBlock =
    candidate.kind === "GLUCOSE_READING" ? (
      <>
        {candidate.unitSource === "SPOKEN" ? <p>{copy.card.unitSpoken}</p> : null}
        {candidate.unitSource === "APP_DEFAULT" ? <p>{copy.card.unitAppDefault}</p> : null}
        {candidate.unit === "UNSTATED" ? (
          <>
            <p>{copy.review.unitUnstated}</p>
            <label className="choice-row">
              <input type="checkbox" checked={unitTicked} disabled={done} onChange={(event) => setUnitTicked(event.target.checked)} />
              <span>{copy.card.confirmUnit}</span>
            </label>
          </>
        ) : null}
      </>
    ) : null;
  const panelOpen = candidate.kind === "GLUCOSE_READING" && confirming && !done && !otherPerson;
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
      <h3 id={`${ids}-heading`} ref={cardHeading} tabIndex={-1} className="voice-fact-heading">
        {heading}
      </h3>
      <p className="voice-fact-phrase">“{candidate.sourcePhrase}”</p>

      {candidate.kind === "GLUCOSE_READING" && !editing && !panelOpen && (proposalShown || confirmEdit !== null) ? (
        <div className="voice-fact-body">
          <p className="voice-fact-value">{confirmEdit ?? proposedValue}</p>
          {confirmEdit === null ? unitBlock : <p>{copy.card.unitText}</p>}
        </div>
      ) : null}

      {panelOpen ? (
        <section className="voice-confirm" aria-labelledby={`${ids}-confirm-heading`} data-voice-confirm="">
          <h4 id={`${ids}-confirm-heading`} ref={panelHeading} tabIndex={-1} className="voice-confirm-value">
            {`${confirmEdit ?? proposedValue} ${copy.card.unitText}`}
          </h4>
          {confirmEdit === null ? unitBlock : null}
          <p>{copy.card.confirmBody}</p>
          <div className="voice-confirm-actions">
            <button type="button" className="btn btn-primary" disabled={confirmedDecision === null || busy || done} aria-busy={busy || undefined} onClick={() => {
                if (!confirmedDecision) return;
                focusAfter.current = "SAVED";
                void decide(confirmedDecision);
              }}>
              {copy.card.saveAsShown}
            </button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={editReading}>
              {copy.card.editReading}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={cancelConfirmation}>
              {copy.card.cancel}
            </button>
          </div>
        </section>
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
      {needsEdit && !otherPerson && !editing && !panelOpen && confirmEdit === null && candidate.ambiguity.some((reason) => (EDIT_ONLY as readonly string[]).includes(reason)) ? <p className="voice-fact-warning">{copy.card.needsEdit}</p> : null}

      {editing ? (
        <div className="voice-fact-edit">
          {candidate.kind === "GLUCOSE_READING" ? (
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-value`}>
                {copy.card.valueLabel}
              </label>
              <input
                id={`${ids}-value`}
                ref={valueInput}
                className="input"
                inputMode="decimal"
                autoComplete="off"
                value={editValue}
                onChange={(event) => changeEditValue(event.target.value)}
                onBlur={completeEditValue}
                onFocus={resumeEditValue}
                aria-invalid={formatRefused || undefined}
                aria-describedby={`${ids}-value-hint${formatRefused ? ` ${ids}-value-error` : ""}`}
              />
              <p id={`${ids}-value-hint`} className="field-hint">
                {copy.card.enterValueYourself}
              </p>
              {formatRefused ? (
                <p id={`${ids}-value-error`} className="field-error" role="alert">
                  {copy.card.valueFormatRefused}
                </p>
              ) : null}
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
        {!otherPerson && !panelOpen ? (
          <button ref={saveButton} type="button" className="btn btn-primary" disabled={(decision === null && !(latched && !editing && proposalShown)) || busy || done} aria-busy={busy || undefined} onClick={() => (latched && !editing && proposalShown ? openPanel(null) : save())}>
            {copy.card.save}
          </button>
        ) : null}
        {!otherPerson && !editing && !done && !panelOpen ? (
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
      <p role="status" ref={statusLine} tabIndex={-1} className="voice-fact-status">
        {outcome === "SAVED" ? copy.card.saved : outcome === "NOT_SAVED" || outcome === "REJECTED" ? copy.card.notSaved : ""}
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
