import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    setupFiles: ["tests/setup.ts"],
    // Integration tests share the same local Postgres; truncate+seed races when
    // test files run in parallel. Force single-threaded execution.
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
