# How It Works

How `RuntimeTwin` from `@nanomind/runtime-core` scores the events of an agent in Runtime Mode. The calls are in the [README](../README.md#runtime-mode).

1. **Baseline learning**: First 100 events build a behavioral baseline using Welford's online algorithm
2. **6-factor anomaly scoring**: unknown capability, timing anomaly, burst detection, L0 escalation, rare event type, error spike
3. **5-tier response**: allow → alert → throttle → suspend → kill
4. **No LLM call**: Statistical scoring only, run synchronously by `processEvent`
