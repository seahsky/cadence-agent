import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only ever collect from source. Without this, a previous `pnpm build` leaves compiled
    // copies in dist/ and vitest runs every test twice, which also means a stale dist/ can
    // report passes for code that no longer exists in src/.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
