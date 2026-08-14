# QuickPIM++ Edge-Case Audit and Remediation Plan

Reviewed against the local `2.17.6` source on 2026-08-14.

This document is an implementation plan, not a record of completed fixes. No application source, generated bundle, version metadata, Git history, GitHub release, Chrome Web Store item, or Edge Add-ons item was changed as part of this audit. Work starts only after an explicit user instruction to proceed.

## Executive Summary

The audit identified 50 distinct edge cases across six system boundaries:

- Microsoft portal token capture and recovery
- API caching and capability diagnostics
- activation and deactivation durability
- request tracking and notifications
- browser sync and tenant isolation
- cross-context storage and reset behavior

The highest-risk cases are not ordinary rendering defects. They involve duplicate or untraceable requests after a service-worker interruption, incorrect reconciliation of a request, tenant-ambiguous identifiers, partially applied sync state, and loss of serialization when Web Locks are unavailable. These should be fixed before lower-risk diagnostics and performance work.

The current unit and browser tests are green, but they do not simulate several critical production conditions: MV3 service-worker termination during a write, full browser restart, slow or federated sign-in, simultaneous popup/settings/background mutations, clock-skewed devices, multiple tenants with overlapping Microsoft IDs, or new Microsoft response statuses.

## Priority Definitions

- **P1:** Can cause a wrong request outcome, duplicate request, lost durable state, tenant crossover, or unrecoverable local inconsistency.
- **P2:** Can block recovery, hide incomplete data, lose notifications, or produce repeated work and misleading status.
- **P3:** Bounded diagnostic, retention, or efficiency issue with a lower correctness impact.

## Remediation Invariants

All implementation work must preserve these invariants:

1. Microsoft access tokens remain session-only and are never included in backup or browser sync.
2. Every role, request, operation, activity entry, and sync category has an explicit tenant boundary.
3. An accepted Microsoft write has a durable local journal record before the UI can report success.
4. A crash or service-worker suspension cannot cause QuickPIM++ to resend an item whose acceptance is uncertain.
5. Recovery completion is based on usable API capability, not only on seeing a different token.
6. Cache freshness represents the latest refresh attempt separately from the last successful snapshot.
7. Cross-context read-modify-write operations have one authoritative serializer.
8. Background recovery never opens multiple sign-in prompts for one user journey.
9. Unknown Microsoft statuses and payloads are visible as contract drift, not silently mapped to a normal state.
10. Browser sync never applies a remote/local merge that cannot be durably committed or safely retried.

## Execution Order

### Phase 0 - Deterministic Failure Harness

**Purpose:** Make lifecycle and concurrency failures reproducible before changing behavior.

**Actions:**

- Add a fake Chrome runtime that can terminate and recreate the service worker between awaited operations.
- Add controllable fake clocks for expiry, retry, recovery leases, and cross-device skew.
- Add abort-aware fake Graph and ARM transports that can complete after a UI timeout.
- Add test fixtures for slow Microsoft sign-in, federated redirects, tenant selection, MFA, and restored recovery tabs.
- Add two-context and three-context storage tests for popup, Settings, and background mutations.
- Add multi-tenant fixtures with intentionally overlapping role and request IDs.
- Capture the current `2.17.6` behavior as regression fixtures without changing production code.

**Exit gate:** Each P1 scenario below can be triggered deterministically by a failing test.

### Phase 1 - Tenant-Aware Identity and Serialized Storage

**Purpose:** Establish the identity and storage foundation needed by later fixes.

**Primary cases:** EC-029, EC-032, EC-033, EC-047, EC-049.

**Actions:**

- Introduce canonical tenant-aware IDs for activation items, tracked requests, operations, activity entries, aliases, favorites, usage, and bundle references.
- Migrate legacy IDs without deleting ambiguous records; mark unresolved legacy entries for user review.
- Route all settings, activity, tracking, and sync read-modify-write operations through the background service worker.
- Add storage revisions or compare-and-swap semantics so stale contexts cannot overwrite newer state.
- Keep Web Locks as an optimization, not as the correctness boundary.

**Exit gate:** Two tenants and three extension contexts can mutate data concurrently without collision or lost updates.

### Phase 2 - Durable Request Journal, Tracking, and Notifications

**Purpose:** Make activation and deactivation safe across popup closure, service-worker suspension, browser restart, and delayed Microsoft processing.

**Primary cases:** EC-018 through EC-028 and EC-034 through EC-044.

**Actions:**

- Move non-secret operation metadata from session storage to a versioned local journal.
- Persist one state machine per requested item: `prepared`, `sending`, `accepted`, `tracking`, `terminal`, or `uncertain`.
- Store a client operation ID and Microsoft request ID independently.
- Write the prepared item before the API request and checkpoint immediately after an accepted response.
- Never automatically retry an `uncertain` write; reconcile it against Microsoft first.
- Make operation retention depend on terminal time and next scheduled action, not a fixed short TTL.
- Replace heuristic reconciliation with tenant-aware, item-aware, status-aware matching.
- Add a durable queue for tracking persistence and notification scheduling.
- Add notification catch-up after browser wake and expose notification failures in Diagnostics.
- Decide explicitly whether tracked requests are local-only or syncable; backup must preserve them if migration is expected to preserve reminders.

**Exit gate:** Killing the service worker at every await point cannot duplicate a request or lose an accepted request's local state.

### Phase 3 - Access Recovery, Token Selection, Cache, and API Diagnostics

**Purpose:** Make automatic recovery converge once, remain actionable, and report partial capability accurately.

**Primary cases:** EC-001 through EC-017, EC-030, and EC-031.

**Actions:**

- Replace fixed recovery timing with an interaction-aware state machine and renewable leases.
- Reconstruct recovery state from tagged open tabs after browser restart.
- Stage one authentication journey before loading additional PIM target pages.
- Recognize safe Microsoft federated/alternate authentication transitions without broadening API host allowlists.
- Verify target capability with the actual eligible/active API before closing recovery tabs.
- Score token candidates by required capability first, then useful lifetime.
- Add `AbortController` propagation from logical timeouts to API and tab work.
- Track `lastAttemptAt`, `lastSuccessAt`, and `lastFailure` separately in cache diagnostics.
- Keep partial data visible but mark the affected target incomplete.
- Prevent popup draft pruning until every enabled target has reached a terminal load state.

**Exit gate:** Missing PIM Group access, slow sign-in, federated sign-in, partial Graph access, and popup reopen all converge without a refresh loop or lost selection.

### Phase 4 - Transactional Browser Sync, Backup, and Reset

**Purpose:** Prevent partial sync application and make reset possible without leaving cloud/local ambiguity.

**Primary cases:** EC-044 through EC-050.

**Actions:**

- Build the merged sync snapshot in memory, write remote state, then atomically commit the corresponding local baseline.
- Record a pending sync transaction when the remote write outcome is unknown.
- Scope every sync category by tenant and retain installation provenance.
- Respect the configured activity limit up to the supported maximum.
- Detect and explain clock skew; use monotonic revision metadata instead of wall-clock timestamps alone for conflict resolution.
- Make local reset always possible; queue or tombstone cloud deletion when offline.
- Include all documented migratable local state in backup, with an explicit list of intentionally local-only data.

**Exit gate:** Two clock-skewed devices can edit alternately or simultaneously without losing accepted data, crossing tenants, or blocking local reset.

### Phase 5 - Diagnostics, Retention, and Performance Hardening

**Purpose:** Resolve remaining bounded issues and make failures observable without slowing the popup.

**Actions:**

- Surface tab scan failures, policy/name lookup incompleteness, notification failures, and unknown Microsoft contracts.
- Sort before applying retention caps during sanitization and import.
- Deduplicate canonical IDs case-insensitively where Microsoft paths are case-insensitive.
- Remove duplicate half-snapshot API calls after partial failure.
- Keep the popup cache-first and render per-target completion without waiting for unrelated targets.
- Add counters for canceled work, late completions, partial snapshots, contract drift, and recovery lease expiry to the local sanitized Diagnostics view.

**Exit gate:** Every remaining finding has a focused regression test and a clear user-facing recovery or diagnostic path.

### Phase 6 - Release Validation and Controlled Publication

**Actions:**

- Run type-check, all unit tests, browser tests, production build, dependency audit, `git diff --check`, and package version checks.
- Run Chrome and Edge unpacked-extension lifecycle tests, including full browser restart and OS sleep/wake.
- Validate read-only portal recovery in a test tenant before any activation mutation.
- With explicit authorization, test one activation and one deactivation for each enabled target type.
- Perform two-device sync tests with Chrome-to-Chrome and Edge-to-Edge; document that the two browser sync services remain separate.
- Bump as a minor release because the work changes storage and lifecycle behavior. Proposed target: `2.18.0`.
- Build one Chromium package unless a store-specific manifest difference genuinely exists.
- Commit, push, tag, create the GitHub release, and publish to stores only after a separate explicit release approval.

## Detailed Finding Ledger

### Access Recovery, Tokens, and Cache

#### EC-001 - Background pre-refresh cannot repair a missing portal token

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/background.ts:1054-1103` refreshes from tokens and scans existing tabs but does not create recovery tabs.
- **Failure mode:** The alarm repeats limited refreshes indefinitely when no suitable portal page is open.
- **Remediation:** Let the background coordinator record a pending recovery need, but open portal pages only from a user-triggered refresh. Keep manual Refresh enabled while an automatic cache refresh is running.
- **Regression test:** Alarm detects missing PIM Group token; popup opens cache immediately and one manual Refresh starts the required recovery journey.

#### EC-002 - Inactive managed tabs can reject a legitimate account or tenant change

- **Priority / phase:** P1 / Phase 3
- **Evidence:** `src/background.ts:1817-1908` prefers stored recovery identity for inactive tabs and rejects an identity change.
- **Failure mode:** A user selects the correct account after the recovery flow captured the wrong account, but QuickPIM++ ignores the replacement token.
- **Remediation:** Bind a recovery session to an explicit expected tenant only after user confirmation or successful target API proof. Allow identity replacement while the session is waiting for interaction.
- **Regression test:** Recovery starts under tenant A, user selects tenant B, and tenant B becomes authoritative without accepting cross-tenant API data into tenant A caches.

#### EC-003 - Federated authentication redirects can be mistaken for unrelated navigation

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/portalRecoveryTabs.ts:561-657` recognizes a bounded Microsoft authentication host set.
- **Failure mode:** Enterprise federation or an alternate Microsoft sign-in host causes a managed tab to be pruned or never recognized as awaiting interaction.
- **Remediation:** Track the navigation chain initiated by a managed Entra tab and allow signed Microsoft authentication transitions plus explicitly recorded federated redirects, without allowing token capture from those hosts.
- **Regression test:** Entra -> Microsoft login -> federated IdP -> Entra completes in one recovery session.

#### EC-004 - The fixed interaction timeout is too short for slow portal loading

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/portalRecoveryTabs.ts` uses a 15-second interaction threshold.
- **Failure mode:** A slow but progressing portal is labeled as requiring user interaction, producing unnecessary warnings or reopen attempts.
- **Remediation:** Renew the interaction timer on meaningful tab progress and distinguish network loading from an actual account/MFA prompt.
- **Regression test:** A 45-second portal load with progress does not become an interaction error.

#### EC-005 - Recovery TTL can close a legitimate long sign-in or MFA flow

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/portalRecoveryTabs.ts:273-287` expires managed recovery state after ten minutes.
- **Failure mode:** A user handling MFA, tenant selection, or a claims challenge loses the recovery tabs before completing the prompt.
- **Remediation:** Use an idle lease renewed by navigation and interaction, plus a larger absolute safety limit. Never close a tab currently displaying a recognized prompt.
- **Regression test:** An 11-minute MFA interaction remains open; an abandoned idle session is eventually cleaned up.

#### EC-006 - Reusing a recovery tab can keep the group alive indefinitely

- **Priority / phase:** P3 / Phase 3
- **Evidence:** `src/lib/portalRecoveryTabs.ts:61-129` resets `createdAt` during reuse.
- **Failure mode:** Repeated refresh attempts perpetually renew stale managed tabs.
- **Remediation:** Keep immutable `firstCreatedAt` and separate renewable `lastProgressAt` and `lastRequestedAt` fields.
- **Regression test:** Repeated no-progress reuse cannot exceed the absolute recovery lifetime.

#### EC-007 - Browser restart loses recovery ownership while tabs may be restored

- **Priority / phase:** P2 / Phase 3
- **Evidence:** Recovery metadata is stored through `chrome.storage.session` in `src/background.ts:1928-1933`.
- **Failure mode:** The browser restores the portal tabs but the new service worker no longer knows they belong to QuickPIM++, leaving orphaned tabs or opening duplicates.
- **Remediation:** Tag managed tabs using a recoverable URL marker and group metadata, then reconstruct only non-sensitive session state on startup.
- **Regression test:** Restart with a recovery group open; the new worker resumes or safely retires it without opening duplicates.

#### EC-008 - Recovery completion is based on a changed token, not proven capability

- **Priority / phase:** P1 / Phase 3
- **Evidence:** `src/lib/portalRecoveryTabs.ts:519-551` completes targets from changed token signatures.
- **Failure mode:** A new token with the same missing capability closes the recovery group and leaves the feature limited.
- **Remediation:** After capture, call the target's cheapest authoritative API and complete only when it succeeds or when a terminal, clearly diagnosed limitation is reached.
- **Regression test:** Token changes but PIM Group write capability remains absent; the recovery session remains actionable and reports the exact limitation.

#### EC-009 - Partial token readiness can create multiple sign-in prompts

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/portalRecoveryTabs.ts:300-312` stages authentication only when no requested target has a usable token.
- **Failure mode:** Graph is ready but Azure and PIM Groups are not, so multiple target tabs can independently enter sign-in.
- **Remediation:** Stage a single authentication bootstrap whenever any target lacks a valid signed-in context, then release target tabs after account selection completes.
- **Regression test:** Three targets missing different tokens produce at most one interactive account prompt.

#### EC-010 - Existing-tab scanning is capped and failures are invisible

- **Priority / phase:** P3 / Phase 5
- **Evidence:** `src/lib/portalTokenRefresh.ts:35-87` scans at most eight tabs and suppresses query/message failures.
- **Failure mode:** A usable ninth tab or a content-script failure is skipped, but Diagnostics says only that access is missing.
- **Remediation:** Rank tabs by relevance and recency, scan in bounded batches, and record sanitized query/injection/message failures.
- **Regression test:** The ninth relevant Entra tab is eventually scanned; one blocked content script is visible in Diagnostics.

#### EC-011 - Cache identity omits token generation and effective capability

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/access.ts:184-192` derives cache identity from account identity and scope lists.
- **Failure mode:** A newly captured token with the same visible scopes but different hidden capability reuses an incompatible cache snapshot.
- **Remediation:** Include a non-secret token generation fingerprint and capability proof revision in cache identity.
- **Regression test:** Same account and scope strings with a new token generation invalidates the target cache once.

#### EC-012 - Failed refresh retains old freshness metadata

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/cache.ts:317-359` preserves the prior successful entry after a failed same-key refresh.
- **Failure mode:** The UI can continue treating old data as fresh even though the latest attempt failed.
- **Remediation:** Store snapshot success time separately from latest attempt/failure time and derive status from both.
- **Regression test:** A fresh snapshot followed by a 403 remains usable but displays a current limited/stale diagnostic and is eligible for recovery.

#### EC-013 - Token claims alone can mark a feature ready

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/access.ts:194-293` can derive readiness without a recent successful API proof.
- **Failure mode:** Microsoft accepts the token structurally but rejects the actual endpoint, while the header still implies readiness.
- **Remediation:** Distinguish `tokenReady` from `apiReady`; only the latter yields a fully ready feature state.
- **Regression test:** Valid token plus endpoint 403 displays limited access, not ready.

#### EC-014 - Fresh cached data can delay recovery after a new capability failure

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/portalTokenRefresh.ts:119-145` gates non-ready recovery by force or staleness.
- **Failure mode:** A new API failure occurs while cached data is still fresh, so automatic popup recovery keeps waiting until the cache ages.
- **Remediation:** A new target capability failure must override cache freshness and create an immediately actionable recovery state.
- **Regression test:** Fresh cache plus new missing-capability response enables Refresh recovery immediately.

#### EC-015 - Restored popup selections can be pruned before recovery finishes

- **Priority / phase:** P1 / Phase 3
- **Evidence:** `src/popup/main.tsx:562-590` prunes after `hasActivationDataLoaded`; `src/popup/main.tsx:1221-1227` can mark loading complete while recovery remains pending.
- **Failure mode:** Closing and reopening during token recovery loses the selected items even though they return later.
- **Remediation:** Track terminal load state per enabled target and prune only IDs from targets that completed authoritative loading.
- **Regression test:** A restored PIM Group selection survives Entra-first rendering and is retained when PIM Groups complete later.

#### EC-016 - A weaker long-lived token can beat a stronger short-lived token

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/background.ts:2061-2159` gives a useful-lifetime preference before all capability/strength considerations.
- **Failure mode:** A token that could perform the requested operation is rejected in favor of a longer-lived token that cannot.
- **Remediation:** Rank candidates by target capability, audience, principal/tenant match, and source trust before lifetime.
- **Regression test:** A 10-minute PIM-capable token replaces a 60-minute read-only token for PIM operations.

#### EC-017 - Logical timeouts do not cancel underlying work

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/lib/async.ts:8-25` rejects on timeout without canceling the promise; target fetches use it in `src/background.ts:2335-2435`.
- **Failure mode:** A timed-out fetch or storage write completes later while the user has started another refresh, causing overlapping requests or stale late writes.
- **Remediation:** Propagate `AbortSignal`, reject late commits by operation revision, and expose work that cannot be canceled.
- **Regression test:** A timed-out first refresh cannot overwrite or duplicate a successful second refresh.

### Activation and Deactivation Durability

#### EC-018 - The operation ledger is lost on full browser restart

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/lib/requestOperations.ts` persists operations in session storage.
- **Failure mode:** An accepted or in-flight request loses its reconciliation state when the browser session ends.
- **Remediation:** Persist non-secret operation metadata in versioned local storage; keep tokens session-only.
- **Regression test:** Restart after Microsoft accepts a request but before popup acknowledgement; the operation reconciles exactly once.

#### EC-019 - The operation cap can evict a still-running operation

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/lib/requestOperations.ts:12-16,144-175` caps the ledger at 20 entries.
- **Failure mode:** Many requests can push an older running operation out of the ledger before it finishes.
- **Remediation:** Never evict non-terminal operations; cap terminal history separately.
- **Regression test:** More than 20 operations retain every running entry and only evict oldest terminal entries.

#### EC-020 - A fixed two-hour TTL can erase work after browser sleep

- **Priority / phase:** P2 / Phase 2
- **Evidence:** `src/lib/requestOperations.ts:186-225` applies a two-hour lifetime.
- **Failure mode:** A laptop sleeps through the TTL and wakes with no operation to reconcile.
- **Remediation:** Retain running/uncertain operations until reconciliation plus a long safety horizon; base expiry on terminal time.
- **Regression test:** Eight-hour sleep preserves and reconciles a non-terminal operation.

#### EC-021 - There is no durable per-item checkpoint

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/lib/requestOperations.ts` stores an aggregate operation rather than a durable state for every item.
- **Failure mode:** After interruption, QuickPIM++ cannot know which bundle items were unsent, accepted, or still uncertain.
- **Remediation:** Journal each item before sending and checkpoint every transition independently.
- **Regression test:** Terminate after item 2 of 4 is accepted; restart does not resend items 1 or 2 and can safely continue/reconcile 3 and 4.

#### EC-022 - Orphan reconciliation treats any match as success

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/background.ts:1314-1475` completes an orphan when a matching tracked request exists without requiring a successful terminal Microsoft state.
- **Failure mode:** A denied, failed, canceled, or still-pending request can be reported locally as successful.
- **Remediation:** Reconcile transport acceptance separately from Microsoft workflow outcome and preserve the actual status.
- **Regression test:** Matching denied request becomes `denied`, matching pending request remains `tracking`, and only successful terminal status becomes completed.

#### EC-023 - Legacy heuristic matching can attach the wrong concurrent request

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/lib/requestOperations.ts:77-105` includes heuristic matching for legacy operations.
- **Failure mode:** Two identical role requests near the same time can be cross-associated.
- **Remediation:** Require tenant-aware client operation IDs for new writes and quarantine ambiguous legacy matches for manual review.
- **Regression test:** Two same-role requests with different client IDs never reconcile to each other.

#### EC-024 - Popup polling can starve an older terminal operation

- **Priority / phase:** P2 / Phase 2
- **Evidence:** `src/popup/main.tsx:678-734` selects the first unmatched operation.
- **Failure mode:** A newer running operation keeps being polled while an older completed operation waits unacknowledged.
- **Remediation:** Process terminal unacknowledged operations first, then running operations ordered by oldest next action.
- **Regression test:** One running and one completed operation reconcile the completed operation immediately.

#### EC-025 - Popup acknowledgement occurs even if local reconciliation persistence fails

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/popup/main.tsx:1693-1708` reconciles detached results and `src/popup/main.tsx:1773-1775` acknowledges in `finally`.
- **Failure mode:** History, draft cleanup, or cache refresh can fail, but the only recoverable operation record is still acknowledged.
- **Remediation:** Acknowledge only after a durable reconciliation transaction commits; keep retry metadata on partial failure.
- **Regression test:** Inject activity/history storage failure and verify the operation remains pending reconciliation.

#### EC-026 - Detached reconciliation depends on the current visible item list

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/popup/main.tsx:1693-1708` reconstructs results from currently loaded activation items.
- **Failure mode:** A hidden tab, disabled source, changed filter, or missing token prevents correct activity and draft reconciliation.
- **Remediation:** Persist the immutable item snapshot needed for reconciliation inside each operation item.
- **Regression test:** Disable the source after submission; reopening still records the correct role name/type/scope/result.

#### EC-027 - Accepted writes persist operation and activity only best-effort

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/background.ts:1314-1475` and the activation write flow use best-effort follow-up persistence.
- **Failure mode:** Microsoft accepts the request, but QuickPIM++ loses all local proof and may invite a retry.
- **Remediation:** Use the durable journal transaction as the acceptance boundary and show `accepted, local follow-up pending` when auxiliary persistence fails.
- **Regression test:** Storage failure after HTTP success leaves an `uncertain/accepted` record and prevents automatic resubmission.

#### EC-028 - Tracking persistence timeout has no durable retry queue

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/background.ts:3926-3953` applies a 750 ms tracking storage timeout; the timeout does not cancel work.
- **Failure mode:** A slow storage area loses tracking and notification setup or completes late out of order.
- **Remediation:** Journal tracking work and retry it from the background with revision checks rather than treating 750 ms as a terminal failure.
- **Regression test:** A two-second storage write eventually commits once and does not overwrite newer tracking state.

#### EC-029 - Raw ID deduplication is case-sensitive

- **Priority / phase:** P2 / Phase 1
- **Evidence:** `src/background.ts:3902-3904` and `src/lib/cache.ts:417-419` deduplicate raw strings.
- **Failure mode:** Equivalent Microsoft resource paths with different casing can appear twice or be requested twice.
- **Remediation:** Canonicalize known case-insensitive IDs and Azure resource paths before identity and dedupe operations.
- **Regression test:** Mixed-case full and leaf IDs normalize to one item without collapsing genuinely distinct resources.

#### EC-030 - A partial combined snapshot failure reruns successful API reads

- **Priority / phase:** P2 / Phase 3
- **Evidence:** `src/background.ts:2494-2531` retries eligible and active reads together after combined failure.
- **Failure mode:** If eligible succeeds and active fails, eligible is fetched again, increasing latency and throttling risk.
- **Remediation:** Preserve fulfilled halves and retry only the failed half with its own diagnostic.
- **Regression test:** Eligible succeeds once, active fails then retries; eligible endpoint is called exactly once.

#### EC-031 - Policy and name lookup failures are swallowed

- **Priority / phase:** P2 / Phase 5
- **Evidence:** `src/background.ts:2801-2828`, `3085-3147`, `3220-3232`, and `3444-3467` retain fallback data without complete diagnostics.
- **Failure mode:** Raw names or unknown policy limits appear while the feature looks completely ready.
- **Remediation:** Preserve usable items but attach target/item-level partial-data diagnostics and suppress unsafe activation defaults when policy is unknown.
- **Regression test:** Name lookup failure shows learned/raw fallback; policy lookup failure marks duration/requirements unknown rather than ready-default.

### Request Tracking and Notifications

#### EC-032 - Tracked request IDs are not tenant-aware

- **Priority / phase:** P1 / Phase 1
- **Evidence:** `src/lib/requestTracking.ts` builds identity without tenant; `src/lib/activationIdentity.ts:3-11` also omits tenant from role identity.
- **Failure mode:** The same Microsoft request ID in two tenants can overwrite or match the wrong entry.
- **Remediation:** Include normalized tenant ID in every new tracked request and role identity.
- **Regression test:** Identical request and role IDs in tenants A and B remain distinct through tracking, activity, and sync.

#### EC-033 - Tenantless legacy requests match any tenant

- **Priority / phase:** P1 / Phase 1
- **Evidence:** `src/lib/requestTracking.ts` accepts tenantless legacy records when other identity fields match.
- **Failure mode:** An imported old record can attach to the wrong tenant.
- **Remediation:** Migrate only when a single tenant can be proven; otherwise label the record legacy/unscoped and exclude it from automatic reconciliation.
- **Regression test:** Ambiguous legacy record never updates a current-tenant request automatically.

#### EC-034 - Scheduled extension can outlive request tracking retention

- **Priority / phase:** P1 / Phase 2
- **Evidence:** `src/lib/requestExtension.ts:84-85` starts extension one second after current expiry; `src/lib/requestTracking.ts` uses a fixed 24-hour TTL.
- **Failure mode:** A continuation scheduled more than 24 hours ahead is deleted before it starts.
- **Remediation:** Retain until the later of terminal completion, scheduled start plus grace, or explicit user deletion.
- **Regression test:** A continuation scheduled 72 hours ahead remains tracked through start and completion.

#### EC-035 - Fixed check-count exhaustion can abandon long approvals

- **Priority / phase:** P2 / Phase 2
- **Evidence:** `src/lib/requestTracking.ts` caps status checks at 30.
- **Failure mode:** Frequent early checks consume the budget while a legitimate approval remains pending for many hours.
- **Remediation:** Use time-based backoff and a terminal deadline, not a fixed count alone.
- **Regression test:** A 24-hour pending approval remains tracked with progressively slower checks.

#### EC-036 - Unknown Microsoft status is normalized to submitted

- **Priority / phase:** P2 / Phase 5
- **Evidence:** `src/lib/requestTracking.ts:464-504` maps unrecognized statuses into the normal submitted path.
- **Failure mode:** A new Microsoft failure/terminal status can remain indefinitely pending and never alert diagnostics.
- **Remediation:** Preserve `unknown:<raw-status>`, stop unsafe assumptions, and expose contract drift.
- **Regression test:** An unseen status becomes unknown, remains visible, and does not trigger success/expiry behavior.

#### EC-037 - Missing request payload consumes a retry

- **Priority / phase:** P2 / Phase 2
- **Evidence:** `src/background.ts:786-803` handles a request absent from a collection response as a failed check.
- **Failure mode:** Eventual consistency or pagination can consume the check budget and abandon tracking.
- **Remediation:** Query the request directly by ID when collection lookup misses, and classify `not yet visible` separately from a failed check.
- **Regression test:** Two collection misses followed by direct success do not consume failure budget.

#### EC-038 - Expiry catch-up grace is only one hour

- **Priority / phase:** P2 / Phase 2
- **Evidence:** `src/lib/requestTracking.ts` limits reminder catch-up after the expected time.
- **Failure mode:** A sleeping or powered-off computer misses the reminder entirely.
- **Remediation:** On wake, notify if the activation is still active and no reminder was sent; otherwise record a visible missed reminder event.
- **Regression test:** Four-hour sleep wakes before actual expiry and sends one catch-up reminder, never duplicates it.

#### EC-039 - Active request without an end time can stay active forever

- **Priority / phase:** P2 / Phase 2
- **Evidence:** `src/lib/requestTracking.ts` cannot expire an active entry without `activeUntil`.
- **Failure mode:** Activity and notifications retain a permanently active state after Microsoft omitted an end time.
- **Remediation:** Periodically re-query authoritative assignment state and mark unknown-duration entries as `active, end unknown` with bounded polling.
- **Regression test:** Missing end time followed by absent active assignment transitions to expired/completed.

#### EC-040 - Notification IDs truncate request IDs

- **Priority / phase:** P2 / Phase 5
- **Evidence:** `src/background.ts:909-975` slices request IDs when constructing and matching notification IDs.
- **Failure mode:** Long IDs with the same prefix can collide, and button actions can open the wrong request.
- **Remediation:** Use a fixed-length hash of tenant plus full request identity and keep a lookup map.
- **Regression test:** Two 200-character IDs sharing the first 128 characters create distinct actionable notifications.

#### EC-041 - Notification creation failures are invisible

- **Priority / phase:** P2 / Phase 5
- **Evidence:** `src/background.ts:807-853` suppresses notification API failures.
- **Failure mode:** Permission, OS-level suppression, or browser API failure produces no reminder and no actionable explanation.
- **Remediation:** Record sanitized notification outcome and expose a test-notification action in Diagnostics.
- **Regression test:** Denied permission and API exception each produce a distinct diagnostic without repeated prompts.

#### EC-042 - Tracked request retention caps before sorting

- **Priority / phase:** P2 / Phase 5
- **Evidence:** `src/lib/requestTracking.ts:533-547` keeps the first 100 sanitized records before final ordering.
- **Failure mode:** Unsorted imported or externally modified data can discard the newest requests.
- **Remediation:** Sanitize all bounded candidates, sort by authoritative timestamp, then cap.
- **Regression test:** A reverse-ordered 150-entry import retains the newest 100.

#### EC-043 - Activity retention caps before sorting

- **Priority / phase:** P2 / Phase 5
- **Evidence:** `src/lib/settings.ts:683-731` applies a limit during sanitization before guaranteed chronological ordering.
- **Failure mode:** Backup/import or sync order can discard recent activity and retain older events.
- **Remediation:** Deduplicate and sort before applying the configured retention limit.
- **Regression test:** Shuffled activity retains exactly the newest configured entries.

#### EC-044 - Tracked requests do not move with backup or browser sync

- **Priority / phase:** P1 / Phase 4
- **Evidence:** `src/lib/settingsBackup.ts:34-35,57-71` exports settings data; tracking remains a separate local store.
- **Failure mode:** A migration or second device shows activity but cannot poll status or issue expiry reminders for the corresponding request.
- **Remediation:** Include a safe tracked-request subset in backup. For sync, either synchronize tracking with tenant/device ownership rules or clearly designate one owner and show that ownership on other devices.
- **Regression test:** Backup/restore preserves request follow-up without copying tokens; two devices do not duplicate reminders.

### Browser Sync, Storage, and Reset

#### EC-045 - Sync applies local merged settings before remote commit

- **Priority / phase:** P1 / Phase 4
- **Evidence:** `src/lib/browserSync.ts:414-428` applies merged settings locally before the remote write at `438-449`.
- **Failure mode:** A failed remote write leaves local state changed while the sync baseline still represents another state.
- **Remediation:** Stage the merge, commit remote state, then atomically commit local state and baseline; retain a recoverable transaction when outcome is uncertain.
- **Regression test:** Remote write failure leaves local settings unchanged or records an explicit pending transaction that retries safely.

#### EC-046 - Synced activity is capped below the local supported limit

- **Priority / phase:** P2 / Phase 4
- **Evidence:** `src/lib/browserSync.ts` uses a sync activity maximum of 100 while local preferences allow a higher history limit.
- **Failure mode:** A user configured for 200 entries silently receives only 100 cross-device entries.
- **Remediation:** Respect the configured bounded limit while staying within sync quota through chunking and size-aware retention.
- **Regression test:** A 200-entry setting syncs the newest 200 when quota allows and reports explicit truncation otherwise.

#### EC-047 - Synced role-specific data is not tenant-scoped

- **Priority / phase:** P1 / Phase 1
- **Evidence:** `src/lib/browserSync.ts:47-85` defines global categories for aliases, favorites, bundles, usage, and activity.
- **Failure mode:** Switching tenants can apply names, favorites, bundles, or usage from another tenant whose IDs overlap.
- **Remediation:** Partition role-specific categories by tenant; keep only truly global UI preferences outside tenant partitions.
- **Regression test:** Tenant A and B sync simultaneously without applying any role-specific record across tenants.

#### EC-048 - Clock-skewed devices can dominate last-write-wins merging

- **Priority / phase:** P2 / Phase 4
- **Evidence:** `src/lib/browserSync.ts` accepts a broad wall-clock skew tolerance and uses timestamps for category conflict resolution.
- **Failure mode:** A fast clock can make one device's categories appear newer for hours and suppress valid changes from another device.
- **Remediation:** Use per-installation sequence numbers plus observed remote revision; reserve timestamps for display and tie-breaking only.
- **Regression test:** Devices skewed by plus/minus 12 hours alternate edits without one permanently winning.

#### EC-049 - Storage fallback lock is not cross-context

- **Priority / phase:** P1 / Phase 1
- **Evidence:** `src/lib/storageMutation.ts:1-16` falls back to an in-module queue when Web Locks are unavailable.
- **Failure mode:** Popup, Settings, and background each have separate queues and can overwrite one another's read-modify-write updates.
- **Remediation:** Centralize mutations in the background and require revisioned messages; treat Web Locks as an additional optimization.
- **Regression test:** Three contexts mutate different settings/activity records concurrently with Web Locks disabled and no update is lost.

#### EC-050 - Cloud purge failure can block local reset

- **Priority / phase:** P1 / Phase 4
- **Evidence:** `src/lib/extensionReset.ts:16-40` requires browser-sync purge before local clear.
- **Failure mode:** An offline or broken sync service prevents a user from resetting local QuickPIM++ data; partial failures can leave unclear state.
- **Remediation:** Always allow local reset after explicit confirmation, write a cloud deletion tombstone when possible, and retry remote cleanup later.
- **Regression test:** Offline reset clears local state, queues remote deletion, and prevents old cloud data from silently restoring before the tombstone resolves.

## Retired Findings From the Previous Report

The previous `2.16.8` report was revalidated rather than copied forward. These issues are no longer open in their original form:

- Partial Azure subscription failures now retain usable data and surface partial failure through `PartialActivationDataError`.
- Azure management-group discovery exists in the current code.
- Successful but untrackable writes now expose `trackingUnavailable` rather than ordinary tracked success.
- Imported timestamp validation has been tightened.
- Operation TTL and heartbeat behavior were improved, although EC-018 through EC-021 capture remaining lifecycle gaps.
- Browser sync now has a three-way merge, although EC-045, EC-047, and EC-048 capture remaining transaction and tenant-boundary gaps.
- Canonical identity handling improved, although EC-029, EC-032, and EC-033 remain.
- Web Locks were added, although EC-049 remains when they are unavailable or split across contexts.

## Required Test Matrix

Before implementation is considered complete, the following matrix must pass:

| Scenario | Chrome | Edge | Unit/fake runtime | Live test tenant |
|---|---:|---:|---:|---:|
| Service worker stops before send | Yes | Yes | Required | No mutation required |
| Service worker stops after Microsoft accepts | Yes | Yes | Required | One authorized request |
| Full browser restart with running operation | Yes | Yes | Required | One authorized request |
| Popup closes during bundle item 2 of 4 | Yes | Yes | Required | Test-tenant bundle |
| Slow sign-in over 10 minutes | Yes | Yes | Required | Read-only recovery |
| Federated sign-in and MFA | Yes | Yes | Required | Read-only recovery |
| Two tenants with overlapping IDs | Yes | Yes | Required | Two test tenants if available |
| Popup/settings/background concurrent writes | Yes | Yes | Required | Not needed |
| Two devices with clock skew and offline periods | Yes | Yes | Required | Signed-in sync profiles |
| Notification permission denied and OS suppressed | Yes | Yes | Required | Not needed |
| Unknown Microsoft status and missing request payload | N/A | N/A | Required | Mock only |
| Reset while sync is offline | Yes | Yes | Required | Not needed |

## Verification Gates

Run these after each phase, not only at the end:

```text
type-check
unit tests
targeted lifecycle/concurrency tests
production build
git diff --check
```

Final release gate:

```text
npm test
npm run build
npm run test:e2e
npm audit --audit-level=low
git diff --check
manifest/package/version synchronization check
Chrome unpacked smoke test
Edge unpacked smoke test
Chrome and Edge package manifest inspection
```

## Current Audit Verification

- Type-check: passed.
- Vitest: 43 files, 483 tests passed.
- Playwright: 8 tests passed.
- Dependency audit: not completed in this shell. The validated bundled runtime exposes Node and pnpm, while this repository uses `package-lock.json` and does not contain a pnpm lockfile. The remediation run must execute `npm audit` in CI or a runtime with npm available.
- Live Microsoft mutation tests: not run; this was a read-only audit.
- Full browser restart, federated authentication, OS sleep/wake, and real multi-device sync: not proven by the existing suite.

## Start Procedure When Approval Is Given

1. Re-read this report against the then-current source and retire any findings already fixed.
2. Record the dirty baseline and preserve all unrelated user changes.
3. Create a dedicated remediation branch, proposed name `codex/edge-case-remediation-v2.18.0`, unless the user explicitly selects another workflow.
4. Implement Phase 0 first and demonstrate failing tests for P1 cases before production fixes.
5. Complete phases in dependency order; do not bundle all 50 cases into one unreviewable patch.
6. Report after each phase: fixed case IDs, tests added, commands run, remaining risks, and any Microsoft contract assumptions.
7. Stop before version bump, commit, push, tag, release, or Store submission unless those actions are explicitly authorized at that time.
