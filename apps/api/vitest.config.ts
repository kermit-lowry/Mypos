import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://pos:pos@localhost:5432/mypos_test" },
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});
