// Writes schema/notion-lint.schema.json (the config schema) and schema/result.schema.json.
// test/schema.test.ts fails when these files are out of date.
import { writeFileSync } from "node:fs";
import { configJsonSchema, resultJsonSchema } from "../src/schema/validate.js";

const write = (name: string, value: unknown) => {
  const file = new URL(`../schema/${name}`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote schema/${name}`);
};

write("notion-lint.schema.json", configJsonSchema());
write("result.schema.json", resultJsonSchema());
