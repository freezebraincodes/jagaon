import { useRef } from "react";
import type { CommandId } from "@/application/contracts/command-event-identifiers";

/**
 * One command ID per distinct entered content: retrying the same entry after a
 * failure replays idempotently, while a changed entry gets a fresh command.
 */
export function useCommandIdFor(): (signature: string) => CommandId {
  const current = useRef<{ signature: string; id: CommandId } | null>(null);
  return (signature) => {
    if (current.current?.signature !== signature) {
      current.current = { signature, id: crypto.randomUUID() as CommandId };
    }
    return current.current.id;
  };
}
