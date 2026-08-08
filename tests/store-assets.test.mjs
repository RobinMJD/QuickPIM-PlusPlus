import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const screenshotFiles = [
  "screenshot-01-popup-roles-1280x800.png",
  "screenshot-02-popup-activation-1280x800.png",
  "screenshot-03-popup-bundles-1280x800.png",
  "screenshot-04-popup-active-1280x800.png",
  "screenshot-05-settings-appearance-1280x800.png"
];

describe("browser Store assets", () => {
  it("lists the current popup-first screenshot sequence", () => {
    const listing = readFileSync(resolve("store/listing.en-US.md"), "utf8");
    const offsets = screenshotFiles.map((fileName) => listing.indexOf(fileName));

    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(listing).not.toContain("screenshot-01-access-setup-1280x800.png");
    expect(listing).not.toContain("screenshot-02-preferences-1280x800.png");
  });

  it("keeps all Store graphics at the required dimensions", () => {
    for (const fileName of screenshotFiles) {
      expect(readPngDimensions(resolve("store/assets", fileName))).toEqual({ width: 1280, height: 800 });
    }
    expect(readPngDimensions(resolve("store/assets/icon-300.png"))).toEqual({ width: 300, height: 300 });
    expect(readPngDimensions(resolve("store/assets/small-promo-440x280.png"))).toEqual({ width: 440, height: 280 });
    expect(readPngDimensions(resolve("store/assets/large-promo-1400x560.png"))).toEqual({ width: 1400, height: 560 });
  });

  it("leads GitHub documentation with the popup and keeps matching current captures", () => {
    const readme = readFileSync(resolve("README.md"), "utf8");
    const popupPath = "docs/images/screenshot-01-popup-roles-1280x800.png";
    const settingsPath = "docs/images/screenshot-05-settings-appearance-1280x800.png";

    expect(readme.indexOf(popupPath)).toBeGreaterThan(0);
    expect(readme.indexOf(settingsPath)).toBeGreaterThan(readme.indexOf(popupPath));
    expect(readPngDimensions(resolve(popupPath))).toEqual({ width: 1280, height: 800 });
    expect(readPngDimensions(resolve(settingsPath))).toEqual({ width: 1280, height: 800 });
  });

  it("generates captures from dist using fictional Store data", () => {
    const generator = readFileSync(resolve("scripts/generate-store-assets.mjs"), "utf8");

    expect(generator).toContain("--load-extension=${DIST_DIR}");
    expect(generator).toContain("alex.wilber@contoso.onmicrosoft.com");
    expect(generator).not.toMatch(/robin\.monjaud|sonepar/i);
    expect(generator).toContain("Build dist/ before generating Store assets");
  });
});

function readPngDimensions(path) {
  const png = readFileSync(path);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}
