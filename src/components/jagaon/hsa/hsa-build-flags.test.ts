import { describe, expect, it } from "vitest";
import { parseHsaBuildFlags } from "./hsa-build-flags";

describe("HSA build flags", () => {
  it("unset: the switch is available and the app starts bounded", () => {
    expect(parseHsaBuildFlags({})).toEqual({ switchAvailable: true, boundedByDefault: true });
  });

  it("BOUNDED_DEFAULT=off (the judges' demo): the switch is available and the app starts in preview", () => {
    expect(parseHsaBuildFlags({ boundedDefault: "off" })).toEqual({ switchAvailable: true, boundedByDefault: false });
  });

  it("PREVIEW=off (a public release): no switch and always bounded, whatever the default says", () => {
    expect(parseHsaBuildFlags({ preview: "off" })).toEqual({ switchAvailable: false, boundedByDefault: true });
    expect(parseHsaBuildFlags({ preview: "off", boundedDefault: "off" })).toEqual({ switchAvailable: false, boundedByDefault: true });
  });

  it("only the exact value off changes anything", () => {
    expect(parseHsaBuildFlags({ preview: "OFF", boundedDefault: "false" })).toEqual({ switchAvailable: true, boundedByDefault: true });
    expect(parseHsaBuildFlags({ preview: "", boundedDefault: " off" })).toEqual({ switchAvailable: true, boundedByDefault: true });
  });
});
