export interface PaginatedResponse<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  nextLink?: string;
}

export async function collectPaginatedValues<T>(
  initialUrl: string,
  fetchPage: (url: string) => Promise<PaginatedResponse<T>>,
  options: { maxPages?: number; maxItems?: number } = {}
): Promise<T[]> {
  const maxPages = options.maxPages ?? 100;
  const maxItems = options.maxItems ?? 20_000;
  const seen = new Set<string>();
  const values: T[] = [];
  let nextUrl: string | undefined = initialUrl;

  while (nextUrl) {
    if (seen.has(nextUrl)) {
      throw new Error("Microsoft API pagination returned a repeated page link.");
    }
    if (seen.size >= maxPages) {
      throw new Error(`Microsoft API pagination exceeded ${maxPages} pages.`);
    }
    seen.add(nextUrl);
    const data = await fetchPage(nextUrl);
    const pageValues = data.value || [];
    if (values.length + pageValues.length > maxItems) {
      throw new Error(`Microsoft API pagination exceeded ${maxItems} items.`);
    }
    values.push(...pageValues);
    nextUrl = data["@odata.nextLink"] || data.nextLink;
  }

  return values;
}
