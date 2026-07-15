import { describe, expect, test } from "vitest";
import { collectPaginatedValues } from "../src/lib/pagination";

describe("bounded API pagination", () => {
  test("collects pages while rejecting repeated next links", async () => {
    await expect(collectPaginatedValues("page-1", async (url) => ({
      value: [url],
      "@odata.nextLink": "page-1"
    }))).rejects.toThrow(/repeated page link/i);
  });

  test("caps pages and items", async () => {
    await expect(collectPaginatedValues("page-1", async () => ({ value: [1, 2, 3] }), { maxItems: 2 })).rejects.toThrow(/2 items/i);
    await expect(collectPaginatedValues("page-1", async (url) => ({ value: [], nextLink: `${url}-next` }), { maxPages: 2 })).rejects.toThrow(/2 pages/i);
  });

  test("rejects malformed Microsoft page shapes with a stable error", async () => {
    await expect(collectPaginatedValues("page-1", async () => ({ value: {} as never })))
      .rejects.toThrow("pagination response was malformed");
    await expect(collectPaginatedValues("page-1", async () => ({ value: [], nextLink: { url: "page-2" } as never })))
      .rejects.toThrow("pagination response was malformed");
  });
});
