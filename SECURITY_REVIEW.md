# QuickPIM++ Security Review

Reviewed for v2.17.2.

## v2.17.0 Audit Outcome

The repository, built extension, browser permissions, token lifecycle, Microsoft API request paths, runtime messages, imported and synchronized data, reset behavior, release workflows, and dependencies were reviewed. The audit found and fixed:

- A low-severity diagnostics disclosure where an Entra URL fragment could be retained as token provenance and later included in a user-exported support report. Token provenance is now a fixed allowlisted label.
- Incomplete full-reset behavior that could allow browser-synchronized data to return after local storage was cleared. A reset now requires a successful cloud purge and preserves the purge marker before clearing local data.
- Resource-exhaustion paths that normalized oversized imported cache, learned-name, and sync structures before applying final limits. Raw inputs are now bounded before expensive traversal and sorting.
- Defense-in-depth gaps around portal storage capture, Microsoft API redirects, future-dated tokens, write-time token validation, and unsafe object keys. Capture is top-frame only, redirects are rejected, requests omit credentials and referrers, `nbf` is checked with clock skew, privileged writes revalidate audience/expiry/identity, and reserved prototype keys are rejected.

`npm audit --audit-level=low` reported zero known dependency vulnerabilities. No tracked credentials or private-key material were found.

Browser Sync uses immutable activity event identifiers and per-installation monotonic counters to merge concurrent local activity without silently overwriting another installation. It is not a distributed lock: Microsoft remains authoritative when separate browsers submit the same role request at the same time.

The v2.17.0 Browser Sync review additionally validates complete snapshot generations before applying them, accounts for the browser's real JSON storage quota, preserves complete local categories when the cloud copy is truncated, merges concurrent bundle fields and per-installation usage changes, and retries transient delivery failures without making Settings unavailable. A written generation is acknowledged only after it is read back, so a competing last-writer manifest is reconciled on the next pass instead of hiding a local edit.

## Threat Model

QuickPIM++ is a local MV3 browser extension that captures Microsoft Graph and Azure Management bearer tokens from first-party Microsoft portal traffic. It also runs a narrow top-frame content script on `https://entra.microsoft.com/*` to collect access-token candidates already present in that page's bounded MSAL cache, then validates token structure, audience, expiry, not-before time, tenant, and principal in the background worker before storing anything. Microsoft Graph and Azure Management remain the cryptographic signature and authorization enforcement boundary. The settings home page also fetches public release or commit metadata from GitHub for the changelog. The main risks are token exposure, over-broad extension permissions, untrusted runtime messages, unsafe imported settings, and unintended API calls outside Microsoft Graph or Azure Management.

## Token Handling

- Captured tokens stay in `chrome.storage.session` and are not sent anywhere except Microsoft Graph and Azure Management APIs.
- Legacy local token keys are migrated only after validation, copied to session storage for the current browser session, and removed from local storage. Invalid or expired legacy token values are removed without migration.
- Session-stored tokens are cleared by Chrome when the browser session ends.
- The GitHub changelog fetch is read-only public metadata and does not include captured tokens, settings, or local role data.
- Tokens are structurally validated before storage for API audience, parseable expiry, not-before time, tenant ID, and principal ID. Privileged writes repeat these checks and require the token principal to match the selected assignment. Microsoft APIs cryptographically validate token signatures and enforce authorization. A token from another tenant or principal clears the previous session token set before it is stored.
- Token capture, migration, replacement, and cleanup mutations are serialized. Cleanup removes an invalid token only if the stored value still matches the validated stale snapshot, so it cannot delete a token captured concurrently.
- Expired or invalid stored tokens are cleared when detected.
- Errors are redacted before being displayed or returned from the background worker.
- The diagnostics support report contains aggregate counts and sanitized capability state only. It excludes tokens, authorization headers, account names, role names, full object IDs, tickets, and justification text.
- Activation and deactivation operations are journaled in session storage without bearer tokens. The background worker owns the Microsoft request, so closing the popup does not cancel it; reopening the popup reconnects to its progress and result.
- Automatic portal recovery retries only failures identified before an activation or deactivation write was sent. Ambiguous network timeouts and server responses are never replayed automatically, preventing duplicate privileged-access requests.
- Follow-on activation requests are submitted once with a future start time and linked to their source request. Their submission state is persisted before the Microsoft write; an ambiguous result is marked unknown and cannot be retried until the user verifies Microsoft PIM.
- A Microsoft claims or MFA challenge requires a newly captured portal token before retry. QuickPIM++ discards the matching managed recovery tab, opens a fresh inactive portal page, focuses it only when Microsoft requires interaction, and retries after the token signature changes.

## Access And Messaging

- The runtime records browser and Store provenance in sanitized Diagnostics. A confirmed Chrome Web Store copy running in Microsoft Edge is disabled and guided to the Edge Add-ons edition; local development, managed, sideloaded, and unknown installations remain usable. The migration backup contains settings and local activity history, never captured tokens or API caches.

- Host permissions are limited to `https://graph.microsoft.com/*`, `https://management.azure.com/*`, `https://entra.microsoft.com/*`, and `https://api.github.com/*` for public changelog metadata.
- The `alarms` permission is used only to schedule local background pre-refresh. When a token is missing or near expiry, the alarm first asks already-open Entra tabs to rescan their bounded MSAL storage; it skips API work if no usable token is then available and never displays UI messages.
- Request-status alarms are one-shot and exist only while a QuickPIM++ request is unresolved or an enabled expiry reminder is pending. Checks are capped per run, use bounded concurrency and exponential backoff, and stop automatically after 24 hours.
- The `tabGroups` permission is used only to label and collapse temporary portal-recovery tabs created by QuickPIM++. Those tabs open inactive, are tracked in session storage, and close after a matching newer usable token or successful API refresh. Extension-created tabs remain tracked through a hidden Microsoft authentication redirect so account selection can be completed without granting QuickPIM++ access to Microsoft login pages. Moving a tab out of the managed group or navigating it to another visible site untracks it without closing it; a ten-minute alarm removes abandoned managed tabs.
- Entra content-script token messages are accepted only from the top-level `entra.microsoft.com` frame and still pass the same token validation before storage. The content script limits scanned databases, stores, records, value length, recursion depth, and token count.
- Popup refresh, background pre-refresh, and Access Setup share a bounded, timed, single-flight scan of already-open Entra tabs before opening new setup pages; the extension does not request Chrome cookie access and cannot exchange Microsoft session cookies directly for API tokens.
- Extension pages use an explicit MV3 content security policy.
- Background runtime messages are accepted only from this extension and are validated before privileged actions run.
- The popup displays the captured account and tenant context, warns when live tokens belong to different identities, and the background rejects a request whose role principal does not match the selected API token.
- Unsupported token injection paths are not exposed; users can clear captured tokens from Settings.

## Storage And Settings

- Imported settings, browser-sync snapshots, cached assignments, and learned-name maps are bounded before normalization, then normalized through length, type, range, count, timestamp, and reserved-key limits.
- Popup activation drafts are bounded, stored locally, expire after 24 hours, and are cleared when the in-progress selection is no longer useful.
- Popup draft mutations and learned reference-name mutations are serialized; learned names are merged by timestamp so concurrent refresh completion cannot restore stale data.
- Captured tokens, API caches, learned names, popup drafts, in-progress requests, and notification permission remain local to the installation.
- Official Chrome and Edge Store editions can synchronize a bounded, sanitized subset of preferences, aliases, favorites, justifications, bundles, usage, and recent activity through the browser account's extension sync service. Chrome Sync and Microsoft Edge Sync remain separate ecosystems. Random per-installation IDs and user-defined device labels attribute activity without requesting a hostname.
- Browser sync is enabled by default but controlled per installation. Synced data can be purged with independent monotonic purge and resume markers that cannot overwrite each other at the storage-item level. Active purge markers pause other installations before payload keys are removed, reject stale snapshot epochs, and retire stale installation heartbeats on reconciliation.
- A full extension reset requires that browser-sync data is purged first. If the cloud purge cannot be confirmed, local data is left intact and the reset reports an error instead of claiming completion.
- Sync payloads use category timestamps, deferred three-way baselines, deterministic sanitization, bounded chunks, real JSON storage-byte accounting, quota headroom for atomic-generation replacement, per-installation device records, event-union activity merging, and per-installation monotonic usage counters. Clock revisions that cannot be ordered safely keep the local edit pending. Corrupt, partially delivered, stale-epoch, or unsupported generations and control records are rejected without replacing local settings. Tokens and Microsoft request identifiers are never included.
- Tracked request records keep only bounded request identifiers, item metadata, lifecycle state, local justification and ticket text, continuation links, and sanitized diagnostics. Tokens and raw Microsoft API payloads are never persisted in request history.
- Request records are matched to the captured tenant and principal before status calls are made. Microsoft API URLs remain constrained to the existing Graph and Azure Management allowlists.
- Browser notifications require an optional permission requested only when the user enables request notifications; the feature is disabled by default and request tracking remains usable without it.
- Bundle and activation fields are bounded before being sent to Microsoft APIs.
- Activation messages reject duplicate logical role targets, durations outside 30 minutes to 24 hours, and durations above the strictest known tenant policy before a Microsoft write is attempted.
- Fast role loading treats policy metadata as provisional, never substitutes an unknown policy with a successful policy state, and rechecks pending policy data before activation.
- Cached role data is keyed by tenant, principal, and token capability so one signed-in identity cannot reuse another identity's PIM snapshot while a same-capability token renewal can keep fresh cached data.

## Dependency And Repository Hygiene

- Build tooling is kept in `devDependencies`.
- `npm audit --audit-level=low` is part of CI and the exact-tag release gate.
- Release workflows pin third-party actions to immutable commit SHAs, rerun tests and audit, and refuse to overwrite a different existing release asset.
- Chrome Web Store OAuth credentials and Microsoft Edge Add-ons API credentials are read only from protected GitHub environment secrets. They are never embedded in the extension package, repository, release assets, or listing metadata.
- Chrome and Edge packages are generated from the same verified `dist/` payload, checked for a root manifest, matching version, path traversal, and unwanted metadata before publication.
- CI loads the built MV3 extension in Chromium and checks popup keyboard behavior, fixed-width layout, footer alignment, and responsive Settings diagnostics before packaging.
- Generated build output, dependencies, and bundled tool runtimes remain ignored by git.

## Remaining Accepted Risks

- QuickPIM++ intentionally relies on captured portal tokens. Session-only storage reduces persistence, but a compromised live browser profile or extension context could still expose current-session tokens.
- QuickPIM++ does not download Microsoft signing keys or perform local JWT signature verification. Captured candidates remain provisional until Microsoft Graph or Azure Management accepts them; a forged storage value cannot gain Microsoft privileges, but could temporarily disrupt local token selection until it is rejected or replaced.
- Browser extension sync storage is provided by the signed-in browser account and is not treated as encrypted secret storage. Synced data deliberately excludes tokens and live request state, but saved justifications and activity metadata may still be visible to that browser account's sync infrastructure.
- Browser sync is eventually consistent and subject to the provider's transport, policy, and quota limits. Chrome Sync and Microsoft Edge Sync do not exchange extension data with each other; the extension preserves complete local data and exposes Backup & Restore when a bounded cloud category cannot be transported in full.
- Azure RBAC authorization is enforced server-side by Azure; QuickPIM++ can detect captured Azure Management tokens but cannot prove every target scope has sufficient RBAC until an API call is made.
- Authentication-context-protected activations may still require interactive portal steps outside the extension.
