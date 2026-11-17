// @vitest-environment node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const vendorEntry = fileURLToPath(new URL("../vendor/quickpim-picomatch/index.js", import.meta.url));

describe("build and test glob parser", () => {
  test.each(["vite", "vitest", "tinyglobby", "fdir"])("%s resolves the restricted parser", (tool) => {
    const requireFromTool = createRequire(require.resolve(tool));
    expect(realpathSync(requireFromTool.resolve("picomatch"))).toBe(realpathSync(vendorEntry));
  });

  test("rejects both repeat extglob operators before compiling a matcher", () => {
    const picomatch = require("picomatch");
    const posix = require("picomatch/posix");
    for (const pattern of ["+(js|jsx)", "src/*(js|jsx).ts", "@(src|test)/+(ts|tsx)"]) {
      expect(() => picomatch(pattern)).toThrow(/Repeated extglobs are disabled/);
      expect(() => picomatch.parse(pattern, { maxExtglobRecursion: false })).toThrow(/Repeated extglobs are disabled/);
      expect(() => posix.makeRe(pattern, { capture: true })).toThrow(/Repeated extglobs are disabled/);
    }
  });

  test("continues to match ordinary file globs and optional extglobs", () => {
    const picomatch = require("picomatch");
    const tests = picomatch("**/*.{test,spec}.?(c|m)[jt]s?(x)", { ignore: "tests/e2e/**" });
    expect(tests("tests/popup-ui.test.tsx")).toBe(true);
    expect(tests("tests/toolchain-glob.test.mjs")).toBe(true);
    expect(tests("tests/e2e/request-activity.spec.ts")).toBe(false);
    expect(picomatch.isMatch("src/lib/requestTracking.ts", "src/**/*.ts")).toBe(true);
    expect(picomatch.isMatch("aaaa", "(a)+", { regex: true })).toBe(false);
  });
});
