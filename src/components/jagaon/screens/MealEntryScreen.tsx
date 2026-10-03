"use client";

import { useRef, useState, type FormEvent } from "react";
import { type AppMessages, type SupportedLocale } from "@/i18n/types";
import type { DemoPatientProfile } from "@/application/governed/demo-scenario-fixture";
import type { IntakeEventPayload } from "@/domain/health-records/intake-event";
import { labelWithAside } from "../locale-format";
import { Banner } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ChoiceGroup } from "../primitives/ChoiceGroup";
import { InputField, TextareaField } from "../primitives/Field";
import { CheckIcon, PlusIcon, SaveIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";
import { TimeCard } from "../primitives/TimeCard";
import { ToggleChips } from "../primitives/ToggleChips";
import type { JournalCommandService } from "@/application/journal/journal-contracts";
import type { Instant } from "@/domain/shared/time";
import {
  exactSingaporeOccurrence,
  formatSingaporeTime,
  singaporeNowParts,
  singaporeWallClockToInstant,
} from "../journal/singapore-time";

type MealEntryScreenProps = {
  messages: AppMessages;
  locale: SupportedLocale;
  fixture: DemoPatientProfile;
  commandService: JournalCommandService;
  goBack: () => void;
  onCommitted?: () => void | Promise<void>;
};

type MealKind =
  | "MEAL"
  | "SNACK"
  | "TEA_WITH_FOOD"
  | "TEA_WITHOUT_FOOD"
  | "DESSERT"
  | "DRINK"
  | "NOT_SURE";

type MealSlot = "BREAKFAST" | "LUNCH" | "DINNER" | "SUPPER";

type Portion = "SMALL" | "USUAL" | "BIG";

type CustomItem = {
  id: string;
  label: string;
  quantity: string;
};

/**
 * Exact mapping from the chosen category to the domain's intake facts. Only
 * what the category itself states is recorded; everything else is UNKNOWN.
 */
function intakeFacts(
  kind: MealKind | null,
): Pick<IntakeEventPayload, "intakeKind" | "foodIncluded" | "drinkIncluded"> {
  switch (kind) {
    case "MEAL":
      return { intakeKind: "MEAL", foodIncluded: "YES", drinkIncluded: "UNKNOWN" };
    case "SNACK":
      return { intakeKind: "SNACK", foodIncluded: "YES", drinkIncluded: "UNKNOWN" };
    case "TEA_WITH_FOOD":
      return { intakeKind: "TEA", foodIncluded: "YES", drinkIncluded: "YES" };
    case "TEA_WITHOUT_FOOD":
      return { intakeKind: "TEA", foodIncluded: "NO", drinkIncluded: "YES" };
    case "DESSERT":
      return { intakeKind: "DESSERT", foodIncluded: "YES", drinkIncluded: "UNKNOWN" };
    case "DRINK":
      return { intakeKind: "DRINK", foodIncluded: "UNKNOWN", drinkIncluded: "YES" };
    case "NOT_SURE":
    case null:
      return { intakeKind: "OTHER", foodIncluded: "UNKNOWN", drinkIncluded: "UNKNOWN" };
  }
}

export function MealEntryScreen({
  messages,
  locale,
  fixture,
  commandService,
  onCommitted,
}: MealEntryScreenProps) {
  const msg = messages.meal;
  const [kind, setKind] = useState<MealKind | null>(null);
  const [slot, setSlot] = useState<MealSlot | null>(null);
  const [usuals, setUsuals] = useState<string[]>([]);
  const [customItems, setCustomItems] = useState<CustomItem[]>([]);
  const [portion, setPortion] = useState<Portion | null>(null);
  const [initialTime] = useState(() => singaporeNowParts().time);
  const [time, setTime] = useState(initialTime);
  const [note, setNote] = useState("");
  const [timeError, setTimeError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notSaved, setNotSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextItemId = useRef(1);
  const lastAddedRef = useRef<HTMLInputElement>(null);

  const portionLabels: Record<Portion, string> = {
    SMALL: msg.portionSmall,
    USUAL: msg.portionUsual,
    BIG: msg.portionBig,
  };
  const instant = singaporeWallClockToInstant(singaporeNowParts().date, time);
  const timeText = instant
    ? (time === initialTime ? messages.shared.nowAt : messages.shared.todayAt)(
        formatSingaporeTime(locale, instant),
      )
    : messages.shared.requiredField;

  const typedItems = customItems.filter((item) => item.label.trim().length > 0);
  const canSave = kind !== null || usuals.length > 0 || typedItems.length > 0;
  const numbered = customItems.length > 1;
  const itemName = (index: number) => (numbered ? `${msg.itemLabel} ${index + 1}` : msg.itemLabel);

  function edited() {
    setSaved(false);
  }

  function addItem() {
    const id = `item-${nextItemId.current++}`;
    setCustomItems((prev) => [...prev, { id, label: "", quantity: "" }]);
    edited();
    // Focus the new item's first field once it renders.
    requestAnimationFrame(() => lastAddedRef.current?.focus());
  }

  function updateItem(id: string, field: "label" | "quantity", value: string) {
    setCustomItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
    edited();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setTimeError(instant ? null : messages.shared.requiredField);
    if (!canSave || !instant) return;

    // A usual only contributes the text the person would otherwise type.
    const items = [
      ...fixture.usualFoods
        .filter((food) => usuals.includes(food.id))
        .map((food) => ({ kind: food.kind, label: food.label, quantityText: food.quantityText })),
      ...typedItems.map((item) => ({
        kind: "FOOD" as const,
        label: item.label.trim(),
        ...(item.quantity.trim() ? { quantityText: item.quantity.trim() } : {}),
      })),
    ];
    // The domain has no portion field, so the chosen portion is kept, as the
    // person chose it, at the start of their own note.
    const noteText = [portion ? msg.portionNote(portionLabels[portion]) : null, note.trim() || null]
      .filter(Boolean)
      .join("\n");

    setSaved(false);
    setNotSaved(false);
    setBusy(true);
    const result = await commandService.recordMeal({
      payload: {
        ...intakeFacts(kind),
        ...(kind === "MEAL" && slot ? { intakeSlot: { kind: "STANDARD_MEAL" as const, code: slot } } : {}),
        occasion: "ROUTINE",
        items,
        ...(noteText ? { patientNote: { text: noteText, language: locale } } : {}),
      },
      temporal: exactSingaporeOccurrence(instant),
      recordedAt: new Date().toISOString() as Instant,
    });
    setBusy(false);
    if (result.kind === "COMMITTED") {
      setSaved(true);
      await onCommitted?.();
      return;
    }
    setNotSaved(true);
  }

  return (
    <div className="screen-page journal-entry-screen meal-entry-screen">
      <ScreenHeader title={msg.screenTitle} subtitle={msg.subtitle} />

      {saved ? <Banner variant="success">{msg.saved}</Banner> : null}
      {notSaved ? <Banner variant="error">{messages.shared.notSaved}</Banner> : null}

      <form onSubmit={handleSubmit} className="entry-form" noValidate>
        <ChoiceGroup<MealKind>
          legend={msg.whatWasIt}
          options={[
            { value: "MEAL", label: msg.kindMeal },
            { value: "SNACK", label: msg.kindSnack },
            { value: "TEA_WITH_FOOD", label: msg.kindTeaWithFood },
            { value: "TEA_WITHOUT_FOOD", label: msg.kindTeaWithoutFood },
            { value: "DESSERT", label: msg.kindDessert },
            { value: "DRINK", label: msg.kindDrink },
            { value: "NOT_SURE", label: msg.kindNotSure },
          ]}
          value={kind}
          onChange={(next) => {
            setKind(next);
            if (next !== "MEAL") setSlot(null);
            edited();
          }}
        />

        {kind === "MEAL" ? (
          <ToggleChips<MealSlot>
            label={labelWithAside(locale, msg.typeLabel, messages.shared.optional)}
            heading={<p className="eyebrow">{labelWithAside(locale, msg.typeLabel, messages.shared.optional)}</p>}
            options={[
              { value: "BREAKFAST", label: msg.breakfast },
              { value: "LUNCH", label: msg.lunch },
              { value: "DINNER", label: msg.dinner },
              { value: "SUPPER", label: msg.supper },
            ]}
            selected={slot ? [slot] : []}
            onToggle={(value) => {
              setSlot((current) => (current === value ? null : value));
              edited();
            }}
          />
        ) : null}

        <div className="usuals" role="group" aria-labelledby="meal-usuals-heading">
          <p className="eyebrow" id="meal-usuals-heading">
            {msg.usualsHeading}
          </p>
          <div className="usual-grid">
            {fixture.usualFoods.map((food) => {
              const pressed = usuals.includes(food.id);
              return (
                <button
                  key={food.id}
                  type="button"
                  className="usual-card"
                  aria-pressed={pressed}
                  onClick={() => {
                    setUsuals((prev) =>
                      prev.includes(food.id) ? prev.filter((id) => id !== food.id) : [...prev, food.id],
                    );
                    edited();
                  }}
                >
                  <span className="usual-label">{food.label}</span>
                  <span className="usual-quantity">{food.quantityText}</span>
                  {pressed ? <CheckIcon size={20} className="icon usual-check" /> : null}
                </button>
              );
            })}
            <button type="button" className="add-tile usual-add" onClick={addItem}>
              <PlusIcon size={26} />
              {msg.somethingElse}
            </button>
          </div>
        </div>

        {customItems.length > 0 ? (
          <div className="meal-items">
            {customItems.map((item, index) => (
              <div key={item.id} className="meal-item-card">
                <InputField
                  ref={index === customItems.length - 1 ? lastAddedRef : undefined}
                  label={itemName(index)}
                  value={item.label}
                  onChange={(e) => updateItem(item.id, "label", e.target.value)}
                  autoComplete="off"
                />
                <InputField
                  label={numbered ? `${msg.quantityLabel} ${index + 1}` : msg.quantityLabel}
                  value={item.quantity}
                  onChange={(e) => updateItem(item.id, "quantity", e.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="text-link text-link--quiet"
                  onClick={() => {
                    setCustomItems((prev) => prev.filter((candidate) => candidate.id !== item.id));
                    edited();
                  }}
                >
                  {msg.removeItem(item.label.trim() || itemName(index))}
                </button>
              </div>
            ))}
            <button type="button" className="text-link" onClick={addItem}>
              <PlusIcon size={18} />
              {msg.addItem}
            </button>
          </div>
        ) : null}

        <div className="segmented-chips">
          <ToggleChips<Portion>
            label={msg.portionLabel}
            heading={
              <p className="eyebrow">
                {labelWithAside(locale, msg.portionLabel, messages.shared.optional)}
              </p>
            }
            options={[
              { value: "SMALL", label: msg.portionSmall },
              { value: "USUAL", label: msg.portionUsual },
              { value: "BIG", label: msg.portionBig },
            ]}
            selected={portion ? [portion] : []}
            onToggle={(value) => {
              setPortion((current) => (current === value ? null : value));
              edited();
            }}
          />
        </div>

        <TimeCard
          label={msg.timeLabel}
          summary={timeText}
          editLabel={messages.readingTime.editTime}
          editorMessages={messages.readingTime}
          type="time"
          value={time}
          onChange={(next) => {
            setTime(next);
            setTimeError(null);
            edited();
          }}
          error={timeError ?? undefined}
        />

        <TextareaField
          label={labelWithAside(locale, msg.noteLabel, messages.shared.optional)}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            edited();
          }}
          rows={2}
        />

        <Notice>{msg.noNutritionInference}</Notice>

        <div className="save-block">
          <Button
            type="submit"
            variant="primary"
            className="btn-hero"
            busy={busy}
            disabled={saved || !canSave}
          >
            <SaveIcon size={24} />
            {busy ? messages.shared.saving : msg.saveIntake}
          </Button>
          {!canSave ? <p className="save-footnote">{msg.chooseToSave}</p> : null}
        </div>
      </form>
    </div>
  );
}
