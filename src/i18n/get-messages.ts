import type { SupportedLocale, AppMessages } from "./types";
import { enSGMessages } from "./messages/en-SG";
import { zhSGMessages } from "./messages/zh-SG";

export function getMessages(locale: SupportedLocale): AppMessages {
  switch (locale) {
    case "en-SG":
      return enSGMessages;
    case "zh-SG":
      return zhSGMessages;
  }
}
