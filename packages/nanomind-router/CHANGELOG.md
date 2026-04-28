# @nanomind/router CHANGELOG

## 0.1.3 — 2026-04-28

Restore source-of-truth parity with the npm registry. No code or API changes between 0.1.1 and 0.1.3.

`@nanomind/router@0.1.2` was a manual `npm publish` from 2026-03-26 that predated the org's Trusted Publishing-only mandate (effective 2026-04-21). It carries no SLSA attestations, no `router-v*` git tag, and no committed source bump. It has been deprecated on npm with a pointer to 0.1.1 or 0.1.3+. 0.1.2 itself is permanent (npm versions are immutable; the unpublish window is 72 hours and has long expired).

0.1.3 republishes the same source as 0.1.1 via Trusted Publishing so consumers can pin a `dist-tag.latest` that has SLSA v1 provenance. Verify with:

```
npm view @nanomind/router@0.1.3 dist.attestations --json
```

## 0.1.1

Initial published release.
