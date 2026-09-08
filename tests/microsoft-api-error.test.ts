import { describe, expect, test } from "vitest";
import { CLAIMS_CHALLENGE_MESSAGE } from "../src/lib/apiErrors";
import { MicrosoftApiError, readMicrosoftApiError } from "../src/lib/microsoftApiError";

describe("Microsoft API error metadata", () => {
  test("retains HTTP status and service code independently of the localized message", async () => {
    const error = await readMicrosoftApiError(new Response(JSON.stringify({
      error: { code: "RoleAssignmentExists", message: "L’affectation de rôle existe déjà." }
    }), { status: 400 }));
    expect(error).toBeInstanceOf(MicrosoftApiError);
    expect(error).toMatchObject({ status: 400, code: "RoleAssignmentExists", message: "L’affectation de rôle existe déjà." });
  });

  test("retains claims-challenge recovery even with a conflicting service code", async () => {
    const error = await readMicrosoftApiError(new Response(JSON.stringify({
      error: { code: "RoleAssignmentExists", message: "The Role assignment already exists." }
    }), { status: 400, headers: { "www-authenticate": 'Bearer claims="sensitive-challenge"' } }));
    expect(error.message).toBe(CLAIMS_CHALLENGE_MESSAGE);
    expect(JSON.stringify(error)).not.toContain("sensitive-challenge");
  });

  test("redacts tokens and rejects non-code metadata instead of retaining raw responses", async () => {
    const error = await readMicrosoftApiError(new Response(JSON.stringify({
      error: { code: "invalid sensitive value", message: "Bearer abc.def.ghi was rejected", innerError: { secret: "do-not-keep" } }
    }), { status: 401 }));
    expect(error.message).toBe("Bearer [redacted token] was rejected");
    expect(error.code).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("do-not-keep");
  });

  test("keeps HTML gateway responses readable and preserves their status", async () => {
    const error = await readMicrosoftApiError(new Response("<!doctype html><html>gateway</html>", {
      status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/html" }
    }));
    expect(error.status).toBe(502);
    expect(error.message).toContain("Microsoft API returned HTTP 502 Bad Gateway.");
    expect(error.message).toContain("Microsoft gateway returned an HTML error page");
    expect(error.message).not.toContain("<html>");
  });

  test("falls back safely for empty or plain-text error responses", async () => {
    expect((await readMicrosoftApiError(new Response("", { status: 503 }))).message).toBe("Microsoft API returned HTTP 503.");
    expect((await readMicrosoftApiError(new Response("Something   went wrong", { status: 400 }))).message).toBe("Something went wrong");
  });
});
