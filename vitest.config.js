import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Keep tests on the newest compatibility date supported by the pinned
        // local workerd binary. Production continues to use wrangler.toml.
        compatibilityDate: "2026-07-29",
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.js"],
  },
});
