/**
 * Readable locations used in errors and violations: `type.body[1].heading`,
 * `type.properties.Attendees`, `targets[0]["odd.key"]`. The root is the empty string.
 */

const PLAIN_KEY = /^[^\s.[\]"'\\]+$/;

export function joinPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  if (PLAIN_KEY.test(key)) return path === "" ? key : `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

/** `/type/body/1/heading` (JSON Pointer) -> `type.body[1].heading` */
export function pointerToPath(pointer: string): string {
  if (pointer === "") return "";
  let path = "";
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    path = joinPath(path, /^(0|[1-9]\d*)$/.test(token) ? Number(token) : token);
  }
  return path;
}

export function encodePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
