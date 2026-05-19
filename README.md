# QuickPIM++

QuickPIM++ is a Chrome MV3 extension for quickly activating Microsoft Entra PIM roles, Azure resource PIM roles, and PIM-enabled groups from one compact interface.

Current version: **v2.0.0**

Original author: Daniel Bradley. QuickPIM++ continues the original QuickPIM project with later community contributions and the v2 React/TypeScript rewrite.

## Features

- Activate eligible Entra roles, Azure roles, and PIM groups.
- Resolve friendly role and group names, with custom local aliases when an API still returns an opaque ID.
- Save reusable justifications and quickly reuse recent justifications.
- Create bundles of roles and groups with optional default duration and justification.
- Sort and filter by name, type, scope, last use, and activation count.
- Use Access Setup to open the right Microsoft portal pages when QuickPIM++ needs fresh portal tokens.
- Use the settings home page for a quick overview and a GitHub-backed changelog.
- Manage aliases, bundles, justifications, learned names, preferences, and JSON import/export from the settings page.

## How It Works

QuickPIM++ watches browser requests to Microsoft Graph and Azure Management endpoints and stores the bearer tokens locally in Chrome storage. When the guided Access Setup opens Microsoft Entra pages, QuickPIM++ also reads validated access-token candidates from that Entra page's local MSAL cache, including browser storage and IndexedDB, because some portal views no longer make direct Graph requests that extensions can observe. Those tokens are then used from the extension background worker to read eligible PIM assignments and submit self-activation requests.

Tokens and settings remain in the local browser profile. QuickPIM++ uses Microsoft Graph and Azure Management APIs for PIM data and activation, and fetches public release metadata from the QuickPIM GitHub repository for the settings changelog without sending local extension data.

## Development

Requirements:

- Node.js 20 or newer
- npm
- Chrome or another Chromium browser for manual extension testing

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Build the extension:

```bash
npm run build
```

Load `dist/` as an unpacked extension from `chrome://extensions`.

The extension version is declared in both `package.json` and `public/manifest.json`; keep them in sync for each release.

## Usage

1. Sign in to the Azure Portal or Microsoft Entra admin center.
2. Use Settings > Access Setup, or open the matching Entra/Azure PIM pages, so Graph and Azure Management API requests are made and tokens are captured.
3. Open QuickPIM++ from the browser toolbar.
4. Select roles or groups, choose a saved or recent justification, then activate.
5. Open Settings to define aliases, saved justifications, bundles, and preferences.

## Manual Verification

After building, load `dist/` and verify:

- Graph and Azure token status appears in the popup header.
- Access Setup opens only the portal pages needed for missing or limited feature areas.
- Eligible Entra roles, Azure roles, and PIM groups display friendly names.
- A single role/group activation submits successfully with justification and optional ticket info.
- A saved bundle activates all available included roles/groups.
- Aliases, saved justifications, recent justifications, bundles, sorting, and usage counters persist after reopening the popup.

## Limitations

- Roles protected by authentication contexts may still require extra interactive steps outside the extension.
- QuickPIM++ depends on tokens already captured from Microsoft first-party portals; it does not perform its own OAuth sign-in flow.

## Changelog

### v2.0.0

- Adds visible versioning and original author attribution.
- Adds portal-driven Access Setup and local learned-name fallbacks.
- Narrows extension host permissions to Microsoft Graph, Azure Management, Microsoft Entra portal pages used for token capture, and GitHub's public API for the settings changelog.
- Adds stricter token, runtime message, activation payload, and settings import validation.
- Adds a settings About page with token-clearing controls and local privacy notes.
- Documents the security review in `SECURITY_REVIEW.md`.

## License

This project is licensed under the MIT License.
