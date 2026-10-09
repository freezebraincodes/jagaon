import { canonicalizeJson } from "@/application/contracts/canonical-json";
import { BACKUP_PRIMARY_KEYS, BACKUP_TABLE_NAMES_V1, TABLE_ENVELOPE_SCHEMA_VERSION, type BackupPayloadV1, type BackupPayloadV2, type BackupTableManifest, type BackupTableNameV1, type BackupTableSetV1 } from "./backup-payload-v1";

/**
 * `JAGAON_CANONICAL_JSON_V1` canonicalisation for the backup (spec 7.4).
 * Object keys are sorted by UTF-16 code unit at every depth, arrays keep
 * order, and each table is ordered by its exact primary key with
 * IndexedDB's code-unit string order, never by incidental insertion order.
 */

const utf8 = (text: string) => new TextEncoder().encode(text);

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class BackupCanonicalisationError extends Error {
  readonly name = "BackupCanonicalisationError";
  constructor(readonly tableName: BackupTableNameV1 | null) {
    super("Backup canonicalisation failed");
  }
}

function primaryKey(table: BackupTableNameV1, row: unknown): string[] {
  return BACKUP_PRIMARY_KEYS[table].map((field) => {
    const value = (row as Record<string, unknown> | null)?.[field];
    if (typeof value !== "string") throw new BackupCanonicalisationError(table);
    return value;
  });
}

function compareKeys(a: string[], b: string[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

/** Rows in canonical primary-key order; a duplicate key is rejected. */
export function canonicaliseBackupTable(table: BackupTableNameV1, rows: readonly unknown[]): unknown[] {
  const keyed = rows.map((row) => ({ key: primaryKey(table, row), row }));
  keyed.sort((a, b) => compareKeys(a.key, b.key));
  for (let index = 1; index < keyed.length; index += 1) {
    if (compareKeys(keyed[index - 1]!.key, keyed[index]!.key) === 0) throw new BackupCanonicalisationError(table);
  }
  return keyed.map((entry) => entry.row);
}

/** True when rows are already in strict canonical primary-key order. */
export function isCanonicallyOrdered(table: BackupTableNameV1, rows: readonly unknown[]): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    if (compareKeys(primaryKey(table, rows[index - 1]), primaryKey(table, rows[index])) >= 0) return false;
  }
  return true;
}

export function canonicalRowsBytes(rows: readonly unknown[]): Uint8Array {
  try {
    return utf8(canonicalizeJson(rows));
  } catch {
    throw new BackupCanonicalisationError(null);
  }
}

export async function createBackupManifest(
  tables: BackupTableSetV1,
  sha256: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<BackupTableManifest[]> {
  const manifests: BackupTableManifest[] = [];
  for (const tableName of BACKUP_TABLE_NAMES_V1) {
    const rows = tables[tableName];
    manifests.push({
      tableName,
      tableEnvelopeSchemaVersion: TABLE_ENVELOPE_SCHEMA_VERSION,
      rowCount: rows.length,
      canonicalRowsSha256: toHex(await sha256(canonicalRowsBytes(rows))),
    });
  }
  return manifests;
}

export function canonicaliseBackupPayload(payload: BackupPayloadV1 | BackupPayloadV2): Uint8Array {
  try {
    return utf8(canonicalizeJson(payload));
  } catch {
    throw new BackupCanonicalisationError(null);
  }
}
