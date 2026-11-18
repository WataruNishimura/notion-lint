import type { PropertyValue } from "../normalize/model.js";
import { joinPath } from "../path.js";
import type { PropSpec } from "../schema/config.js";
import type { Finding } from "./finding.js";

/**
 * Check a page's properties against the type's `properties`. Each finding's path is
 * `properties.<name>`.
 */
export function checkProperties(
  specs: Record<string, PropSpec>,
  values: Record<string, PropertyValue>,
): Finding[] {
  const findings: Finding[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const path = joinPath("properties", name);
    const add = (rule: string, message: string, suggestions: Finding["suggestions"] = []) =>
      findings.push({ path, rule: `property.${rule}`, message, suggestions, blockId: null });

    const value = values[name];
    if (value === undefined) {
      if (spec.optional !== true) {
        add("missing", `property "${name}" does not exist on the page`, [
          { message: `Add a ${typeLabel(spec.type)} property named "${name}"` },
        ]);
      }
      continue;
    }
    if (value.type !== spec.type) {
      const actual = value.type === "unsupported" ? value.apiType : value.type;
      add(
        "type",
        `property "${name}" is a ${typeLabel(actual)} property; the type expects ${typeLabel(spec.type)}`,
      );
      continue;
    }
    const empty = isEmpty(value);
    if (spec.required === true && empty) {
      add(
        "required",
        value.type === "checkbox" ? `"${name}" must be checked` : `"${name}" is empty`,
      );
    }
    checkValue(spec, value, empty, add);
  }
  return findings;
}

type Add = (rule: string, message: string, suggestions?: Finding["suggestions"]) => void;

function checkValue(spec: PropSpec, value: PropertyValue, empty: boolean, add: Add): void {
  switch (spec.type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number": {
      if (empty || spec.pattern === undefined || !("text" in value)) return;
      const re = new RegExp(spec.pattern, spec.flags);
      if (!re.test(value.text)) {
        add("pattern", `"${value.text}" does not match /${spec.pattern}/${spec.flags ?? ""}`);
      }
      return;
    }
    case "number": {
      if (value.type !== "number" || value.value === null) return;
      if (spec.min !== undefined && value.value < spec.min) {
        add("min", `must be ${spec.min} or more (${value.value} found)`);
      }
      if (spec.max !== undefined && value.value > spec.max) {
        add("max", `must be ${spec.max} or less (${value.value} found)`);
      }
      return;
    }
    case "select":
    case "status": {
      if ((value.type !== "select" && value.type !== "status") || value.value === null) return;
      checkOptions(spec.options, [value.value], add);
      return;
    }
    case "multi_select": {
      if (value.type !== "multi_select") return;
      checkOptions(spec.options, value.values, add);
      checkCount(spec, value.values.length, "option", add);
      return;
    }
    case "people":
    case "files":
    case "relation": {
      if (value.type !== spec.type) return;
      checkCount(spec, value.count, UNITS[spec.type], add);
      return;
    }
    case "date":
    case "checkbox":
      return;
  }
}

const UNITS = { people: "person", files: "file", relation: "related page" } as const;

function plural(n: number, unit: string): string {
  if (n === 1) return `1 ${unit}`;
  return `${n} ${unit === "person" ? "people" : `${unit}s`}`;
}

function checkCount(spec: { min?: number; max?: number }, count: number, unit: string, add: Add) {
  if (spec.min !== undefined && count < spec.min) {
    add("min", `needs at least ${plural(spec.min, unit)} (${count} found)`);
  }
  if (spec.max !== undefined && count > spec.max) {
    add("max", `allows at most ${plural(spec.max, unit)} (${count} found)`);
  }
}

function checkOptions(options: string[] | undefined, values: string[], add: Add): void {
  if (options === undefined) return;
  for (const value of values) {
    if (options.includes(value)) continue;
    add(
      "option",
      `"${value}" is not an allowed option (allowed: ${options.map((o) => `"${o}"`).join(", ")})`,
      options.map((option) => ({ message: `Use "${option}"`, replacement: option })),
    );
  }
}

function isEmpty(value: PropertyValue): boolean {
  switch (value.type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return value.text.trim() === "";
    case "number":
    case "select":
    case "status":
      return value.value === null;
    case "multi_select":
      return value.values.length === 0;
    case "date":
      return value.start === null;
    case "people":
    case "files":
    case "relation":
      return value.count === 0;
    case "checkbox":
      return !value.checked;
    case "formula":
    case "rollup":
    case "unsupported":
      return false;
  }
}

function typeLabel(type: string): string {
  return type.replace(/_/g, " ");
}
