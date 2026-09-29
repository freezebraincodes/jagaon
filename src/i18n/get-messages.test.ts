import { describe, it, expect } from "vitest";
import { getMessages } from "./get-messages";
import type { AppMessages } from "./types";

describe("getMessages", () => {
  it("returns the exact en-SG values", () => {
    const messages = getMessages("en-SG");
    expect(messages).toEqual<AppMessages>({
      appName: "JagaOn",
      foundationStatus: "Project foundation is running",
      demoBoundary:
        "Hackathon demo. This prototype uses synthetic data only and is not for patient use.",
    });
  });

  it("returns the exact zh-SG values", () => {
    const messages = getMessages("zh-SG");
    expect(messages).toEqual<AppMessages>({
      appName: "JagaOn",
      foundationStatus: "项目基础架构已启动",
      demoBoundary:
        "黑客松演示版本。本原型只使用模拟资料，不可用于实际病患护理。",
    });
  });

  it("has identical keys in both locales", () => {
    const en = getMessages("en-SG");
    const zh = getMessages("zh-SG");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });
});
