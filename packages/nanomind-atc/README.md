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
// "Your agent billing-agent is trust level 2 because:
//   Missing: Build attestation (+80 pts supply chain)
//     Fix: Add opena2a/build-action to your CI pipeline.
//   Present: HMA scan passed (+160 pts vulnerability surface)
//   Projected level 3 after fixes: 743 pts"
```

## License

MIT
