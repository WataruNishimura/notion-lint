import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Config fixtures import "notion-lint"; point it at the sources, as tsconfig "paths" does.
    alias: { "notion-lint": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
