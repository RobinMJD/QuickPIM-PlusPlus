# QuickPIM++ Privacy Policy

Effective date: May 19, 2026

QuickPIM++ is a local-first browser extension for activating Microsoft Entra Privileged Identity Management roles, Azure resource roles, and PIM-enabled groups.

## Data Processed By The Extension

QuickPIM++ may process the following data in your browser profile:

- Microsoft Graph and Azure Management bearer tokens captured from Microsoft first-party portal pages.
- Eligible and active PIM role, group, and Azure role assignment metadata for enabled QuickPIM++ features.
- Role, group, subscription, administrative unit, device, and scope display names learned from Microsoft APIs.
- Local aliases, favorites, bundles, saved justifications, recent justification history, usage counters, preferences, enabled feature choices, and cached activation data.

## How Data Is Used

QuickPIM++ uses this data only to:

- Display eligible and active PIM assignments in the extension popup for features you have enabled.
- Resolve friendly display names for roles, groups, scopes, subscriptions, administrative units, and devices.
- Submit self-activation requests to Microsoft Graph or Azure Management APIs.
- Store local preferences and convenience data such as aliases, favorites, justifications, bundles, and enabled features.
- Display public changelog information from the QuickPIM++ GitHub repository in Settings.

QuickPIM++ avoids fetching feature areas that are disabled in Preferences, and Access Setup only checks portal access required by enabled role features.

## Data Storage

Tokens, settings, learned names, aliases, favorites, justifications, bundles, and cached role data are stored locally in the browser profile using Chrome extension storage.

QuickPIM++ does not operate a developer-controlled backend service and does not send this local extension data to the developer.

## Data Sharing

QuickPIM++ sends activation and read requests only to Microsoft Graph and Azure Management APIs for the signed-in Microsoft tenant and scopes available to the current user.

The Settings home page may request public release or commit metadata from GitHub's public API to show the project changelog. Local extension data is not included in those GitHub requests.

QuickPIM++ does not sell, rent, or transfer user data to third parties.

## Permissions

QuickPIM++ requests the minimum browser permissions needed for its purpose:

- `storage` to keep local settings, aliases, learned names, cached data, and captured portal tokens.
- `webRequest` to detect Microsoft portal requests containing usable Microsoft Graph or Azure Management bearer tokens.
- Access to `graph.microsoft.com` and `management.azure.com` to read PIM data and submit activation requests for enabled features.
- Access to `entra.microsoft.com` to support portal-driven token capture during Access Setup.
- Access to `api.github.com` to load public changelog data in Settings.

## User Control

You can enable or disable QuickPIM++ feature areas from Preferences. Disabled role features are hidden from the popup, skipped during data refreshes, and omitted from Access Setup checks.

You can clear captured tokens, learned names, recent justification history, and usage metrics from the Settings page.

You can also remove all local extension data by uninstalling QuickPIM++ from the browser.

## Contact

For issues or questions, use the QuickPIM++ GitHub repository:

https://github.com/RobinMJD/QuickPIM-PlusPlus
