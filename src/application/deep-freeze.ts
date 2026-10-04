/**
 * Clone-then-freeze for plans handed to callers (Packet 10 Corrective Pass A).
 * The returned value shares no reference with internal state and cannot be
 * mutated at any depth, so confirmation always sees the reviewed material.
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function frozenClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
