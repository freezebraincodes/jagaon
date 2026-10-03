import { describe, expect, it } from "vitest";
import { hashCanonicalJson, canonicalizeJson } from "@/application/contracts/canonical-json";
import {
  addDays,
  canonicalDecimal,
  compareRational,
  decimal,
  distinctLocalDates,
  fingerprint,
  formatRatio6,
  intervalOverlapRatio,
  localDateOf,
  median,
  rationalAbs,
  rationalDivide,
  rationalSubtract,
  sha256Hex,
  sortByInstantThenRevision,
  sortRevisionRefs,
  tukeyHinges,
  weekBlockIndex,
} from "./metrics";

const dec = (values: string[]) => values.map(decimal);
const show = (value: ReturnType<typeof decimal>) => canonicalDecimal(value);

describe("exact decimal arithmetic", () => {
  it("parses and serialises canonical decimals without floating point", () => {
    expect(show(decimal("06.50"))).toBe("6.5");
    expect(show(decimal("-0.0"))).toBe("0");
    expect(show(rationalSubtract(decimal("7.3"), decimal("6.1")))).toBe("1.2");
    expect(show(rationalSubtract(decimal("0.1"), decimal("0.3")))).toBe("-0.2");
    expect(compareRational(decimal("1.0"), decimal("1"))).toBe(0);
    expect(show(rationalAbs(decimal("-2.25")))).toBe("2.25");
  });

  it("refuses to serialise a non-terminating ratio as a decimal", () => {
    expect(() => canonicalDecimal(rationalDivide(decimal("1"), decimal("3")))).toThrow("NON_TERMINATING_DECIMAL");
    expect(formatRatio6(rationalDivide(decimal("1"), decimal("3")))).toBe("0.333333");
    expect(formatRatio6(rationalDivide(decimal("2"), decimal("3")))).toBe("0.666667");
    expect(formatRatio6(rationalDivide(decimal("1"), decimal("2")))).toBe("0.5");
    expect(formatRatio6(decimal("0"))).toBe("0");
  });

  it("computes the median as the middle value or the exact mean of the two middle values", () => {
    expect(show(median(dec(["6.2", "5.1", "7.0"])))).toBe("6.2");
    expect(show(median(dec(["6.1", "5.8", "6.4", "7.0"])))).toBe("6.25");
    expect(() => median([])).toThrow("EMPTY_SAMPLE");
  });

  it("computes Tukey hinges including the median in both halves for odd samples", () => {
    const odd = tukeyHinges(dec(["1", "2", "3", "4", "5"]));
    expect([show(odd.q1), show(odd.q3), show(odd.iqr)]).toEqual(["2", "4", "2"]);
    const even = tukeyHinges(dec(["1", "2", "3", "4", "5", "6"]));
    expect([show(even.q1), show(even.q3), show(even.iqr)]).toEqual(["2", "5", "3"]);
    const single = tukeyHinges(dec(["5.5"]));
    expect([show(single.q1), show(single.q3), show(single.iqr)]).toEqual(["5.5", "5.5", "0"]);
  });

  it("is independent of input order", () => {
    const a = dec(["7.1", "6.2", "5.9", "8.4", "6.6"]);
    const b = [...a].reverse();
    expect(show(median(a))).toBe(show(median(b)));
    expect(show(tukeyHinges(a).iqr)).toBe(show(tukeyHinges(b).iqr));
  });

  it("computes interval overlap as intersection over union with the zero-width rules", () => {
    expect(formatRatio6(intervalOverlapRatio([decimal("1"), decimal("3")], [decimal("2"), decimal("4")]))).toBe("0.333333");
    expect(formatRatio6(intervalOverlapRatio([decimal("1"), decimal("2")], [decimal("3"), decimal("4")]))).toBe("0");
    expect(formatRatio6(intervalOverlapRatio([decimal("5"), decimal("5")], [decimal("5"), decimal("5")]))).toBe("1");
    expect(formatRatio6(intervalOverlapRatio([decimal("5"), decimal("5")], [decimal("6"), decimal("6")]))).toBe("0");
    expect(formatRatio6(intervalOverlapRatio([decimal("1"), decimal("4")], [decimal("2"), decimal("3")]))).toBe("0.333333");
  });
});

describe("local dates, weeks and canonical ordering", () => {
  it("derives the local date from the recorded offset, not UTC", () => {
    expect(localDateOf("2026-10-02T16:30:00.000Z", 480)).toBe("2026-10-03");
    expect(localDateOf("2026-10-02T15:59:00.000Z", 480)).toBe("2026-10-02");
    expect(addDays("2026-10-03T16:00:00.000Z", -14)).toBe("2026-09-19T16:00:00.000Z");
  });

  it("counts distinct local dates", () => {
    expect(
      distinctLocalDates([
        { instant: "2026-10-01T23:00:00.000Z", utcOffsetMinutes: 480 },
        { instant: "2026-10-02T03:00:00.000Z", utcOffsetMinutes: 480 },
        { instant: "2026-10-02T17:00:00.000Z", utcOffsetMinutes: 480 },
      ]),
    ).toBe(2);
  });

  it("assigns fixed seven-day blocks counted back from the window end", () => {
    const end = "2026-10-03T16:00:00.000Z";
    expect(weekBlockIndex("2026-10-03T15:59:59.000Z", end)).toBe(0);
    expect(weekBlockIndex("2026-09-26T16:00:00.000Z", end)).toBe(0);
    expect(weekBlockIndex("2026-09-26T15:59:59.000Z", end)).toBe(1);
  });

  it("orders refs and instants deterministically regardless of input order", () => {
    const refs = [
      { recordType: "GLUCOSE_READING", recordId: "b", revisionId: "2" },
      { recordType: "GLUCOSE_READING", recordId: "a", revisionId: "9" },
      { recordType: "INTAKE_EVENT", recordId: "a", revisionId: "1" },
    ];
    expect(sortRevisionRefs(refs as never).map((r) => r.recordId)).toEqual(["a", "b", "a"]);
    const items = [
      { instant: "2026-10-02T00:00:00.000Z", revisionId: "b" },
      { instant: "2026-10-01T00:00:00.000Z", revisionId: "z" },
      { instant: "2026-10-02T00:00:00.000Z", revisionId: "a" },
    ];
    expect(sortByInstantThenRevision(items).map((i) => i.revisionId)).toEqual(["z", "a", "b"]);
  });
});

describe("canonical fingerprints", () => {
  it("computes SHA-256 identically to Web Crypto", async () => {
    for (const value of [{ a: 1, b: ["x", "雞飯"] }, { evaluator: "pattern.comparable-slot-trend", cutoff: 12 }]) {
      expect(fingerprint(value)).toBe(await hashCanonicalJson(value));
    }
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is independent of object key order", () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
});
