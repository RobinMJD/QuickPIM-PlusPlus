import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const entry = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  define: {
    __QUICKPIM_BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString())
  },
  build: {
    target: "chrome102",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: entry("popup.html"),
        settings: entry("settings.html"),
        background: entry("src/background.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: true
  }
});
