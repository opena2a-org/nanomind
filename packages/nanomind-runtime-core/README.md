# @nanomind/runtime-core

RuntimeTwin: a statistical behavioral twin for ARP anomaly detection.

This package holds `RuntimeTwin`, the statistical behavioral scorer that sits between L0 rule-based classification and L2 LLM-assisted assessment in the three-tier ARP intelligence stack. It builds a baseline from the first 100 events it processes, or starts from one it reads from `~/.opena2a/arp/baseline-<agentId>.json` at construction. The baseline holds event-type counts, the capabilities seen, and the mean and standard deviation of the time between events, kept with Welford's online algorithm. It then scores each event by adding fixed weights for six factors (unknown capability, timing anomaly, rare event type, L0 escalation, burst, error spike), caps the sum at 1.0, and maps the score to one of five actions: `allow`, `alert`, `throttle`, `suspend` or `kill`.

`processEvent` returns an `AnomalyResult` (`score`, `action`, `reason`), with a score of 0 while the baseline is being built. `scoreARPEvent` scores an event without changing the baseline and returns an `AnomalyResult`, or `null` while the twin is disabled or its baseline holds fewer than 100 events. When the twin is enabled, `attach(engine)` registers an `onEvent` handler that schedules the scoring of each event with `setImmediate`, so the handler returns before the event is scored. With `fleetEnabled: true`, the twin also posts clipped, noised gradients for federated learning (see below). Only the boolean `true` turns this on: the strings `'true'` and `'false'` and the numbers `1` and `0` leave it off, so convert a value read from an environment variable to a boolean first.

## Three-tier ARP model

- **L0**: Rule-based classification (microseconds, every event)
- **L1**: RuntimeTwin (milliseconds, this package)
- **L2**: LLM-assisted assessment (seconds, budget-controlled)

## Status

- Published on npm as `@nanomind/runtime-core`.
- Version 0.1.0 on npm points `main` at `src/index.ts`, which Node does not load from `node_modules`. With that version, import `@nanomind/runtime-core/dist/index.js`.

## Why this package exists

`RuntimeTwin` is kept in its own package so an ARP integration can use it without depending on hackmyagent. The package has no dependencies outside the Node.js built-in modules, and it declares the event shape it reads (`ARPEventInput`) and the engine hook it attaches to (`EventEngineLike`) instead of importing them.

## Federated learning wire format

This twin produces 9-dimensional gradients that feed `/api/v1/telemetry/behavioral-gradient`. The current submission path uses the v1 wire format; `NANOMIND_FL_DESIGN.md` Section 3 deliberately supersedes it with the v2 format (signed, round-aware, client-identified). The v2 adoption is tracked separately; this package does not implement v2 yet.

## What does NOT belong here

- Any ARP integration wiring (EventEngine attach, proxy integration, telemetry forwarder): that belongs to the ARP integration that uses the twin.
- Any rule-based classifier: that is L0, not L1.
- Any classification-drift detection: that is `guard-anomaly`, which is not part of this package.

## License

Apache-2.0
