# @nanomind/cli

NanoMind interactive CLI: AI-powered security assistant for HackMyAgent, secretless-ai, and OpenA2A tools.

## Install

```bash
npm install @nanomind/cli
```

## Usage

When integrated into a CLI tool, NanoMind launches when the tool is run with no arguments:

```bash
hma          # launches NanoMind interactive mode
hma --help   # traditional help (NanoMind never intercepts --help)
hma secure   # runs scan directly (NanoMind doesn't intercept commands)
```

### Interactive Session

```
hma > scan this project
  > Running: hma secure .

hma > why is agent billing-agent level 2

Your agent billing-agent is trust level 2 because:
  Present: HMA scan (+160 pts vulnerability surface)
  Missing: Build attestation (+80 pts supply chain)
    Fix: Add opena2a/build-action to your CI pipeline.
         Run: opena2a > "add OpenA2A to my pipeline"
  Missing: Publisher verified (+40 pts identity governance)
    Fix: Verify your publisher identity at registry.opena2a.org/auth/github
  Missing: Runtime behavioral data (+150 pts runtime behavior)
    Fix: Install ARP alongside your agent.
         Run: npm install @opena2a/arp
  Present: Threshold signatures (+70 pts cryptographic proof)
  Projected level 4 after fixes: 500 pts (230 present + 270 from fixes)

hma > generate a github action
  [generates workflow YAML]
```

## Features

- 16 intent types (scan, fix, explain, trust query, attestation, etc.)
- Prompt injection detection on piped input
- 9 CI/CD artifact generators
- Session context (follow-up questions)
- Skill level adaptation

## License

MIT
