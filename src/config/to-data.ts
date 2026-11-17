import { joinPath } from "../path.js";

/**
 * Convert what a TS config file exports into plain JSON data.
 *
 * Builders (`doc()`, `prop.date()`, ...) implement `toJSON()`; a raw `RegExp` becomes
 * `{ pattern, flags }`. Anything that has no JSON form (functions, symbols, class
 * instances, NaN, ...) is an error instead of being dropped silently the way
 * `JSON.stringify` would.
 */

export class ConfigDataError extends Error {
  constructor(
    message: string,
    /** Location in the same notation as config issues, e.g. `targets[0].type`. */
    readonly path: string,
  ) {
    super(path === "" ? message : `${path}: ${message}`);
    this.name = "ConfigDataError";
  }
}

export function regexToData(re: RegExp): { pattern: string; flags?: string } {
  return re.flags === "" ? { pattern: re.source } : { pattern: re.source, flags: re.flags };
}

export function toData(value: unknown): unknown {
  return convert(value, "", new Set());
}

function convert(value: unknown, path: string, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw new ConfigDataError(`${value} cannot be written as JSON`, path);
      return value;
    case "undefined":
      throw new ConfigDataError("undefined cannot be written as JSON", path);
    case "function":
      throw new ConfigDataError(
        "A function cannot be written in the config (only values that JSON can represent)",
        path,
      );
    case "symbol":
    case "bigint":
      throw new ConfigDataError(`${typeof value} cannot be written as JSON`, path);
  }
  if (value === null) return null;

  const object = value as object;
  if (ancestors.has(object)) throw new ConfigDataError("Circular reference", path);
  ancestors.add(object);
  try {
    if (object instanceof RegExp) return regexToData(object);
    if (typeof (object as { toJSON?: unknown }).toJSON === "function") {
      return convert((object as { toJSON(): unknown }).toJSON(), path, ancestors);
    }
    if (Array.isArray(object)) {
      return object.map((item, i) => convert(item, joinPath(path, i), ancestors));
    }
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) {
      const name = (object as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new ConfigDataError(`${name} cannot be written as JSON`, path);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      if (item === undefined) continue;
      out[key] = convert(item, joinPath(path, key), ancestors);
    }
    return out;
  } finally {
    ancestors.delete(object);
  }
}
