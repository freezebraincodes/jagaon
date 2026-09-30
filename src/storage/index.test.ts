import { describe, it, expect } from "vitest";
import {
  JAGAON_DATABASE_NAME,
  JAGAON_DEXIE_VERSION,
  JAGAON_TABLE_NAMES,
  JAGAON_STORES_V1,
  JagaOnDatabase,
  createJagaOnDatabase,
  type JagaOnTableName,
} from "./index";

// Compile-time fixture: confirm the approved Packet 4F1 public API is
// available from the storage barrel. If any symbol were accidentally omitted
// or aliased away, the type annotations below would fail to compile.
describe("storage barrel Packet 4F1 exports", () => {
  it("exports JAGAON_DATABASE_NAME with the exact value jagaon", () => {
    const _v: typeof JAGAON_DATABASE_NAME = "jagaon";
    expect(JAGAON_DATABASE_NAME).toBe("jagaon");
    expect(_v).toBe("jagaon");
  });

  it("exports JAGAON_DEXIE_VERSION with the exact value 1", () => {
    const _v: typeof JAGAON_DEXIE_VERSION = 1;
    expect(JAGAON_DEXIE_VERSION).toBe(1);
    expect(_v).toBe(1);
  });

  it("exports the 16-element JAGAON_TABLE_NAMES array", () => {
    expect(JAGAON_TABLE_NAMES).toHaveLength(16);
    expect(Array.isArray(JAGAON_TABLE_NAMES)).toBe(true);
  });

  it("exports the JAGAON_STORES_V1 record keyed by every table name", () => {
    const storeKeys = Object.keys(JAGAON_STORES_V1);
    expect(storeKeys).toHaveLength(16);
    for (const name of JAGAON_TABLE_NAMES) {
      expect(typeof JAGAON_STORES_V1[name]).toBe("string");
    }
  });

  it("exports the JagaOnTableName type", () => {
    const _v: JagaOnTableName = "appPreferences";
    expect(_v).toBe("appPreferences");
  });

  it("exports the JagaOnDatabase class", () => {
    expect(JagaOnDatabase).toBeTypeOf("function");
  });

  it("exports the createJagaOnDatabase factory", () => {
    expect(createJagaOnDatabase).toBeTypeOf("function");
    const db = createJagaOnDatabase("barrel-test-" + Math.random().toString(36).slice(2));
    expect(db).toBeInstanceOf(JagaOnDatabase);
    db.close();
  });
});
