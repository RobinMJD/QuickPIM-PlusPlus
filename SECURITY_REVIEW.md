# QuickPIM++ Security Review

Reviewed for v2.4.0.

## Threat Model

QuickPIM++ is a local MV3 browser extension that captures Microsoft Graph and Azure Management bearer tokens from first-party Microsoft portal traffic. It also runs a narrow content script on `https://entra.microsoft.com/*` to collect access-token candidates already present in that page's MSAL cache, including browser storage and bounded IndexedDB scans, then validates API audience and expiry in the background worker before storing anything. The settings home page also fetches public release or commit metadata from GitHub for the changelog. The main risks are token exposure, over-broad extension permissions, untrusted runtime messages, unsafe imported settings, and unintended API calls outside Microsoft Graph or Azure Management.

## Token Handling

- Captured tokens stay in `chrome.storage.local` and are not sent anywhere except Microsoft Graph and Azure Management APIs.
- The GitHub changelog fetch is read-only public metadata and does not include captured tokens, settings, or local role data.
- Tokens are validated before storage for API audience, parseable expiry, and non-expired status. Graph principal IDs are read from the token when present or resolved through Microsoft Graph `/me` when needed.
- Expired or invalid stored tokens are cleared when detected.
- Errors are redacted before being displayed or returned from the background worker.

## Access And Messaging

- Host permissions are limited to `https://graph.microsoft.com/*`, `https://management.azure.com/*`, `https://entra.microsoft.com/*`, and `https://api.github.com/*` for public changelog metadata.
- Entra content-script token messages are accepted only from the `entra.microsoft.com` origin and still pass the same token validation before storage. The content script runs in matching frames only and limits scanned databases, stores, records, value length, recursion depth, and token count.
- Extension pages use an explicit MV3 content security policy.
- Background runtime messages are accepted only from this extension and are validated before privileged actions run.
- Unsupported token injection paths are not exposed; users can clear captured tokens from Settings.

## Storage And Settings

- Imported settings are normalized through length, type, range, and count limits.
- Popup activation drafts are bounded, stored locally, expire after 24 hours, and are cleared when the in-progress selection is no longer useful.
- Saved justifications, aliases, learned names, bundles, usage history, and preferences remain local to the browser profile.
- Bundle and activation fields are bounded before being sent to Microsoft APIs.

## Dependency And Repository Hygiene

- Build tooling is kept in `devDependencies`.
- `npm audit --audit-level=low` is part of the v2 verification checklist.
- Generated build output, dependencies, and bundled tool runtimes remain ignored by git.

## Remaining Accepted Risks

- QuickPIM++ intentionally relies on captured portal tokens. A compromised browser profile or extension context could still expose local tokens.
- Azure RBAC authorization is enforced server-side by Azure; QuickPIM++ can detect captured Azure Management tokens but cannot prove every target scope has sufficient RBAC until an API call is made.
- Authentication-context-protected activations may still require interactive portal steps outside the extension.
