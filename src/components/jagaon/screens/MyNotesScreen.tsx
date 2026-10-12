"use client";

import type { AppMessages } from "@/i18n/types";
import { PencilIcon } from "../primitives/Icons";
import { Notice, ScreenHeader } from "../primitives/ScreenHeader";

type MyNotesScreenProps = {
  messages: AppMessages;
};

/**
 * Owner decision 2026-10-12: My notes, reached from More, will gather what the person tells JagaOn about how they feel. This first
 * version is the destination only: it reads and stores nothing yet.
 */
export function MyNotesScreen({ messages }: MyNotesScreenProps) {
  const msg = messages.myNotes;
  return (
    <div className="screen-page my-notes-screen">
      <ScreenHeader title={msg.title} />
      <Notice icon={<PencilIcon size={20} />}>{msg.empty}</Notice>
    </div>
  );
}
