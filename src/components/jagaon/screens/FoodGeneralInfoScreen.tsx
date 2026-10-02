"use client";

import { type AppMessages } from "@/i18n/types";
import { BookIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";

type FoodGeneralInfoScreenProps = {
  messages: AppMessages;
  goBack: () => void;
};

export function FoodGeneralInfoScreen({ messages }: FoodGeneralInfoScreenProps) {
  const msg = messages.food;

  return (
    <div className="screen-page food-general-screen">
      <ScreenHeader title={msg.generalInfoTitle} />
      <Notice icon={<BookIcon size={20} />}>{msg.generalInfoLimit}</Notice>
      <section className="unavailable-card" aria-labelledby="food-general-unavailable">
        <p id="food-general-unavailable" className="unavailable-text">
          {msg.reviewedInfoUnavailable}
        </p>
      </section>
    </div>
  );
}
