import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

const entry = (path: string) => new URL(path, import.meta.url).pathname;

function getBuildTimestamp(): string {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
  if (Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0) {
    return new Date(sourceDateEpoch * 1_000).toISOString();
  }
  try {
    const commitDate = execFileSync("git", ["log", "-1", "--format=%cI"], {
      encoding: "utf8"
    }).trim();
    const parsed = new Date(commitDate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  } catch {
    // Source archives without Git metadata still receive a stable value.
  }
  return "1970-01-01T00:00:00.000Z";
}

export default defineConfig({
  plugins: [react()],
  define: {
    __QUICKPIM_BUILD_TIMESTAMP__: JSON.stringify(getBuildTimestamp())
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
    globals: true,
    exclude: [...configDefaults.exclude, "tests/e2e/**"]
  }
});
