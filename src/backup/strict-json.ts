/**
 * Bounded strict JSON data parser for untrusted backup bytes (storage-
 * backup-spec 8.3). It is a plain recursive-descent reader over RFC 8259
 * JSON: no `eval`, no reviver, no prototype assignment (objects have a null
 * prototype), duplicate keys rejected, and hard limits on nesting depth and
 * input length. It only produces data; it cannot select or run code.
 */

export class StrictJsonError extends Error {
  readonly name = "StrictJsonError";
  constructor(readonly reason: "SYNTAX" | "DUPLICATE_KEY" | "TOO_DEEP" | "TOO_LARGE" | "INVALID_UTF8") {
    super(reason);
  }
}

export type StrictJsonLimits = { maxDepth: number; maxLength: number };

/** Decodes UTF-8 strictly: any ill-formed sequence is rejected, not replaced. */
export function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("INVALID_UTF8");
  }
}

export function parseStrictJson(text: string, limits: StrictJsonLimits): unknown {
  if (text.length > limits.maxLength) throw new StrictJsonError("TOO_LARGE");
  let index = 0;

  const fail = (): never => {
    throw new StrictJsonError("SYNTAX");
  };
  const skipWhitespace = () => {
    while (index < text.length) {
      const char = text.charCodeAt(index);
      if (char === 0x20 || char === 0x0a || char === 0x0d || char === 0x09) index += 1;
      else break;
    }
  };

  function parseString(): string {
    if (text[index] !== '"') fail();
    index += 1;
    let out = "";
    let start = index;
    while (true) {
      if (index >= text.length) fail();
      const char = text.charCodeAt(index);
      if (char === 0x22) {
        out += text.slice(start, index);
        index += 1;
        return out;
      }
      if (char < 0x20) fail();
      if (char === 0x5c) {
        out += text.slice(start, index);
        const escape = text[index + 1];
        index += 2;
        switch (escape) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
            out += String.fromCharCode(parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            fail();
        }
        start = index;
        continue;
      }
      index += 1;
    }
  }

  function parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index, index + 64));
    if (!match) fail();
    index += match![0].length;
    const value = Number(match![0]);
    if (!Number.isFinite(value)) fail();
    return value;
  }

  function parseValue(depth: number): unknown {
    if (depth > limits.maxDepth) throw new StrictJsonError("TOO_DEEP");
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const object: Record<string, unknown> = Object.create(null);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return object;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (Object.prototype.hasOwnProperty.call(object, key)) throw new StrictJsonError("DUPLICATE_KEY");
        skipWhitespace();
        if (text[index] !== ":") fail();
        index += 1;
        object[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return object;
        }
        fail();
      }
    }
    if (char === "[") {
      index += 1;
      const array: unknown[] = [];
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return array;
      }
      while (true) {
        array.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return array;
        }
        fail();
      }
    }
    if (char === '"') return parseString();
    if (text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    return parseNumber();
  }

  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail();
  return value;
}

/** Deep-copies parsed data onto ordinary prototypes for schema and codec use. */
export function toPlainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlainData);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) Object.defineProperty(out, key, { value: toPlainData((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}
