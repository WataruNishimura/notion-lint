/** A small unified diff for one contiguous change (the section is the only part that differs). */
export function unifiedDiff(label: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const context = 3;
  const from = Math.max(0, prefix - context);
  const aEnd = Math.min(a.length, a.length - suffix + context);
  const bEnd = Math.min(b.length, b.length - suffix + context);
  const lines: string[] = [];
  for (let i = from; i < prefix; i++) lines.push(` ${a[i]}`);
  for (let i = prefix; i < a.length - suffix; i++) lines.push(`-${a[i]}`);
  for (let i = prefix; i < b.length - suffix; i++) lines.push(`+${b[i]}`);
  for (let i = a.length - suffix; i < aEnd; i++) lines.push(` ${a[i]}`);
  const aCount = aEnd - from;
  const bCount = bEnd - from;
  return `--- ${label}\n+++ ${label}\n@@ -${from + 1},${aCount} +${from + 1},${bCount} @@\n${lines.join("\n")}\n`;
}
