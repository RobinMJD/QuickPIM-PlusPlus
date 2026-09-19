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
- Optional browser-account sync for useful preferences, aliases, favorites, justifications, bundles, usage, and recent activity within Chrome or Edge.
- Guided Role Access recovery that opens only the Microsoft portal pages needed to refresh access.
- Session-only token storage, local-only access data, and bounded browser-account sync controls for non-token convenience data.
- Dark mode, configurable tabs, import/export, and background cache refresh.

QuickPIM++ does not require a dedicated app registration, manual token entry, or a developer-controlled backend. It works with validated Microsoft portal tokens available in the signed-in browser session. Tokens and extension settings are not sold or sent to the developer.

Getting started:

1. Use a work or school account in a Microsoft Entra tenant licensed for Privileged Identity Management (PIM). Your administrator must already have assigned the account eligible access to at least one supported role or PIM group. A personal Microsoft account or a permanent active assignment without eligibility is not sufficient for activation.
2. Sign in to https://entra.microsoft.com/ in the same browser profile as QuickPIM++. Confirm that your eligible assignment appears in the portal's PIM My roles page.
3. Open the extension popup, then Settings > Role Access > Open missing portal pages. Complete Microsoft sign-in, MFA, or tenant selection if requested. Return and select Recheck now if access has not refreshed automatically.
4. Reopen the popup, select Entra Roles and your eligible assignment, then Continue. Choose an offered Activation time and enter any required justification or ticket details. Select Activate 1 selected to submit a real Microsoft PIM activation request.
5. An approved activation displays active access and an expiry time. If the role requires approval, the request remains pending until its configured approver responds. Check Settings > Activity & Usage and the Microsoft PIM portal for its status.

PIM Groups and Azure Roles follow the same pattern but need their own eligible assignments. Without the corresponding access, a source may be empty or hidden; enabled sources are controlled in Settings > Popup & Appearance. Settings and appearance can be explored without tenant access, but the extension has no sample roles or built-in demo account. QuickPIM++ cannot create eligibility or bypass Microsoft licensing, MFA, approval, or role policies.

## Privacy Disclosure

QuickPIM++ handles authentication tokens, PIM assignment metadata, request identifiers, settings, aliases, favorites, justifications, bundles, activity history, and cached display names only to provide its extension functionality. Tokens use browser session storage. Other bounded convenience data uses local extension storage and, when Browser Sync is enabled, the signed-in browser account's extension sync service. Data is sent only to Microsoft Graph, Azure Management, the browser sync service, and the public GitHub API as described in the privacy policy. No data is sold or sent to a developer-controlled server.

## Certification Notes

Use the complete text in [certification-notes.txt](certification-notes.txt) for Partner Center's **Notes for certification** field. The automated Edge publisher reads this same file. The notes identify the primary purpose, required test account, exact UI steps, expected results, and missing-access behavior.

For a review of v2.18.13, also explain that the update fixes activation of the same Entra role at different scopes (for example directory and administrative unit) while preserving Microsoft's policy enforcement. The existing v2.18.13 package can be resubmitted with clearer metadata; the reviewer instructions do not require an extension version bump.

Reviewer reference:

- Test with an authorized non-production tenant/account. The account needs an existing eligible assignment and a [PIM license](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-getting-started) such as Microsoft Entra ID P2 or Microsoft Entra ID Governance. QuickPIM++ does not supply a shared test account or create tenant access.
- Use the submitted Edge package in Edge, rather than the Chrome Web Store edition. Pin it from the browser's Extensions menu and use the same browser profile for the Microsoft portal session.
- Settings > Role Access contains **Access status & recovery**. Recovery opens the needed Microsoft pages in a collapsed background tab group. **Continue Microsoft sign-in** indicates that the tester must complete the Microsoft prompt. **Recheck now** refreshes the access checks.
- **Activate 1 selected** sends a real PIM request. Use a meaningful justification such as `Microsoft Edge certification: verify temporary activation of the test account role.` Generic `test` or `testing` is intentionally rejected.
- Check **Settings > Activity & Usage > Requests > Check status** and the matching Microsoft PIM portal. Pending approval is expected for approval-protected assignments; it is not a completed activation.
- To test early deactivation where supported, select the active assignment, then **Continue > Disable 1 selected**. Microsoft may require the activation to remain active for five minutes first.
- PIM Groups and Azure Roles require their own eligible assignments. Tenant-free checks cover Settings, saved justifications, appearance, and backup controls; they do not validate PIM activation.
- Screenshots use fictional demonstration data. They do not represent credentials or a demo mode available in the submitted package.

## Assets

- Store icon: `assets/icon-300.png` (300 x 300)
- Screenshot 1: `assets/screenshot-01-popup-roles-1280x800.png` (1280 x 800) - browse eligible roles in the popup
- Screenshot 2: `assets/screenshot-02-popup-activation-1280x800.png` (1280 x 800) - policy-aware activation review
- Screenshot 3: `assets/screenshot-03-popup-bundles-1280x800.png` (1280 x 800) - repeatable bundle activation
- Screenshot 4: `assets/screenshot-04-popup-active-1280x800.png` (1280 x 800) - active PIM countdown and early disable
- Screenshot 5: `assets/screenshot-05-settings-appearance-1280x800.png` (1280 x 800) - popup and appearance preferences
- Small promotional tile: `assets/small-promo-440x280.png` (440 x 280)
- Large promotional tile: `assets/large-promo-1400x560.png` (1400 x 560)
