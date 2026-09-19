# Browser Store Materials

This folder is the tracked source of truth for Chrome Web Store and Microsoft Edge Add-ons listing metadata and reusable listing images.

- `listing.en-US.md` contains the approved English listing copy, links, category, privacy disclosures, and detailed reviewer guidance.
- `certification-notes.txt` is the canonical text for Edge's Notes for certification field and the automated Edge publisher. Keep its test steps aligned with the submitted UI; append version-specific changes for a manual resubmission.
- `assets/` contains the shared Store icon, five popup-first screenshots, and promotional tiles at the dimensions accepted by both stores.
- `npm run assets:stores` launches the current unpacked `dist/` build with fictional data and regenerates every tracked listing image deterministically.
- Run `npm run build && npm run assets:stores` after UI changes that affect Store or README imagery.
- Run `npm run build && npm run package:stores` to generate the shared Chromium upload package in `release/`.

Generated upload packages are ignored by Git because tagged release workflows rebuild and verify them from source.
