# @nanomind/router CHANGELOG

## Unreleased

- `classifyIntent` finds the words of a pattern that had `.*` between
  them (SCAN_SKILL_INTENT, SCAN_SOUL_COMPLETENESS, SCAN_MCP_SCOPE,
  ATC_STATUS, REVOCATION, ATTEST, SECRETS_EXPOSE, NAVIGATE and GENERATE)
  in order on one line, and gives the intent the pattern gave: the router
  test compares the two on 20,000 generated inputs. The pattern re-read
  the rest of the line from each place its first word matched, so an
  input repeating that word took time quadratic in its length. "show "
  repeated to 16 KB, 32 KB and 64 KB classified in 24 ms, 92 ms and
  385 ms, and classifies in 0.14 ms, 0.28 ms and 0.50 ms; 1 MiB of it,
  the daemon's request body limit, classifies in 7.8 ms.
- An agent id is taken from the input only where the input marks one:
  `agent:<id>` or `agent: <id>`, a quoted id after "agent"
  (`agent "<id>"`, `agent '<id>'`), or a DID after "agent"
  (`agent did:web:example.org`). "why is my agent level 2" gives no
  `agentId`, where it gave `level`, so its ATC_STATUS route runs
  `opena2a trust explain` where it ran `opena2a trust explain level`.
  "is this agent trusted" gives no `agentId`, where it gave `trusted`.
  An id after an unmarked "agent" is not taken either: "why is agent
  billing-agent level 2" gives no `agentId`, where it gave
  `billing-agent`, and "why is agent: billing-agent level 2" gives
  `billing-agent`. A quoted id is taken without its quotes, so
  `is agent "my-agent" trusted` runs `opena2a trust my-agent`, where the
  value kept its quotes, `isPlainArgument` refused it and TRUST_QUERY
  mapped to `null`.
- NAVIGATE has a pattern: "open", "show", "view" or "display" before
  "dashboard" or "report", tried after the SECRETS_EXPOSE patterns and
  before SCAN. "open the dashboard" and "show the report" give NAVIGATE
  where they gave UNKNOWN, and "show the scan report" gives NAVIGATE
  where it gave SCAN. An input that also matches the FIX or STATUS
  pattern skips NAVIGATE: "show the status report" and "show status
  dashboard" still give STATUS, so `hma` runs `hma secure --summary`,
  and "open the report and fix issues" still gives FIX, so `hma` runs
  `hma secure --fix`. `opena2a` NAVIGATE runs
  `opena2a review` and CONFIG runs `opena2a config show`; both mapped to
  `null` before. The `opena2a` adapter manifest lists `config`. `hma`
  and `secretless-ai` still map NAVIGATE and CONFIG to `null`.
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
- The package directory holds a LICENSE file with the Apache-2.0 text of
  the repository's LICENSE, so the npm tarball carries it. Before, the
  directory held no LICENSE file and `npm pack` left the license text out.
- The README lists the six scanning intents `isScanIntent` accepts
  (`SCAN_SKILL_INTENT`, `SCAN_SOUL_COMPLETENESS`, `SCAN_MCP_SCOPE`,
  `SCAN_PROMPT_INTENT`, `SCAN_VERSION_DELTA`, `SCAN_EXPLAIN`) and says
  `IntentType` names 22 intents plus `UNKNOWN`. It listed `SCAN_SKILL`,
  `SCAN_MCP`, `SCAN_SOUL`, `SCAN_CREDENTIAL`, `SCAN_CODE` and `COMPILE_AST`,
  which `IntentType` does not define, and a count of 17.
- The module comment at the top of `dist/index.js` and `dist/index.d.ts`
  says input is classified into one of 22 intent types or `UNKNOWN`, the
  values `IntentType` names. It said one of 16 intent types.
- The README sample of what `classifyIntent` returns shows the `rawInput`
  field, the trimmed input. It showed `intent`, `confidence` and `entities`
  only.

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
