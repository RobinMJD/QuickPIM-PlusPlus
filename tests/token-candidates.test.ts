import { describe, expect, test } from "vitest";
import { selectPortalTokenCandidates } from "../src/lib/tokenCandidates";

const NOW = Date.parse("2026-07-15T10:00:00.000Z");

describe("portal token candidate selection", () => {
  test("keeps separate Graph tokens needed by Entra roles and PIM Groups", () => {
    const directoryToken = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-1",
      oid: "user-1",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });
    const groupToken = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-1",
      oid: "user-1",
      scp: "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });

    const selected = selectPortalTokenCandidates([directoryToken, groupToken], { now: NOW });

    expect(selected.filter((candidate) => candidate.tokenKind === "graph").map((candidate) => candidate.token)).toEqual(
      expect.arrayContaining([directoryToken, groupToken])
    );
  });

  test("never combines portal tokens from different tenant identities", () => {
    const tenantAGraph = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-a",
      oid: "user-a",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });
    const tenantBGraph = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-b",
      oid: "user-b",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });
    const tenantBAzure = createToken({
      aud: "https://management.azure.com/",
      tid: "tenant-b",
      oid: "user-b",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });

    const selected = selectPortalTokenCandidates([tenantAGraph, tenantBGraph, tenantBAzure], { now: NOW });

    expect(new Set(selected.map((candidate) => candidate.identity))).toEqual(new Set(["tenant-b:user-b"]));
    expect(selected.map((candidate) => candidate.token)).toEqual(expect.arrayContaining([tenantBGraph, tenantBAzure]));
  });

  test("prefers the currently captured identity when that portal account is still represented", () => {
    const tenantAGraph = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-a",
      oid: "user-a",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });
    const tenantBGraph = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-b",
      oid: "user-b",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });

    const selected = selectPortalTokenCandidates(
      [tenantAGraph, tenantBGraph],
      { now: NOW, preferredIdentity: "TENANT-A:USER-A" }
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ identity: "tenant-a:user-a", token: tenantAGraph });
  });

  test("selects the newer equally capable identity when no passive-tab preference is supplied", () => {
    const olderAccountToken = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-a",
      oid: "user-a",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      exp: Math.floor((NOW + 30 * 60_000) / 1000)
    });
    const activeAccountToken = createToken({
      aud: "https://graph.microsoft.com",
      tid: "tenant-b",
      oid: "user-b",
      scp: "RoleAssignmentSchedule.ReadWrite.Directory PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup",
      exp: Math.floor((NOW + 60 * 60_000) / 1000)
    });

    const selected = selectPortalTokenCandidates([olderAccountToken, activeAccountToken], { now: NOW });

    expect(new Set(selected.map((candidate) => candidate.identity))).toEqual(new Set(["tenant-b:user-b"]));
  });
});

function createToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}
