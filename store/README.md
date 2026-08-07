# Browser Store Materials

This folder is the tracked source of truth for Chrome Web Store and Microsoft Edge Add-ons listing metadata and reusable listing images.

- `listing.en-US.md` contains the approved English listing copy, links, category, privacy disclosures, and certification instructions.
- `assets/` contains the store icon, screenshots, and promotional tiles at the dimensions accepted by both stores.
- Run `npm run assets:stores` after intentionally replacing a source screenshot or brand image.
- Run `npm run build && npm run package:stores` to generate both upload packages in `release/`.

Generated upload packages are ignored by Git because tagged release workflows rebuild and verify them from source.
