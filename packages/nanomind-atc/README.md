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

## Not found and failed lookups

A 404 from the registry means it has no ATC for the agent: `getTrustLevel` returns null, and `explainTrustLevel` explains how to get started. When the registry answers with another error status or with a body that could not be read as JSON, or cannot be reached, both methods reject with an `ATCLookupError`, so a failed lookup is not read as an unregistered agent. Its message names the agent, the registry address and the reason. It also carries `agentId`, `registryUrl` and `status`, which is undefined when the registry was not reached.

```typescript
import { ATCIntentHandler, ATCLookupError } from '@nanomind/atc';

try {
  const trust = await new ATCIntentHandler().getTrustLevel('billing-agent');
  console.log(trust ? `Trust level ${trust.trustLevel}` : 'The registry has no ATC for billing-agent');
} catch (err) {
  if (!(err instanceof ATCLookupError)) throw err;
  console.log(err.message);
  // For a registry that answers 503:
  // Could not look up agent "billing-agent": the registry at https://api.oa2a.org answered with status 503.
}
```

## License

Apache-2.0
