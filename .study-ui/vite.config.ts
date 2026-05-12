import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { createThemeBootScript } from "./src/lib/theme";

function injectThemeBootScript() {
  return {
    name: "study-ui-theme-boot",
    transformIndexHtml(html: string) {
      return html.replace(
        "<!--theme-boot-->",
        `<script>${createThemeBootScript()}</script>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [injectThemeBootScript(), tailwindcss(), react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-slot",
            "@radix-ui/react-switch",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
          ],
          icons: ["@phosphor-icons/react"],
          tauri: ["@tauri-apps/api"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
});
