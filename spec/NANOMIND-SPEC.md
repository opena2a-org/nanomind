# NanoMind Specification v2.0

**Status:** Draft
**License:** Apache-2.0
**Companion to:** OpenA2A ATC Architecture, Federated Intelligence Brief

---

## 1. Overview

NanoMind is an open protocol for embedding intelligence into CLI security tools and runtime protection systems. Any tool can implement the NanoMind adapter interfaces to gain:

- **CLI Mode:** Natural language intent routing, 22 intent types, cross-product command mapping
- **Runtime Mode:** Behavioral anomaly detection by statistical scoring in the calling process, federated learning

## 2. CLI Adapter Contract

```typescript
interface NanoMindCLIAdapter {
  cliName: string;
  cliVersion: string;
  getCommandManifest(): CommandManifest;
  executeCommand(cmd: string): Promise<ExecutionResult>;
  getScanHistory(): ScanHistoryEntry[];
  getCheckRegistry?(): CheckEntry[];
  getATCData?(): ATCData;
}
```

### 2.1 Intent Taxonomy

| ID | Tier | Description |
|----|------|-------------|
| SCAN | local-fast | Run security scan |
| FIX | local-fast | Auto-fix findings |
| EXPLAIN | local-full | Explain a finding |
| GENERATE | local-full | Generate CI/CD artifact |
| COMPARE | local-fast | Compare scans |
| STATUS | local-fast | Show status |
| CONFIG | local-fast | Configure settings |
| HELP | local-fast | Show help |
| SECRETS_EXPOSE | local-fast | Check for exposed secrets |
| NAVIGATE | local-fast | Open dashboard |
| TRUST_QUERY | local-fast | Query trust level |
| ATC_STATUS | local-fast | Explain trust level |
| RISK_SCORE | local-fast | Show risk breakdown |
| REVOCATION | local-fast | Check revocation status |
| EXPOSURE | local-fast | Show exposure ceiling |
| ATTEST | local-full | Generate build attestation |
| SCAN_SKILL_INTENT | not specified | Classify a skill's intent as malicious, benign or edge case |
| SCAN_SOUL_COMPLETENESS | not specified | Analyze SOUL.md governance completeness |
| SCAN_MCP_SCOPE | not specified | Analyze MCP tool description scope |
| SCAN_PROMPT_INTENT | not specified | Analyze a system prompt's behavioral envelope |
| SCAN_VERSION_DELTA | not specified | Semantic diff between skill versions |
| SCAN_EXPLAIN | not specified | Explain a scan finding |

`classifyIntent()` returns one of the intents above, or `UNKNOWN` when no pattern matches the input. The six `SCAN_*` intents are the security scanning intents `isScanIntent()` reports. The router documents them as invoked programmatically by HMA during scanning rather than typed by an interactive CLI user. No tier is specified for them: the router assigns no tier to an intent, and the daemon's infer response has no tier field.

## 3. Runtime Adapter Contract

```typescript
interface NanoMindRuntimeAdapter {
  agentId: string;
  agentCategory: string;
  subscribeToBehavioralEvents(
    handler: (event: BehavioralEvent) => void
  ): Unsubscribe;
  getATCContentHash(): string;
  onAnomalyDetected(
    handler: (score: number, action: ARPAction) => void
  ): Unsubscribe;
  isOfflineMode(): boolean;
}
```

### 3.1 Behavioral Event Schema

```typescript
interface BehavioralEvent {
  agentId: string;
  sessionId: string;
  sequenceNum: number;
  eventType: 'TOOL_CALL' | 'CAPABILITY_CHECK' | 'MCP_CALL' |
             'MEMORY_READ' | 'MEMORY_WRITE' | 'EXTERNAL_CALL';
  capability: string;
  toolName: string | null;
  argHash: string;
  timestampDelta: number;
  wallClock: number;
  responseSize: number;
  responseCode: number;
  l0Decision: 'allow' | 'block' | 'alert';
}
```

### 3.2 Anomaly Response Tiers

| Score | Action | Description |
|-------|--------|-------------|
| 0.0–0.2 | allow | Normal behavior |
| 0.2–0.4 | alert | Unusual pattern logged |
| 0.4–0.6 | throttle | Rate limited |
| 0.6–0.8 | suspend | Agent paused |
| 0.8–1.0 | kill | Agent terminated |

## 4. Federated Learning Protocol

### 4.1 Gradient Submission

Endpoints submit anonymized gradients to `POST /api/v1/telemetry/behavioral-gradient`:

```json
{
  "agentCategory": "financial",
  "gradientVector": [0.01, -0.02, ...],
  "localLoss": 0.023,
  "eventCount": 300,
  "privacyEpsilon": 1.0,
  "modelVersion": "1.0.0",
  "timestamp": "2026-10-22T08:00:00.000Z"
}
```

### 4.2 Privacy Requirements

- Gradient clipping: L2 norm ≤ 1.0
- Gaussian noise: σ = sensitivity × √(2ln(1.25/δ)) / ε
- Default: ε = 1.0, δ = 1e-5
- Server rejects submissions with ε > 2.0

### 4.3 Raw Data Guarantee

Raw behavioral events NEVER leave the endpoint. Differential privacy (§4.2) covers one field of a submission, `gradientVector`. The other fields are sent exact. The table gives each field `RuntimeTwin` (`@nanomind/runtime-core`) sends and what a reader of one submission learns from it.

| Field | Sent | What a reader of one submission learns |
|-------|------|----------------------------------------|
| `agentCategory` | exact | The category the twin was configured with, `general` when none was set |
| `gradientVector` | clipped and noised (§4.2) | The round's nine behavioral features after the clipping and noise of §4.2 |
| `localLoss` | exact | The mean anomaly score (§3.2) of the round's events, and with `eventCount` the sum of their scores. A value above 0 shows that at least one event in the round scored above 0 |
| `eventCount` | exact | The number of events in the round. The twin sends a round when it holds 300 events and sends the rest when `shutdown()` is called, so a count below 300 marks a round that `shutdown()` sent |
| `privacyEpsilon` | exact | The ε of the noise on `gradientVector`, a constant 1.0 in the twin |
| `modelVersion` | exact | A constant, `1.0.0` in the twin |
| `timestamp` | exact | When the round was sent, to the millisecond: when its last event was processed, or when `shutdown()` was called |

## 5. Guard Protocol

Input that does not come from a terminal is screened for injection before routing. Its source is the one `detectInputSource()` reports for stdin: `piped` for a pipe or socket, `file` for a file redirected to stdin. Agent output reaches a session through one of these and is screened as such. A caller that passes agent output to `screenInput` directly labels it `agent-output`. Output from the commands a session runs is printed and never routed, so it is not screened.

The guard screens for:

- Instruction override patterns
- Role switching patterns
- Permission escalation patterns
- Encoded payload patterns
- Zero-width character injection

Detected critical injections are blocked. Guard cannot be disabled via config. A launcher disables it for one session only when the user passes the `--no-guard` flag, by starting the session with `noGuard: true`; the session prints a visible warning to stderr.

## 6. Conformance

A tool is NANOMIND_COMPATIBLE if it:
1. Implements either CLIAdapter or RuntimeAdapter (or both)
2. Passes the conformance test suite (`@nanomind/conform`)
3. Guard is active on all non-direct input (CLI mode)
4. Differential privacy is applied to all gradient submissions (Runtime mode)
5. Raw behavioral data never leaves the endpoint (Runtime mode)
