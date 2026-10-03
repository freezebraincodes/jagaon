import type { SupportedLocale } from "@/domain/patient-settings/locale";
import { getMessages } from "@/i18n/get-messages";
import type { BarrierPresentationCopy } from "@/application/inquiry/inquiry-service";
import { formatScheduleDate } from "./schedule-format";

/**
 * Builds the deterministic `medication-occasion-barrier.dialog` v1 template
 * copy from the reviewed en-SG/zh-SG catalogue. No other wording source exists.
 */

export function barrierPresentationCopyFor(locale: SupportedLocale): BarrierPresentationCopy {
  const copy = getMessages(locale).schedule;
  return {
    template: {
      barrierWhy: copy.barrierWhy,
      barrierQuestion: copy.barrierQuestion,
      optionLabels: {
        FORGOT: copy.barrierForgot,
        ROUTINE_CHANGED: copy.barrierRoutineChanged,
        AWAY_FROM_HOME: copy.barrierAway,
        ACCESS_DIFFICULTY: copy.barrierAccess,
        SIDE_EFFECT_CONCERN: copy.barrierSideEffectConcern,
      },
    },
    statusLabel: (state) => (state === "MISSED" ? copy.optionSkipped : copy.optionNotSure),
    occasionDate: (localDate) => formatScheduleDate(locale, localDate),
  };
}
