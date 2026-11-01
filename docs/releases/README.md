# Release notes

Each GitHub release uses the reviewed Markdown file named after its tag, for example `v2.18.16.md`. The release title is `QuickPIM++ vX.Y.Z`.

Use the same structure for each release:

```markdown
Changes since [vPREVIOUS](https://github.com/RobinMJD/QuickPIM-PlusPlus/releases/tag/vPREVIOUS).

## Changelog

- Describe the concrete behavior added, changed, or fixed.

## Validation

- Include only checks actually completed for this release. Omit this section when historical evidence is unavailable.

## Links

[Compare changes](https://github.com/RobinMJD/QuickPIM-PlusPlus/compare/vPREVIOUS...vCURRENT)
```

Keep changes concise and useful to extension users. Use level-three topic or version headings when a release covers several areas or unpublished application versions. Preserve historical entries, attribution, and license details. Use actual Markdown newlines, never literal `\n` sequences. Do not equate a Store submission with public availability.

Add the new notes file in the version-bump commit. Release verification requires the tagged file; GitHub publication reads that file instead of generating a comparison-only changelog. Existing release assets and tags remain immutable; correcting a release body is a metadata-only action and does not require rebuilding or republishing the extension.
