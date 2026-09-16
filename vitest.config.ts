import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "src/packages/**/*.test.ts",
      "src/adapters/**/*.test.ts",
      "src/apps/**/*.test.ts",
    ],
  },
});
