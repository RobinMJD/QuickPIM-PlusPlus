# QuickPIM++ Store Listing (en-US)

## Identity

- Product name: `QuickPIM++`
- Category: `Developer Tools`
- Language: `English (United States)`
- Website: `https://github.com/RobinMJD/QuickPIM-PlusPlus`
- Support URL: `https://github.com/RobinMJD/QuickPIM-PlusPlus/issues`
- Privacy policy: `https://github.com/RobinMJD/QuickPIM-PlusPlus/blob/main/PRIVACY.md`
- Pricing: Free
- Visibility: Public
- Markets: All available markets, including future markets
- Mature content: No

## Short Description

Activate Microsoft Entra roles, Azure roles, and PIM groups from one fast, local-first browser extension.

## Full Description

QuickPIM++ makes Microsoft Privileged Identity Management easier to use without weakening its just-in-time access model. It brings eligible Microsoft Entra roles, PIM-enabled groups, Azure resource roles, and reusable activation bundles into one focused browser popup.

Find the access you need, choose a policy-compliant duration, provide a meaningful justification when required, and submit the activation without repeatedly navigating Microsoft portal blades. Active PIM assignments can be reviewed and, when Microsoft exposes the required schedule identifiers, disabled before expiry.

Highlights:

- Separate views for Microsoft Entra roles, PIM groups, and Azure resource roles.
- Friendly names for roles, groups, subscriptions, administrative units, devices, and scopes when available.
- Favorites, aliases, search, sorting, saved justifications, and recent reason history.
- Activation bundles that skip already-active items and validate requirements before submission.
- Policy-aware duration choices plus clear approval, justification, ticket, and active-until details.
- Local activity history and optional request-status notifications.
- Guided Access Setup that opens only the Microsoft portal pages needed to refresh access.
- Session-only token storage and local storage for settings, learned names, and cached display data.
- Dark mode, configurable tabs, import/export, and background cache refresh.

QuickPIM++ does not require a dedicated app registration, manual token entry, or a developer-controlled backend. It works with validated Microsoft portal tokens available in the signed-in browser session. Tokens and extension settings are not sold or sent to the developer.

Full functionality requires a Microsoft Entra tenant with Privileged Identity Management and an account that is eligible for at least one supported role or PIM group.

## Privacy Disclosure

QuickPIM++ handles authentication tokens, PIM assignment metadata, request identifiers, settings, aliases, favorites, justifications, bundles, activity history, and cached display names only to provide its extension functionality. Tokens use browser session storage. Other bounded convenience data uses local extension storage. Data is sent only to Microsoft Graph, Azure Management, and the public GitHub API as described in the privacy policy. No data is sold or sent to a developer-controlled server.

## Certification Notes

QuickPIM++ requires a Microsoft Entra tenant with Privileged Identity Management enabled for full activation testing.

Basic UI review:

1. Install the extension.
2. Open the popup and Settings page.
3. Verify Access Setup, aliases, justifications, bundles, preferences, import/export, activity history, and dark mode.

Full activation review:

1. Sign in to the Microsoft Entra admin center with an account eligible for PIM.
2. Open Settings > Access Setup.
3. Select Open missing portal pages and allow the Microsoft PIM pages to finish loading.
4. Return to the popup.
5. Select an eligible role or group, choose an allowed duration and justification, and submit the activation.

QuickPIM++ stores tokens and settings in the local browser profile and does not send them to developer-controlled servers.

## Assets

- Store icon: `assets/icon-300.png` (300 x 300)
- Screenshot 1: `assets/screenshot-01-popup-roles-1280x800.png` (1280 x 800) - browse eligible roles in the popup
- Screenshot 2: `assets/screenshot-02-popup-activation-1280x800.png` (1280 x 800) - policy-aware activation review
- Screenshot 3: `assets/screenshot-03-popup-bundles-1280x800.png` (1280 x 800) - repeatable bundle activation
- Screenshot 4: `assets/screenshot-04-popup-active-1280x800.png` (1280 x 800) - active PIM countdown and early disable
- Screenshot 5: `assets/screenshot-05-settings-appearance-1280x800.png` (1280 x 800) - popup and appearance preferences
- Small promotional tile: `assets/small-promo-440x280.png` (440 x 280)
- Large promotional tile: `assets/large-promo-1400x560.png` (1400 x 560)
