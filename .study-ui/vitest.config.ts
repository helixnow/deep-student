/// <reference types="vitest" />
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [path.resolve(__dirname, "./vitest.setup.ts")],
    include: [
      path.resolve(__dirname, "src/lib/scroll-platform.test.ts"),
      path.resolve(__dirname, "src/lib/scroll-theme.test.ts"),
      path.resolve(__dirname, "src/components/ui/*.test.tsx"),
    ],
    exclude: [
      "**/*.source.test.ts",
      "**/*.ct.spec.tsx",
      "**/node_modules/**",
    ],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts", "src/components/ui/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.source.test.ts",
        "src/**/*.ct.spec.tsx",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
