import { describe, expect, test } from "vitest";
import { collectPortalTokensFromEntries, collectPortalTokensFromValues } from "../src/lib/portalTokenCache";

describe("portal token cache collection", () => {
  test("extracts bounded JWT access tokens from MSAL local and session storage entries", () => {
    const graphToken = makeToken({ aud: "https://graph.microsoft.com" });
    const azureToken = makeToken({ aud: "https://management.azure.com/" });
    const idToken = makeToken({ aud: "client-id" });

    const tokens = collectPortalTokensFromEntries([
      ["msal.graph", JSON.stringify({ credentialType: "AccessToken", secret: graphToken })],
      ["msal.azure", JSON.stringify({ nested: { token: azureToken } })],
      ["msal.id", JSON.stringify({ credentialType: "IdToken", secret: idToken })],
      ["plain", `Bearer ${graphToken}`],
      ["oversized", "x".repeat(400_000)]
    ]);

    expect(tokens).toEqual([graphToken, azureToken, idToken]);
  });

  test("extracts tokens from nested IndexedDB-style records", () => {
    const graphToken = makeToken({ aud: "https://graph.microsoft.com/" });
    const azureToken = makeToken({ aud: "https://management.azure.com/" });

    const tokens = collectPortalTokensFromValues([
      {
        credential: {
          credentialType: "AccessToken",
          secret: graphToken
        }
      },
      [{ cached: { accessToken: azureToken } }]
    ]);

    expect(tokens).toEqual([graphToken, azureToken]);
  });
});

function makeToken(payload: Record<string, unknown>): string {
  const encodedPayload = btoa(JSON.stringify({ exp: 1_900_000_000, ...payload }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${encodedPayload}.signature`;
}
