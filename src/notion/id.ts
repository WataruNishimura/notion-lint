/**
 * Notion page / data source IDs: 32 hex digits, with or without hyphens, or a Notion URL
 * that ends with one (`https://www.notion.so/My-page-0123456789abcdef0123456789abcdef`).
 * Returns the hyphenated form, or `undefined` when no ID can be found.
 *
 * The ID is the one that ends the path: a title or workspace slug before it and a `?v=` view
 * parameter after it are ignored. `?p=<id>` (a page opened as a peek) takes precedence unless
 * `peek` is false, which a database or data source URL needs: its peeked row is not the database.
 */
export function parseNotionId(input: string, options: { peek?: boolean } = {}): string | undefined {
  const trimmed = input.trim();
  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    const peeked = options.peek === false ? null : url.searchParams.get("p");
    candidate = peeked ?? url.pathname.split("/").filter(Boolean).pop() ?? "";
  }
  const match = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})$/i.exec(
    candidate,
  );
  if (match?.[1] === undefined) return undefined;
  const hex = match[1].replace(/-/g, "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
