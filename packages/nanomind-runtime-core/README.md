# @nanomind/runtime-core

RuntimeTwin: behavioral twin (LSTM) for ARP anomaly detection.

This package is the canonical home of the LSTM behavioral scorer that sits between L0 rule-based classification and L2 LLM-assisted assessment in the three-tier ARP intelligence stack. Each ARP event flows through the twin on a non-blocking path. The twin computes an anomaly score against a warm-up baseline, contributes to federated learning via differential-private gradient submissions, and hands a `BehavioralRiskScore` back to the coordinator.

## Three-tier ARP model

- **L0**: Rule-based classification (microseconds, every event)
- **L1**: RuntimeTwin (milliseconds, this package) and classification drift detection
- **L2**: LLM-assisted assessment (seconds, budget-controlled)

## Status

- Version 0.1.0, private workspace package.
- Consumers import the canonical `RuntimeTwin` class when the package is published.
- Pending publication, `hackmyagent/src/arp/intelligence/runtime-twin.ts` temporarily mirrors this source. Any change to scoring logic must be mirrored in both files until the publication cut-over (tracked as PR 1b in `todo/NANOMIND_V3_AUDIT.md` Section 8).

## Why this package exists

Section 9 item 1 of the v3 audit found two parallel behavioral-twin implementations: a statistical twin in `packages/nanomind-runtime/` and an LSTM twin in `hackmyagent/src/arp/intelligence/nanomind-l1.ts`. Abdel approved path (a) on 2026-04-11: retire the statistical twin, relocate the LSTM to this package. This package is the result.

## Federated learning wire format

This twin produces 9-dimensional gradients that feed `/api/v1/telemetry/behavioral-gradient`. The current submission path uses the v1 wire format; `NANOMIND_FL_DESIGN.md` Section 3 deliberately supersedes it with the v2 format (signed, round-aware, client-identified). The v2 adoption is tracked separately; this package does not implement v2 yet.

## What does NOT belong here

- Any ARP integration wiring (EventEngine attach, proxy integration, telemetry forwarder): lives in `hackmyagent/src/arp/`.
- Any rule-based classifier: that is L0, not L1.
- Any classification-drift detection: that is `guard-anomaly`, still in `hackmyagent/src/arp/intelligence/`.
