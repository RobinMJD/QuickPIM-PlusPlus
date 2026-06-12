# QuickPIM++

QuickPIM++ is a Microsoft Edge and Chrome MV3 extension for activating Microsoft Privileged Identity Management access faster from a compact browser popup.

It brings Microsoft Entra roles, PIM-enabled groups, and Azure resource roles into one local-first activation console with saved justifications, favorites, bundles, aliases, learned names, and a cleaner settings experience.

Current version: **v2.5.0**

Original author: Daniel Bradley. QuickPIM++ continues the original [QuickPIM](https://github.com/DanielBradley1/QuickPIM) project with later community contributions and the v2 React/TypeScript rewrite.

## Why QuickPIM++ Exists

Microsoft PIM is useful, but the portal flow can be slow when you frequently need short-lived access across several Entra roles, Azure scopes, or PIM groups. QuickPIM++ keeps the security model of just-in-time activation while reducing the repeated portal navigation needed for daily work.

The extension does not create a separate OAuth app registration and does not ask you to paste tokens. It works with Microsoft portal tokens that are already available in your signed-in browser profile, then degrades gracefully when a portal token or API capability is unavailable.

## Highlights

- Activate eligible Microsoft Entra roles, Azure resource roles, and PIM-enabled groups.
- Disable active Microsoft Entra roles, Azure resource roles, and PIM-enabled groups before expiry when Microsoft exposes the needed schedule identifiers.
- See friendly role, group, subscription, admin unit, device, and scope names when Microsoft APIs expose them.
- Keep learned display names locally so old friendly names still work when later token access is limited.
- Override names with local aliases when Microsoft returns opaque IDs or when your organization uses clearer internal naming.
- Mark roles and groups as favorites and keep them at the top of each tab.
- Build activation bundles that can include Entra roles, PIM groups, and Azure roles.
- Skip already-active bundle entries automatically to avoid duplicate activation failures.
- Keep enable and disable selections separate so a popup request does one clear operation at a time.
- Reuse saved justifications and recent justification history.
- Block generic audit justifications such as `BAU`, `Admin`, or `needed`.
- Append `{Activated using QuickPIM++}` to submitted justifications without adding it to the text field.
- Sort and filter by name, scope, last use, activation count, and other useful fields.
- Hide activation counters by default, with a preference to show them when useful.
- Enable only the feature areas you use, skip disabled feature fetches, and automatically omit empty role-type tabs.
- Use dark mode from settings.
- Import and export local settings as JSON.
- View a GitHub-backed changelog from the settings home page.

## What You Can Activate

### Microsoft Entra Roles

QuickPIM++ reads eligible Entra role assignments from Microsoft Graph and can activate or disable directory roles from the popup. It resolves directory role names, detects active roles, displays active status in the relevant role tab, and can show scoped assignments such as tenant, administrative unit, or device scopes with friendly display names when available.

### PIM Groups

QuickPIM++ supports PIM-enabled groups for both member and owner eligibilities. Group display names are learned and cached locally, and group enable/disable requests use the Graph PIM group schedule request APIs.

### Azure Roles

QuickPIM++ supports Azure resource PIM roles from Azure Management APIs. It resolves role definition names, subscription names, inherited scopes, activation policies, and active assignments where the captured portal token allows it.

## Popup Experience

The popup is designed for daily activation:

- Token status for Graph and Azure Management.
- Access warning banner only when a feature area is stale or limited.
- Separate tabs for Entra Roles, PIM Groups, Azure Roles, and Bundles.
- Search and sort controls with compact icons.
- Refresh and portal-link actions in the top control area, with visible refresh progress.
- Favorite stars on role rows.
- Row click selection, plus checkbox selection.
- Active rows can be selected for early disable, while eligible rows are selected for activation.
- Enable and disable selections are mutually exclusive until the selection is cleared.
- Activation review step shown only after pressing `Continue`.
- Disable review skips the duration picker and keeps a two-line optional justification field.
- Duration options capped to what the selected roles or groups allow.
- Justification, ticket system, and ticket number fields shown only when required by selected items.
- Clear progress and completion/error feedback during activation.

## Settings Experience

Settings are organized around setup, configuration, and local data:

- **Home** - brief product overview, quick links, and dynamically loaded GitHub changelog.
- **Access Setup** - guided portal refresh flow for missing or limited feature areas.
- **Aliases** - local display-name overrides for roles, groups, and scopes.
- **Justifications** - saved justification templates and recent history controls.
- **Bundles** - create, edit, duplicate, and remove role/group bundles.
- **Preferences** - activation defaults, recent-history limits, dark mode, and enabled feature areas.
- **Import / Export** - move local configuration between browser profiles.
- **About** - version, attribution, repository links, and local privacy note.

![QuickPIM++ Preferences showing enabled feature areas](docs/images/screenshot-03-enabled-features-1280x800.png)

## Access Setup

QuickPIM++ uses portal-driven access. When it needs a fresh token or a feature area is limited, use **Settings > Access Setup** and choose **Open missing portal pages**.

The guided setup first scans any already-open Entra admin center tabs for fresh portal tokens. It then opens only the Microsoft portal pages still needed for enabled feature areas that are missing or limited:

- Entra roles
- PIM groups
- Azure roles

If the opened portal page asks you to sign in, refresh, or load PIM data, complete that step in the portal tab and return to QuickPIM++. The extension then rechecks captured portal access and refreshes eligible data.

![QuickPIM++ Access Setup showing feature-specific access checks](docs/images/screenshot-02-access-setup-1280x800.png)

## Privacy And Security Model

QuickPIM++ is local-first:

- Tokens are stored only in the local browser profile.
- Settings, aliases, learned names, favorites, bundles, and justification history are local Chrome storage data.
- The extension only calls Microsoft Graph and Azure Management for PIM operations.
- Disabled role features are skipped during refreshes and Access Setup checks.
- Existing Entra admin center tabs are scanned before Access Setup opens more portal pages.
- The settings home page calls the public GitHub API only to show repository changelog entries.
- Runtime messages, imported settings, activation inputs, JWTs, and API URLs are validated before privileged background actions run.
- API errors shown in the UI are sanitized so token-like values and oversized raw messages are not surfaced.

The extension intentionally relies on captured Microsoft first-party portal tokens. A compromised browser profile or malicious extension with broad access to your browser can still be a risk, so keep your browser profile and installed extensions trusted.

## Browser Installation

Build the extension first:

```bash
npm install
npm run build
```

Then load the built extension:

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `dist/` folder from this repository.
5. Pin QuickPIM++ to the browser toolbar.
6. Open Microsoft Entra or Azure Portal, sign in, then run **Settings > Access Setup**.

## Development

Requirements:

- Node.js 20 or newer
- npm
- Microsoft Edge or another Chromium browser for manual extension testing

Install dependencies:

```bash
npm install
```

Run unit and UI tests:

```bash
npm test
```

Type-check and build:

```bash
npm run build
```

Audit dependencies:

```bash
npm audit --audit-level=low
```

The extension version is declared in both `package.json` and `public/manifest.json`; keep them synchronized for each release.

## Manual Verification

After building and loading `dist/`, verify:

- Graph and Azure token statuses appear in the popup header.
- Access Setup opens only the portal pages needed for missing or limited feature areas.
- Refresh shows progress, and the popup refresh icon spins while data is being refreshed.
- Eligible Entra roles, Azure roles, and PIM groups render with friendly names.
- Admin unit, device, subscription, and inherited Azure scope names display when available.
- Search, sort, favorites, enabled features, and dark mode persist after reopening.
- A single role or group activation submits successfully with the required duration and justification.
- An active role or group can be selected and disabled before expiry when Microsoft exposes the active schedule identifiers.
- Activation and deactivation selections cannot be mixed in one request.
- Already-active items show as `active` and show remaining time when available.
- Bundles activate only eligible inactive entries and skip already-active entries.
- Saved justifications and recent justification history update in both popup and settings.
- Import/export preserves aliases, justifications, bundles, favorites, preferences, and learned names.

## Limitations

- QuickPIM++ cannot activate access that Microsoft PIM policy or Azure RBAC denies.
- Roles protected by authentication contexts may still require interactive Microsoft portal steps.
- Microsoft API responses differ by tenant, policy, role type, and portal token capability, so some names or policy limits are best-effort.
- If a portal token expires or does not expose a feature area, QuickPIM++ uses cached eligible data and learned display names where possible, then asks you to refresh portal access.

## Repository Hygiene

- Source lives under `src/`.
- Static extension assets live under `public/`.
- Tests live under `tests/`.
- Production builds go to `dist/` and are ignored by git.
- Dependencies in `node_modules/` are ignored by git.
- Security review notes live in `SECURITY_REVIEW.md`.

## Changelog

### v2.5.0

- Adds early disable requests for active Entra roles, PIM groups, and Azure roles when Microsoft exposes the needed schedule identifiers.
- Keeps activation and deactivation selections mutually exclusive in the popup.
- Adds refresh progress and a spinning refresh icon while data is being refreshed.
- Scans already-open Entra admin center tabs before opening Access Setup portal pages.
- Opens only the still-needed portal pages after that scan.
- Hides popup activation counters by default and adds a preference to show them.

### v2.4.0

- Keeps in-progress popup activation drafts locally when the popup closes or a Microsoft portal/settings tab is opened.
- Restores selected roles or groups, activation duration, justification, ticket fields, tab, search, sort, and review step when the popup reopens.
- Fixes popup activation panel layout so duration, justification shortcuts, and action buttons stay aligned without covering the role list.

### v2.3.1

- Adds direct recovery actions for Microsoft sign-in/MFA claims challenge activation failures, including opening the failed item type's matching portal page.
- Keeps the failed item selected after the challenge so the user can complete the Microsoft prompt and retry without rebuilding the activation request.

### v2.3.0

- Adds a pending approval state for submitted activation requests that are waiting for approval, keeping those rows visible but not selectable.
- Keeps activation progress visible by moving the popup back to the top and making the progress panel sticky while a request is running.
- Keeps failed items selected after partial activation so they can be retried without rebuilding the selection.
- Shows a clear Microsoft sign-in/MFA retry action when Graph returns an activation claims challenge instead of exposing the encoded claims payload.
- Uses "activation request submitted" wording so approval-required PIM group requests are not described as already active.

### v2.2.0

- Shows cached popup data immediately and refreshes stale access data in the background.
- Adds per-feature cache entries so Entra Roles, PIM Groups, and Azure Roles refresh independently.
- Adds a combined activation snapshot request that shares duplicate lookups during eligible/active refreshes.

### v2.1.1

- Fixes the Settings changelog cache so each app version fetches the matching GitHub release notes instead of reusing stale release data.

### v2.1.0

- Adds a dedicated saved justification picker in the popup so saved queries no longer crowd recent suggestions.
- Keeps recent justification chips separate from saved reusable queries.
- Adds ordering controls in Settings > Justifications for saved queries.

### v2.0.1

- Adds enabled feature preferences that control popup visibility, refresh scope, and Access Setup requirements.
- Optimizes eligible and active data loading so disabled role features are not fetched.
- Auto-enables only feature areas that return eligible items after the first successful data load.
- Refreshes the QuickPIM++ PNG logo assets from the SVG source.
- Adds README screenshots and refreshed Chrome Web Store assets for the v2.0.1 release.
- Updates the privacy policy to describe enabled feature behavior.

### Previous v2 release

- Renames the app to QuickPIM++.
- Rebuilds the popup and settings UI with React, TypeScript, and Vite.
- Adds Entra role, Azure role, and PIM group activation from one popup.
- Adds portal-driven Access Setup with local learned-name fallbacks.
- Adds aliases, saved justifications, recent justifications, favorites, and bundles.
- Adds bundle editing, duplication, duration defaults, and active-item skipping.
- Adds active-state detection, activation progress, confirmation, and better error feedback.
- Adds dark mode, hidden-tab preferences, JSON import/export, and a settings home page.
- Adds GitHub-backed changelog rendering in settings.
- Adds stricter validation for tokens, runtime messages, API URLs, activation payloads, and imported settings.
- Narrows extension host permissions to the Microsoft and GitHub endpoints used by the app.
- Documents reviewed security areas in `SECURITY_REVIEW.md`.

## Attribution

Original author: Daniel Bradley, creator of the original [QuickPIM](https://github.com/DanielBradley1/QuickPIM) project.

QuickPIM++ builds on that original idea with a React rewrite, PIM groups, Azure roles, role bundles, saved justifications, favorites, aliases, dark mode, learned names, access setup, and much more!

## License

This project is licensed under the MIT License. See `LICENSE`.
