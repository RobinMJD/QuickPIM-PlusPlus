import { describe, expect, test, vi } from "vitest";
import { runWithActivationPreflight } from "../src/lib/activationSubmission";
import { CLAIMS_CHALLENGE_MESSAGE } from "../src/lib/apiErrors";
import { MicrosoftApiError, readMicrosoftApiError } from "../src/lib/microsoftApiError";
import { buildActivationRequest, buildActivationValidationRequest, normalizeDirectoryRole } from "../src/lib/pim";
import type { ActivationItem, ActivationRequest } from "../src/lib/types";

const au1 = "/administrativeUnits/unit-1";
const au2 = "/administrativeUnits/unit-2";
const start = "2026-09-08T10:00:00.000Z";
const roleAt = (directoryScopeId: string) => normalizeDirectoryRole({
  roleDefinitionId: "fdd7a751-b60b-444a-984c-02652fe8fa1c",
  principalId: "user-1",
  directoryScopeId,
  roleDefinition: { displayName: "Groups Administrator" }
});

describe("scoped Entra activation submission", () => {
  test.each([
    ["tenant first", ["/", au1, au2]],
    ["administrative unit first", [au1, "/", au2]]
  ])("activates the same role at distinct scopes despite preflight conflicts: %s", async (_label, scopes) => {
    const activeScopes = new Set<string>();
    const sent: ActivationRequest[] = [];
    const send = async (request: ActivationRequest) => {
      sent.push(request);
      const scope = request.body.directoryScopeId as string;
      if (request.body.isValidationOnly && activeScopes.size) {
        // Model the cross-scope validation rejection independently of the
        // authoritative activation, which checks the exact requested scope.
        throw await readMicrosoftApiError(new Response(JSON.stringify({
          error: { code: "RoleAssignmentExists", message: "L’affectation de rôle existe déjà." }
        }), { status: 400 }));
      }
      if (request.body.isValidationOnly) return { id: "validation", status: "Granted" };
      if (activeScopes.has(scope)) throw new MicrosoftApiError("The Role assignment already exists.", 400, "RoleAssignmentExists");
      activeScopes.add(scope);
      return { id: `request-${activeScopes.size}`, status: "Provisioned" };
    };

    for (const scope of scopes) {
      const item = roleAt(scope);
      const request = buildActivationRequest(item, 1, "Scoped administration", {}, start);
      const validation = buildActivationValidationRequest(item, 1, "Scoped administration", {}, start)!;
      const result = await runWithActivationPreflight(item, () => send(validation), () => send(request));
      expect(result).toEqual({ id: `request-${activeScopes.size}`, status: "Provisioned" });
    }

    const writes = sent.filter((request) => !request.body.isValidationOnly);
    expect(writes.map((request) => request.body.directoryScopeId)).toEqual(scopes);
    expect(activeScopes).toEqual(new Set(scopes));
    expect(sent.filter((request) => request.body.isValidationOnly)).toHaveLength(3);
    for (const request of writes) {
      expect(request.endpoint).toBe("https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleRequests");
      expect(request.body).toMatchObject({ action: "selfActivate", principalId: "user-1", scheduleInfo: { startDateTime: start } });
      expect(request.body).not.toHaveProperty("isValidationOnly");
    }
  });

  test.each([undefined, "BadRequest", "Request_BadRequest", "Conflict"])("accepts only the precise legacy duplicate message with code %s", async (code) => {
    const validate = vi.fn().mockRejectedValue(new MicrosoftApiError("The Role assignment already exists.", 409, code));
    const result = { id: "pending-scoped-request", status: "PendingApproval" };
    const activate = vi.fn().mockResolvedValue(result);

    await expect(runWithActivationPreflight(roleAt(au1), validate, activate)).resolves.toBe(result);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  test.each([
    new MicrosoftApiError("Access denied", 403, "Authorization_RequestDenied"),
    new MicrosoftApiError("The Role assignment already exists.", 403, "RoleAssignmentExists"),
    new MicrosoftApiError("The Role assignment already exists.", 400, "RoleAssignmentRequestPolicyValidationFailed"),
    new MicrosoftApiError(CLAIMS_CHALLENGE_MESSAGE, 400, "RoleAssignmentExists"),
    new MicrosoftApiError("Conflicting role policy", 409, "Conflict"),
    new MicrosoftApiError("Microsoft API returned HTTP 429.", 429, "RoleAssignmentExists"),
    new Error("Microsoft API request timed out after 30 seconds."),
    new Error("The Role assignment already exists.")
  ])("does not submit an activation after another validation failure: %s", async (error) => {
    const activate = vi.fn();
    await expect(runWithActivationPreflight(roleAt(au1), async () => { throw error; }, activate)).rejects.toBe(error);
    expect(activate).not.toHaveBeenCalled();
  });

  test.each([
    new MicrosoftApiError("The Role assignment already exists.", 400, "RoleAssignmentExists"),
    new MicrosoftApiError("Approval policy rejected the request", 400, "RoleAssignmentRequestPolicyValidationFailed"),
    new Error("Microsoft API request timed out after 60 seconds.")
  ])("never retries or suppresses a real activation failure: %s", async (error) => {
    const validate = vi.fn().mockRejectedValue(new MicrosoftApiError("The Role assignment already exists.", 400, "RoleAssignmentExists"));
    const activate = vi.fn().mockRejectedValue(error);
    await expect(runWithActivationPreflight(roleAt(au1), validate, activate)).rejects.toBe(error);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  test("keeps Azure and PIM-group validation errors outside the Entra fallback", async () => {
    const error = new MicrosoftApiError("The Role assignment already exists.", 400, "RoleAssignmentExists");
    const items: ActivationItem[] = [
      { ...roleAt("/"), type: "azureRole", scope: "/subscriptions/sub-1" },
      { ...roleAt("/"), type: "pimGroup", groupId: "group-1", accessId: "member" }
    ];
    for (const item of items) {
      const activate = vi.fn();
      await expect(runWithActivationPreflight(item, async () => { throw error; }, activate)).rejects.toBe(error);
      expect(activate).not.toHaveBeenCalled();
    }
  });

  test("submits once after a successful or absent preflight", async () => {
    for (const validate of [undefined, vi.fn().mockResolvedValue({ id: "validation" })]) {
      const activate = vi.fn().mockResolvedValue({ id: "actual-request" });
      await expect(runWithActivationPreflight(roleAt(au1), validate, activate)).resolves.toEqual({ id: "actual-request" });
      expect(activate).toHaveBeenCalledTimes(1);
    }
  });
});
