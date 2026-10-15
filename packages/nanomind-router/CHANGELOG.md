# @nanomind/router CHANGELOG

## Unreleased

- `hma` EXPLAIN runs `hma explain <id>` when the input names a finding
  ID, so "what does CRED-001 mean" runs `hma explain CRED-001`. EXPLAIN
  without a finding ID, and EXPLAIN on `secretless-ai` and `opena2a`,
  still maps to `null`. The `checkId` entity takes a finding ID with more
  than one prefix whole: "explain SKILL-SEMANTIC-007" gives
  `SKILL-SEMANTIC-007`, where it gave `SEMANTIC-007`.
- `mapToCommand` appends a package name or agent id from the input to the
  command's arguments only when it is a plain argument (`isPlainArgument`:
  ASCII letters, digits and `@ . : / + - _`, starting with a letter, digit
  or `@`). A route whose entity value fails that check is skipped, and the
  next route for the intent applies, or `null` when there is none: "check
  package: x;echo" and "check package: --fix" run `hma secure .` in `hma`
  instead of `hma check` with that text as an argument. The adapters in
  `integrations/` run the mapped command through a shell; the check keeps
  shell syntax from the input out of that command.
- `mapToCommand` looks intents up in a per-CLI table. `COMMAND_TABLES`
  holds the routes for `hma`, `secretless-ai` and `opena2a`, each to a
  command the matching adapter's `getCommandManifest()` lists; a caller
  can pass its own table as the third argument, and any other CLI gets
  the previous routes, plus SECRETS_EXPOSE, which had no route on any
  CLI and now runs `<cli> secure .` there and on `hma`. `secretless-ai`
  SECRETS_EXPOSE now runs
  `secretless-ai diagnose`, SCAN runs `secretless-ai scan` and STATUS
  runs `secretless-ai verify`, where SCAN and STATUS used to run
  `secretless-ai secure`, which does not exist, and SECRETS_EXPOSE had
  no route. `hma` SCAN runs
  `hma detect .` when the input says "detect" and `hma check <name>`
  when it names `package: <name>`. `opena2a` SECRETS_EXPOSE runs
  `opena2a secretless`, SCAN runs `opena2a scan` or `opena2a detect`,
  and STATUS runs `opena2a review`. FIX has no route on `secretless-ai`
  or `opena2a`, so it maps to `null` there.
- "check for exposed secrets" and "find credentials" classify as
  SECRETS_EXPOSE. The pattern is tried before SCAN, which also matches
  "check", and accepts plural nouns and the verb before the noun.
  "detect" classifies as SCAN.
- The `license` field in `package.json` reads `Apache-2.0`, the license in
  the repository's LICENSE file. Earlier releases declared `MIT`.
- The README lists the six scanning intents `isScanIntent` accepts
  (`SCAN_SKILL_INTENT`, `SCAN_SOUL_COMPLETENESS`, `SCAN_MCP_SCOPE`,
  `SCAN_PROMPT_INTENT`, `SCAN_VERSION_DELTA`, `SCAN_EXPLAIN`) and says
  `IntentType` names 22 intents plus `UNKNOWN`. It listed `SCAN_SKILL`,
  `SCAN_MCP`, `SCAN_SOUL`, `SCAN_CREDENTIAL`, `SCAN_CODE` and `COMPILE_AST`,
  which `IntentType` does not define, and a count of 17.

## 0.1.3 — 2026-04-28

Restore source-of-truth parity with the npm registry. The `dist/` files of 0.1.3 are identical to those of 0.1.2, and both add the following to 0.1.1:

- Six intents in `IntentType`: `SCAN_SKILL_INTENT`, `SCAN_SOUL_COMPLETENESS`, `SCAN_MCP_SCOPE`, `SCAN_PROMPT_INTENT`, `SCAN_VERSION_DELTA` and `SCAN_EXPLAIN`.
- `isScanIntent(intent)`, which returns `true` for those six intents.
- Six result types: `ScanSkillResult`, `ScanSoulResult`, `ScanMCPResult`, `ScanPromptResult`, `ScanVersionDeltaResult` and `ScanExplainResult`.
- `classifyIntent` tries a pattern for each of the six intents before any other pattern, so some input that 0.1.1 classified as another intent now returns one of them: "check mcp scope" was SCAN and is SCAN_MCP_SCOPE, "show the semantic diff" was COMPARE and is SCAN_VERSION_DELTA, and "explain finding 3" was EXPLAIN and is SCAN_EXPLAIN. `mapToCommand` returns `null` for all six, so "check mcp scope" no longer maps to `<cli> secure .`.

`@nanomind/router@0.1.2` was a manual `npm publish` from 2026-03-26 that predated the org's Trusted Publishing-only mandate (effective 2026-04-21). It carries no SLSA attestations, no `router-v*` git tag, and no committed source bump. It has been deprecated on npm with a pointer to 0.1.1 or 0.1.3+. 0.1.2 itself is permanent (npm versions are immutable; the unpublish window is 72 hours and has long expired).

0.1.3 publishes the same code as 0.1.2 via Trusted Publishing so consumers can pin a `dist-tag.latest` that has SLSA v1 provenance. Verify with:

```
npm view @nanomind/router@0.1.3 dist.attestations --json
```

## 0.1.1

Initial published release.
