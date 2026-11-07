import { getEffectiveTrackedRequestStatus } from "./requestTracking";
import { activationItemIdentitiesMatch } from "./activationIdentity";
import type { ActivationItem, RequestOperationItemRecord, RequestOperationRecord, TrackedPimRequest } from "./types";

export interface RequestItemProgress { label: string; pending: boolean; attention: boolean; operationId?: string }
export type RequestProgressResolver = (operation: RequestOperationRecord, item: RequestOperationItemRecord, tracked: TrackedPimRequest[]) => RequestItemProgress;
const pendingStatuses = new Set(["submitted", "pendingApproval", "provisioning", "scheduled"]);
export function getRequestItemProgress(operation: RequestOperationRecord, item: RequestOperationItemRecord, tracked: TrackedPimRequest[]): RequestItemProgress {
  const request = tracked.find((candidate) => candidate.operationId === operation.id
    && activationItemIdentitiesMatch(candidate.itemId, item.itemId)
    && candidate.tenantId?.toLowerCase() === (item.tenantId || operation.tenantId)?.toLowerCase()
    && candidate.principalId?.toLowerCase() === (item.principalId || operation.principalId)?.toLowerCase());
  if (!request && (item.result?.trackingUnavailable || item.pendingTrackedRequest)) return { label: "Status unavailable", pending: false, attention: true };
  const uncertain = item.state === "uncertain" || item.result?.outcomeUnknown || (operation.state === "uncertain" && item.state !== "prepared" && !item.result);
  const status = request ? getEffectiveTrackedRequestStatus(request) : uncertain ? undefined : item.result?.requestStatus;
  if (operation.state === "running" && item.result?.accessRecoveryTarget) return { label: "Waiting for Microsoft sign-in", pending: true, attention: true };
  const labels: Record<string, string> = {
    submitted: "Submitted to Microsoft", pendingApproval: "Awaiting approval", provisioning: "Microsoft is applying the request",
    scheduled: "Scheduled", active: "Active", completed: operation.action === "deactivate" ? "Deactivated" : "Completed",
    denied: "Denied", failed: "Failed", canceled: "Canceled", expired: "Expired", unknown: "Outcome unknown", statusUnavailable: "Status unavailable"
  };
  if (status && labels[status]) return { label: labels[status], pending: pendingStatuses.has(status), attention: ["denied", "failed", "unknown", "statusUnavailable"].includes(status) };
  if (uncertain) return { label: "Outcome unknown — check Microsoft PIM", pending: false, attention: true };
  if (operation.state === "error" || item.result?.success === false) return { label: "Failed", pending: false, attention: true };
  if (operation.waitingForAccess && item.state === "prepared") return { label: "Waiting for Microsoft access to the original account", pending: true, attention: true };
  if (operation.state === "running" || item.state === "prepared") return { label: item.state === "prepared" ? "Preparing request" : item.state === "sending" ? "Submitting to Microsoft" : "Saving Microsoft response", pending: true, attention: false };
  return { label: "Accepted by Microsoft", pending: false, attention: false };
}
export function requestBlocksItem(operation: RequestOperationRecord, item: ActivationItem, tracked: TrackedPimRequest[] = []): boolean {
  if (operation.tenantId && item.tenantId && operation.tenantId.toLowerCase() !== item.tenantId.toLowerCase()) return false;
  if (operation.principalId && operation.principalId.toLowerCase() !== item.principalId.toLowerCase()) return false;
  return operation.items?.some((entry) => {
    if (!activationItemIdentitiesMatch(entry.itemId, item.id)) return false;
    const progress = getRequestItemProgress(operation, entry, tracked);
    return progress.pending
      || progress.label.startsWith("Outcome unknown") || progress.label === "Status unavailable";
  }) || false;
}
export function isRequestOperationFinished(operation: RequestOperationRecord, tracked: TrackedPimRequest[]): boolean {
  return ["complete", "error"].includes(operation.state) && !(operation.items || []).some((item) => {
    const progress = getRequestItemProgress(operation, item, tracked);
    return progress.pending || progress.label.startsWith("Outcome unknown") || progress.label === "Status unavailable";
  });
}

export const POPUP_RESULT_NOTICE_MS = 10_000;
export const REQUEST_CONFIRMATION_MS = 60_000;
export function getRequestResultVisibleUntil(operation: RequestOperationRecord, tracked: TrackedPimRequest[]): number {
  const completedAt = Math.max(operation.terminalAt || operation.updatedAt, ...tracked
    .filter((request) => request.operationId === operation.id
      && request.tenantId?.toLowerCase() === operation.tenantId?.toLowerCase()
      && request.principalId?.toLowerCase() === operation.principalId?.toLowerCase())
    .map((request) => Date.parse(request.completedAt || request.activeAssignmentMissingSince || request.activeFrom || request.updatedAt)).filter(Number.isFinite));
  return completedAt + POPUP_RESULT_NOTICE_MS;
}
export function shouldShowPopupRequest(operation: RequestOperationRecord, tracked: TrackedPimRequest[], now = Date.now()): boolean {
  const deadline = getRequestResultVisibleUntil(operation, tracked);
  return !isRequestOperationFinished(operation, tracked)
    || (!operation.popupResultSeenAt && now >= deadline - POPUP_RESULT_NOTICE_MS && now < deadline);
}
export function getRequestRowProgress(operations: RequestOperationRecord[], item: ActivationItem, tracked: TrackedPimRequest[], now = Date.now()): RequestItemProgress | undefined {
  const matching = operations.filter((candidate) => (!candidate.tenantId || candidate.tenantId.toLowerCase() === item.tenantId?.toLowerCase())
    && (!candidate.principalId || candidate.principalId.toLowerCase() === item.principalId?.toLowerCase())
    && candidate.items?.some((entry) => activationItemIdentitiesMatch(entry.itemId, item.id)));
  const blocking = matching.filter((candidate) => requestBlocksItem(candidate, item, tracked));
  const operation = (blocking.length ? blocking : matching).reduce<RequestOperationRecord | undefined>((latest, candidate) =>
    !latest || candidate.startedAt > latest.startedAt ? candidate : latest, undefined);
  const entry = operation?.items?.find((candidate) => activationItemIdentitiesMatch(candidate.itemId, item.id));
  if (!operation || !entry) return;
  const progress = getRequestItemProgress(operation, entry, tracked);
  if (requestBlocksItem(operation, item, tracked)) return { ...progress, operationId: operation.id };
  // Accepted writes and assignment discovery are separate updates. Keep the
  // row guarded through that short gap, without reviving old requests forever.
  const confirmationStartedAt = getRequestResultVisibleUntil(operation, tracked) - POPUP_RESULT_NOTICE_MS;
  if (["running", "complete"].includes(operation.state) && now >= confirmationStartedAt && now < confirmationStartedAt + REQUEST_CONFIRMATION_MS) {
    if (operation.action === "activate" && progress.label === "Active" && item.status !== "active")
      return { label: "Confirming activation", pending: true, attention: false, operationId: operation.id };
    if (operation.action === "deactivate" && progress.label === "Deactivated" && item.status === "active")
      return { label: "Confirming deactivation", pending: true, attention: false, operationId: operation.id };
  }
}
export function getRequestActivitySummary(operations: RequestOperationRecord[], tracked: TrackedPimRequest[], resolve: RequestProgressResolver = getRequestItemProgress): string {
  const pending = operations.filter((operation) => operation.items?.some((item) => resolve(operation, item, tracked).pending)).length;
  const attention = operations.filter((operation) => operation.items?.some((item) => resolve(operation, item, tracked).attention)).length;
  if (pending) return `${pending} request${pending === 1 ? "" : "s"} in progress${attention ? ` · ${attention} ${attention === 1 ? "needs" : "need"} attention` : ""}`;
  if (attention) return `${attention} request${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention`;
  return `${operations.length} new result${operations.length === 1 ? "" : "s"}`;
}
