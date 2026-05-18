# QuickPIM

QuickPIM is a Chrome MV3 extension for quickly activating Microsoft Entra PIM roles, Azure resource PIM roles, and PIM-enabled groups from one compact interface.

## Features

- Activate eligible Entra roles, Azure roles, and PIM groups.
- Resolve friendly role and group names, with custom local aliases when an API still returns an opaque ID.
- Save reusable justifications and quickly reuse recent justifications.
- Create bundles of roles and groups with optional default duration, justification, and ticket metadata.
- Sort and filter by name, type, scope, last use, and activation count.
- Manage aliases, bundles, justifications, preferences, and JSON import/export from the settings page.

## How It Works

QuickPIM watches browser requests to Microsoft Graph and Azure Management endpoints and stores the bearer tokens locally in Chrome storage. Those tokens are then used from the extension background worker to read eligible PIM assignments and submit self-activation requests.

Tokens and settings remain in the local browser profile. QuickPIM does not send data to any service other than Microsoft Graph and Azure Management APIs.

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

## Usage

1. Sign in to the Azure Portal or Microsoft Entra admin center.
2. Navigate around briefly so Graph and Azure Management API requests are made and tokens are captured.
3. Open QuickPIM from the browser toolbar.
4. Select roles or groups, choose a saved or recent justification, then activate.
5. Open Settings to define aliases, saved justifications, bundles, and preferences.

## Manual Verification

After building, load `dist/` and verify:

- Graph and Azure token status appears in the popup header.
- Eligible Entra roles, Azure roles, and PIM groups display friendly names.
- A single role/group activation submits successfully with justification and optional ticket info.
- A saved bundle activates all available included roles/groups.
- Aliases, saved justifications, recent justifications, bundles, sorting, and usage counters persist after reopening the popup.

## Limitations

- Roles protected by authentication contexts may still require extra interactive steps outside the extension.
- QuickPIM depends on tokens already captured from Microsoft first-party portals; it does not perform its own OAuth sign-in flow.

## License

This project is licensed under the MIT License.
