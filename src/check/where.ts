import type { PropertyValue } from "../normalize/model.js";
import { toBoolean, type WhereValue } from "../notion/filter.js";

/**
 * Local comparison of `where` for the property types whose values are not plain scalars:
 * files, formula, and rollup. Each returns true when the page stays in scope. A condition the
 * server filter translates (`src/notion/filter.ts`) is never stricter than these, so the
 * server cannot drop a page that these keep.
 */

type Of<T extends PropertyValue["type"]> = Extract<PropertyValue, { type: T }>;
/** The people / files / relation value (one union member holds all three). */
type CountValue = Extract<PropertyValue, { count: number }>;

/**
 * Files: a boolean asks whether the property has files (`true`) or is empty (`false`); text is
 * a file name. A list that may be cut short keeps the page until its full value is read.
 */
export function compareFiles(value: CountValue, expected: WhereValue): boolean {
  if (typeof expected === "boolean") {
    const hasFiles = value.count > 0;
    return hasFiles === expected;
  }
  return (value.names ?? []).includes(String(expected)) || value.hasMore;
}

/** Formula: compared as the formula's result type (number, checkbox, or text for string and date). */
export function compareFormula(value: Of<"formula">, expected: WhereValue): boolean {
  if (value.value === null) return false;
  switch (value.result) {
    case "number":
      return value.value === Number(expected);
    case "boolean":
      return value.value === toBoolean(expected);
    default:
      return value.value === String(expected);
  }
}

/**
 * Rollup: a number or date result is compared like a number or date property. For an array,
 * the page stays in scope when some item equals the value (compared as the item's own
 * property type, with `compareItem`). An array of 25 items or more may be cut short, so it is
 * kept. An incomplete rollup never matches.
 */
export function compareRollup(
  value: Of<"rollup">,
  expected: WhereValue,
  compareItem: (item: PropertyValue, expected: WhereValue) => boolean | undefined,
): boolean {
  switch (value.result) {
    case "number":
      return value.value !== null && value.value === Number(expected);
    case "date":
      return value.value === String(expected);
    case "array":
      return value.hasMore || value.items.some((item) => compareItem(item, expected) === true);
    case "incomplete":
      return false;
  }
}
