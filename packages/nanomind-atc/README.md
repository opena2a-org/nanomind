# @nanomind/atc

Agent Trust Credential intent handler. Queries the OpenA2A Registry for trust data and produces human-readable explanations.

## Install

```bash
npm install @nanomind/atc
```

## Usage

```typescript
import { ATCIntentHandler } from '@nanomind/atc';

const handler = new ATCIntentHandler();

// Get trust level
const trust = await handler.getTrustLevel('billing-agent');
// { trustLevel: 3, trustScore: 0.92, ... }

// Explain WHY (the key feature)
const explanation = await handler.explainTrustLevel('billing-agent');
console.log(explanation.summary);
// For an ATC at trust level 2 with a passed HMA scan and two signatures:
// Your agent billing-agent is trust level 2 because:
//   Present: HMA scan (+160 pts vulnerability surface)
//   Missing: Build attestation (+80 pts supply chain)
//     Fix: Add opena2a/build-action to your CI pipeline.
//          Run: opena2a > "add OpenA2A to my pipeline"
//   Missing: Publisher verified (+40 pts identity governance)
//     Fix: Verify your publisher identity at registry.opena2a.org/auth/github
//   Missing: Runtime behavioral data (+150 pts runtime behavior)
//     Fix: Install ARP alongside your agent.
//          Run: npm install @opena2a/arp
//   Present: Threshold signatures (+70 pts cryptographic proof)
//   Projected level 4 after fixes: 500 pts (230 present + 270 from fixes)
```

## License

Apache-2.0
