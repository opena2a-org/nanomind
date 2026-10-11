# @nanomind/router CHANGELOG

## Unreleased

- `mapToCommand` looks intents up in a per-CLI table. `COMMAND_TABLES`
  holds the routes for `hma`, `secretless-ai` and `opena2a`, each to a
  command the matching adapter's `getCommandManifest()` lists; a caller
  can pass its own table as the third argument, and any other CLI gets
  the previous routes. `secretless-ai` SECRETS_EXPOSE now runs
  `secretless-ai diagnose`, SCAN runs `secretless-ai scan` and STATUS
  runs `secretless-ai verify`, where all three used to run
  `secretless-ai secure`, which does not exist. `hma` SCAN runs
  `hma detect .` when the input says "detect" and `hma check <name>`
  when it names `package: <name>`. `opena2a` SECRETS_EXPOSE runs
  `opena2a secretless`, SCAN runs `opena2a scan` or `opena2a detect`,
  and STATUS runs `opena2a review`. FIX has no route on `secretless-ai`
  or `opena2a`, so it maps to `null` there.
- "check for exposed secrets" and "find credentials" classify as
  SECRETS_EXPOSE. The pattern is tried before SCAN, which also matches
  "check", and accepts plural nouns and the verb before the noun.
  "detect" classifies as SCAN.

## 0.1.3 — 2026-04-28

Restore source-of-truth parity with the npm registry. No code or API changes between 0.1.1 and 0.1.3.

`@nanomind/router@0.1.2` was a manual `npm publish` from 2026-03-26 that predated the org's Trusted Publishing-only mandate (effective 2026-04-21). It carries no SLSA attestations, no `router-v*` git tag, and no committed source bump. It has been deprecated on npm with a pointer to 0.1.1 or 0.1.3+. 0.1.2 itself is permanent (npm versions are immutable; the unpublish window is 72 hours and has long expired).

0.1.3 republishes the same source as 0.1.1 via Trusted Publishing so consumers can pin a `dist-tag.latest` that has SLSA v1 provenance. Verify with:

```
npm view @nanomind/router@0.1.3 dist.attestations --json
```

## 0.1.1

Initial published release.
