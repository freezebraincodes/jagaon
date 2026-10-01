import {
  decimalStringSchema,
  type DecimalString,
} from "@/domain/health-records/measurement";

export type DecimalComparison = -1 | 0 | 1;

type DecimalParts = {
  negative: boolean;
  integer: string;
  fraction: string;
};

function splitDecimal(value: DecimalString): DecimalParts {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger, rawFraction = ""] = unsigned.split(".");
  const integer = rawInteger.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const zero = integer === "0" && fraction.length === 0;

  return {
    negative: negative && !zero,
    integer,
    fraction,
  };
}

function compareUnsigned(left: DecimalParts, right: DecimalParts): DecimalComparison {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1;
  }
  if (left.integer !== right.integer) {
    return left.integer < right.integer ? -1 : 1;
  }

  const length = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(length, "0");
  const rightFraction = right.fraction.padEnd(length, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

export function compareDecimalStrings(
  leftInput: DecimalString,
  rightInput: DecimalString,
): DecimalComparison {
  const left = splitDecimal(decimalStringSchema.parse(leftInput));
  const right = splitDecimal(decimalStringSchema.parse(rightInput));

  if (left.negative !== right.negative) return left.negative ? -1 : 1;

  const unsigned = compareUnsigned(left, right);
  return left.negative ? ((-unsigned) as DecimalComparison) : unsigned;
}
