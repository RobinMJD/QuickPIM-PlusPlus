export const GRAPH_API_ORIGIN = "https://graph.microsoft.com";
export const AZURE_MANAGEMENT_ORIGIN = "https://management.azure.com";

export function graphApiUrl(pathAndQuery: string): string {
  return buildApiUrl(GRAPH_API_ORIGIN, pathAndQuery);
}

export function azureManagementUrl(pathAndQuery: string): string {
  return buildApiUrl(AZURE_MANAGEMENT_ORIGIN, pathAndQuery);
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function buildApiUrl(origin: string, pathAndQuery: string): string {
  if (!pathAndQuery.startsWith("/")) {
    throw new Error("API path must start with '/'.");
  }

  return `${origin}${pathAndQuery}`;
}
