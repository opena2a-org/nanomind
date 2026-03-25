# NanoMind Specification v2.0

**Status:** Draft
**License:** MIT
**Companion to:** OpenA2A ATC Architecture, Federated Intelligence Brief

---

## 1. Overview

NanoMind is an open protocol for embedding intelligence into CLI security tools and runtime protection systems. Any tool can implement the NanoMind adapter interfaces to gain:

- **CLI Mode:** Natural language intent routing, 16 intent types, cross-product command mapping
- **Runtime Mode:** Behavioral anomaly detection, sub-2ms inference, federated learning

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
  "eventCount": 10000,
  "privacyEpsilon": 1.0
}
```

### 4.2 Privacy Requirements

- Gradient clipping: L2 norm ≤ 1.0
- Gaussian noise: σ = sensitivity × √(2ln(1.25/δ)) / ε
- Default: ε = 1.0, δ = 1e-5
- Server rejects submissions with ε > 2.0

### 4.3 Raw Data Guarantee

Raw behavioral events NEVER leave the endpoint. Only differentially-private gradient updates are transmitted.

## 5. Guard Protocol

All non-direct input (piped, file, agent output) is screened for injection before routing:

- Instruction override patterns
- Role switching patterns
- Permission escalation patterns
- Encoded payload patterns
- Zero-width character injection

Detected critical injections are blocked. Guard cannot be disabled via config — only `--no-guard` flag (which displays a visible warning).

## 6. Conformance

A tool is NANOMIND_COMPATIBLE if it:
1. Implements either CLIAdapter or RuntimeAdapter (or both)
2. Passes the conformance test suite (`@nanomind/conform`)
3. Guard is active on all non-direct input (CLI mode)
4. Differential privacy is applied to all gradient submissions (Runtime mode)
5. Raw behavioral data never leaves the endpoint (Runtime mode)
