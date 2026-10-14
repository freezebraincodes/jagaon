"use client";

import { useEffect, useState } from "react";
import type { AppMessages } from "@/i18n/types";
import type { MealSwap } from "@/application/preview/meal-ideas-data";
import { mealIdeaSlotAt, pickMealIdeas, type MealIdeaSlot } from "@/application/preview/meal-ideas";
import type { ScreenId } from "../screen-manifest";
import { InfoIcon, PinIcon } from "../primitives/Icons";
import { PreviewTag, useHsaBoundedMode } from "./hsa-bounded-mode";

type MealIdeasCardProps = {
  messages: AppMessages;
  now: Date;
  navigate: (screen: ScreenId, params?: Record<string, string>) => void;
};

/**
 * Owner decision 2026-10-14 (HSA-bounded mode, PREVIEW "Meal ideas"): three general food swaps for the current meal, from a static
 * list, with a way into Food information already filtered to "Higher in wholegrains". Renders nothing while HSA-bounded mode is ON.
 */
export function MealIdeasCard(props: MealIdeasCardProps) {
  const { bounded } = useHsaBoundedMode();
  if (bounded) return null;
  return <MealIdeasPreview {...props} />;
}

type MealIdeasData = Readonly<Record<MealIdeaSlot, readonly MealSwap[]>>;

function MealIdeasPreview({ messages, now, navigate }: MealIdeasCardProps) {
  const msg = messages.hsaMealIdeas;
  // The list is only fetched once the preview is shown (never while HSA-bounded mode is ON).
  const [data, setData] = useState<MealIdeasData | null>(null);
  useEffect(() => {
    let active = true;
    void import("@/application/preview/meal-ideas-data").then((module) => {
      if (active) setData(module.MEAL_IDEAS);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!data) return null;

  const slot = mealIdeaSlotAt(now);
  const swaps = pickMealIdeas(data[slot], now);
  const heading = { BREAKFAST: msg.headingBreakfast, LUNCH: msg.headingLunch, DINNER: msg.headingDinner }[slot];

  return (
    <section className="today-card meal-ideas-card" aria-labelledby="meal-ideas-heading">
      <div className="meal-ideas-head">
        <PreviewTag messages={messages} />
        <h2 id="meal-ideas-heading" className="eyebrow">
          {heading}
        </h2>
      </div>
      <p className="meal-ideas-intro">{msg.intro}</p>
      <ul className="meal-ideas-list" lang="en">
        {swaps.map((swap) => (
          <li key={swap.id} className="meal-ideas-swap">
            <span className="meal-ideas-from">{swap.from}</span>
            <span className="meal-ideas-arrow" aria-hidden="true">
              →
            </span>
            <span className="sr-only"> {msg.swapJoin} </span>
            <span className="meal-ideas-to">{swap.to}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-outline btn-wide"
        onClick={() => navigate("NEARBY_FOOD", { attribute: "HIGHER_IN_WHOLEGRAINS" })}
      >
        <PinIcon size={22} />
        {msg.findPlaces}
      </button>
      <p className="provenance-line meal-ideas-note">
        <InfoIcon size={16} />
        {msg.note}
      </p>
    </section>
  );
}
