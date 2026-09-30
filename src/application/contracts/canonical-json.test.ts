import { describe, it, expect } from "vitest";
import {
  sha256DigestSchema,
  canonicalizeJson,
  hashCanonicalJson,
  hashCommandEnvelope,
} from "./canonical-json";
import type { CommandEnvelope } from "./command-envelope";

// ---------------------------------------------------------------------------
// Sha256Digest schema
// ---------------------------------------------------------------------------

describe("sha256DigestSchema", () => {
  it("accepts a 64-character lowercase hex string", () => {
    const digest =
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
    expect(sha256DigestSchema.parse(digest)).toBe(digest);
  });

  it("rejects an uppercase hex digest", () => {
    expect(() =>
      sha256DigestSchema.parse(
        "43258CFF783FE7036D8A43033F830ADFC60EC037382473548AC742B888292777",
      ),
    ).toThrow();
  });

  it("rejects a wrong-length string", () => {
    expect(() =>
      sha256DigestSchema.parse(
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b88829277",
      ),
    ).toThrow();
    expect(() =>
      sha256DigestSchema.parse(
        "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b8882927777",
      ),
    ).toThrow();
  });

  it("rejects a non-hex string", () => {
    expect(() =>
      sha256DigestSchema.parse(
        "g3258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// canonicalizeJson
// ---------------------------------------------------------------------------

describe("canonicalizeJson", () => {
  it("produces sorted keys for a flat object", () => {
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("produces sorted keys at every depth", () => {
    const input = { z: { d: 4, c: 3 }, a: { b: 2, a: 1 } };
    expect(canonicalizeJson(input)).toBe(
      '{"a":{"a":1,"b":2},"z":{"c":3,"d":4}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("preserves strings exactly without trimming", () => {
    expect(canonicalizeJson("  hello  ")).toBe('"  hello  "');
  });

  it("preserves null, true, false", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(true)).toBe("true");
    expect(canonicalizeJson(false)).toBe("false");
  });

  it("preserves finite numbers", () => {
    expect(canonicalizeJson(0)).toBe("0");
    expect(canonicalizeJson(-1)).toBe("-1");
    expect(canonicalizeJson(3.14)).toBe("3.14");
  });

  it("sorts keys lexicographically by UTF-16 code unit", () => {
    // Unicode code point comparison: uppercase letters sort before lowercase.
    expect(canonicalizeJson({ B: 1, a: 2, A: 3, b: 4 })).toBe(
      '{"A":3,"B":1,"a":2,"b":4}',
    );
  });
});

// ---------------------------------------------------------------------------
// hashCanonicalJson
// ---------------------------------------------------------------------------

describe("hashCanonicalJson", () => {
  it('hashes {"a":1,"b":2} to the expected digest', async () => {
    const digest = await hashCanonicalJson({ a: 1, b: 2 });
    expect(digest).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("produces a 64-character lowercase hex digest", async () => {
    const digest = await hashCanonicalJson({ a: 1 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same digest for recursively reordered object keys", async () => {
    const ordered = { a: { c: 3, d: 4 }, b: { e: 5, f: 6 } };
    const reordered = { b: { f: 6, e: 5 }, a: { d: 4, c: 3 } };
    const [d1, d2] = await Promise.all([
      hashCanonicalJson(ordered),
      hashCanonicalJson(reordered),
    ]);
    expect(d1).toBe(d2);
  });

  it("produces the same canonical text for reordered keys", () => {
    const ordered = { a: { c: 3, d: 4 }, b: { e: 5, f: 6 } };
    const reordered = { b: { f: 6, e: 5 }, a: { d: 4, c: 3 } };
    expect(canonicalizeJson(ordered)).toBe(canonicalizeJson(reordered));
  });

  it("changes the digest when array order changes", async () => {
    const [d1, d2] = await Promise.all([
      hashCanonicalJson([1, 2, 3]),
      hashCanonicalJson([3, 2, 1]),
    ]);
    expect(d1).not.toBe(d2);
  });

  it("treats composed and decomposed Unicode as distinct", async () => {
    // é as a single code point U+00E9 vs decomposed e + U+0301.
    const composed = { name: "\u00e9" };
    const decomposed = { name: "e\u0301" };
    const [d1, d2] = await Promise.all([
      hashCanonicalJson(composed),
      hashCanonicalJson(decomposed),
    ]);
    expect(d1).not.toBe(d2);
    // Also confirm the canonical text differs.
    expect(canonicalizeJson(composed)).not.toBe(canonicalizeJson(decomposed));
  });

  // --- Prohibited runtime values ---

  it.each([
    ["undefined", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["bigint", BigInt(1)],
    ["symbol", Symbol("s")],
    ["function", () => {}],
  ])("rejects %s as a top-level value", async (_label, value) => {
    await expect(hashCanonicalJson(value)).rejects.toThrow();
  });

  it("rejects undefined nested in an object", async () => {
    await expect(
      hashCanonicalJson({ a: undefined }),
    ).rejects.toThrow();
  });

  it("rejects non-finite numbers nested in an array", async () => {
    await expect(hashCanonicalJson([1, Infinity, 3])).rejects.toThrow();
  });

  it("rejects bigint nested in an object", async () => {
    await expect(
      hashCanonicalJson({ a: BigInt(42) }),
    ).rejects.toThrow();
  });

  it("rejects symbol nested in an object", async () => {
    await expect(
      hashCanonicalJson({ a: Symbol("x") }),
    ).rejects.toThrow();
  });

  it("rejects function nested in an array", async () => {
    await expect(
      hashCanonicalJson([() => {}]),
    ).rejects.toThrow();
  });

  it("rejects sparse arrays", async () => {
    const sparse: unknown[] = [1, , 3];
    await expect(hashCanonicalJson(sparse)).rejects.toThrow();
  });

  it("rejects an array with an additional named property", async () => {
    const arr = [1, 2, 3] as unknown as { extra: number } & unknown[];
    Object.defineProperty(arr, "extra", {
      value: 4,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it("rejects an array with an own symbol property", async () => {
    const arr = [1, 2, 3];
    const sym = Symbol("arr-extra");
    Object.defineProperty(arr, sym, {
      value: 4,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it("rejects an array with an accessor element", async () => {
    const arr = [1, 2, 3];
    Object.defineProperty(arr, "1", {
      get() {
        return 2;
      },
      enumerable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it("rejects an array with a non-enumerable element", async () => {
    const arr = [1, 2, 3];
    Object.defineProperty(arr, "1", {
      value: 2,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it("rejects an array with a custom prototype", async () => {
    const arr = Object.setPrototypeOf([1, 2, 3], {});
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it.each(["01", "1e0", "+1", "-0"])(
    "rejects an array with a numeric-looking alias own property %j",
    async (alias) => {
      const arr = [1, 2, 3];
      Object.defineProperty(arr, alias, {
        value: 99,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      await expect(hashCanonicalJson(arr)).rejects.toThrow();
    },
  );

  it("rejects a non-enumerable own symbol property on an array", async () => {
    const arr = [1, 2, 3];
    const sym = Symbol("hidden-arr");
    Object.defineProperty(arr, sym, {
      value: 4,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it("rejects Date objects (non-plain)", async () => {
    await expect(hashCanonicalJson(new Date())).rejects.toThrow();
  });

  it("rejects Map objects (non-plain)", async () => {
    await expect(hashCanonicalJson(new Map())).rejects.toThrow();
  });

  it("rejects class instances (non-plain)", async () => {
    class Foo {
      x = 1;
    }
    await expect(hashCanonicalJson(new Foo())).rejects.toThrow();
  });

  it("rejects cyclic structures", async () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    await expect(hashCanonicalJson(obj)).rejects.toThrow();
  });

  it("rejects cyclic arrays", async () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    await expect(hashCanonicalJson(arr)).rejects.toThrow();
  });

  it("rejects enumerable symbol-keyed properties on a plain object", async () => {
    const obj: Record<string, unknown> = { a: 1 };
    const sym = Symbol("extra");
    Object.defineProperty(obj, sym, {
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(obj)).rejects.toThrow();
  });

  it("rejects non-enumerable symbol-keyed properties on a plain object", async () => {
    const obj: Record<string, unknown> = { a: 1 };
    const sym = Symbol("hidden");
    Object.defineProperty(obj, sym, {
      value: 3,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(obj)).rejects.toThrow();
  });

  it("rejects accessor properties", async () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "a", {
      get() {
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    await expect(hashCanonicalJson(obj)).rejects.toThrow();
  });

  it("rejects a non-enumerable data property on a plain object", () => {
    // Non-enumerable string keys are collected by Object.getOwnPropertyNames
    // but rejected because desc.enumerable is false.
    const obj: Record<string, unknown> = { a: 1 };
    Object.defineProperty(obj, "hidden", {
      value: 2,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    expect(() => canonicalizeJson(obj)).toThrow();
  });

  it("does not invoke toJSON", async () => {
    const obj = {
      a: 1,
      toJSON() {
        return { b: 2 };
      },
    };
    // Because toJSON is a function-valued enumerable property, it should be
    // rejected during serialisation of the value (function is not permitted).
    await expect(hashCanonicalJson(obj)).rejects.toThrow();
  });

  it("does not mutate the input object", () => {
    const input = { b: 2, a: 1, c: { z: 3, y: 4 } };
    const snapshot = JSON.parse(JSON.stringify(input));
    canonicalizeJson(input);
    expect(input).toEqual(snapshot);
  });

  it("does not mutate nested arrays", () => {
    const input = { arr: [3, 1, 2] };
    const snapshot = JSON.parse(JSON.stringify(input));
    canonicalizeJson(input);
    expect(input).toEqual(snapshot);
  });

  it("handles empty objects and arrays", async () => {
    expect(canonicalizeJson({})).toBe("{}");
    expect(canonicalizeJson([])).toBe("[]");
    const d = await hashCanonicalJson({});
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles objects with null prototype", async () => {
    const obj = Object.create(null);
    obj.b = 2;
    obj.a = 1;
    expect(canonicalizeJson(obj)).toBe('{"a":1,"b":2}');
  });
});

// ---------------------------------------------------------------------------
// hashCommandEnvelope
// ---------------------------------------------------------------------------

const VALID_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const VALID_INSTANT = "2026-09-28T10:00:00Z";

function makeEnvelope(
  overrides: Partial<CommandEnvelope<"CREATE_INQUIRY_CANDIDATE", unknown>> = {},
): CommandEnvelope<"CREATE_INQUIRY_CANDIDATE", unknown> {
  return {
    schemaVersion: 1,
    commandId: VALID_UUID as CommandEnvelope<
      "CREATE_INQUIRY_CANDIDATE",
      unknown
    >["commandId"],
    commandName: "CREATE_INQUIRY_CANDIDATE",
    issuedAt: VALID_INSTANT as CommandEnvelope<
      "CREATE_INQUIRY_CANDIDATE",
      unknown
    >["issuedAt"],
    initiator: "PATIENT",
    assistance: "NONE",
    origin: "PATIENT_UI",
    correlationId: VALID_UUID as CommandEnvelope<
      "CREATE_INQUIRY_CANDIDATE",
      unknown
    >["correlationId"],
    cause: { kind: "DIRECT_PATIENT_ACTION" },
    headExpectations: [],
    payload: { value: 42 },
    ...overrides,
  };
}

describe("hashCommandEnvelope", () => {
  it("hashes the complete envelope", async () => {
    const env = makeEnvelope();
    const digest = await hashCommandEnvelope(env);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the digest when commandId changes", async () => {
    const env1 = makeEnvelope({ commandId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" as never });
    const env2 = makeEnvelope({ commandId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never });
    const [d1, d2] = await Promise.all([
      hashCommandEnvelope(env1),
      hashCommandEnvelope(env2),
    ]);
    expect(d1).not.toBe(d2);
  });

  it("changes the digest when payload changes", async () => {
    const env1 = makeEnvelope({ payload: { value: 1 } });
    const env2 = makeEnvelope({ payload: { value: 2 } });
    const [d1, d2] = await Promise.all([
      hashCommandEnvelope(env1),
      hashCommandEnvelope(env2),
    ]);
    expect(d1).not.toBe(d2);
  });

  it("changes the digest when headExpectations change", async () => {
    const env1 = makeEnvelope({
      headExpectations: [
        {
          kind: "MUST_NOT_EXIST",
          recordType: "INQUIRY",
          proposedRecordId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
        },
      ],
    });
    const env2 = makeEnvelope({
      headExpectations: [
        {
          kind: "MUST_NOT_EXIST",
          recordType: "INQUIRY",
          proposedRecordId: "a47ac10b-58cc-4372-a567-0e02b2c3d479" as never,
        },
      ],
    });
    const [d1, d2] = await Promise.all([
      hashCommandEnvelope(env1),
      hashCommandEnvelope(env2),
    ]);
    expect(d1).not.toBe(d2);
  });

  it("produces the same digest for the same envelope", async () => {
    const env = makeEnvelope();
    const [d1, d2] = await Promise.all([
      hashCommandEnvelope(env),
      hashCommandEnvelope(makeEnvelope()),
    ]);
    expect(d1).toBe(d2);
  });
});
