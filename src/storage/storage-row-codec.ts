import { type ZodType, type ZodTypeDef } from "zod";
import { type JagaOnTableName } from "./table-catalogue";

export type StorageRowBoundary = "WRITE" | "READ";

export type StorageRowFailureCode =
  | "STORAGE_VALIDATION_FAILED"
  | "STORAGE_INTEGRITY_FAILED";

/**
 * Bounded storage-boundary failure.
 *
 * The error deliberately retains no rejected value, Zod issue list, browser
 * exception, or patient content. Callers receive only the closed failure code,
 * physical table, and boundary needed to stop the affected operation.
 */
export class StorageRowValidationError extends Error {
  readonly name = "StorageRowValidationError";

  constructor(
    readonly code: StorageRowFailureCode,
    readonly table: JagaOnTableName,
    readonly boundary: StorageRowBoundary,
  ) {
    super(
      boundary === "WRITE"
        ? "Storage row failed validation before write"
        : "Stored row failed integrity validation after read",
    );
  }
}

export type StorageRowCodec<T> = {
  validateForWrite(value: unknown): T;
  validateAfterRead(value: unknown): T;
};

/**
 * Create a schema-backed codec for one exact physical table row.
 *
 * This low-level constructor is intentionally not exported from the public
 * storage barrel. Storage modules use it to build closed concrete codecs.
 */
export function createStorageRowCodec<T>(
  table: JagaOnTableName,
  schema: ZodType<T, ZodTypeDef, unknown>,
): StorageRowCodec<T> {
  const validate = (
    value: unknown,
    boundary: StorageRowBoundary,
  ): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new StorageRowValidationError(
        boundary === "WRITE"
          ? "STORAGE_VALIDATION_FAILED"
          : "STORAGE_INTEGRITY_FAILED",
        table,
        boundary,
      );
    }
    return result.data;
  };

  return Object.freeze({
    validateForWrite(value: unknown): T {
      return validate(value, "WRITE");
    },
    validateAfterRead(value: unknown): T {
      return validate(value, "READ");
    },
  });
}
