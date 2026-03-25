# @nanomind/cli

NanoMind interactive CLI — AI-powered security assistant for HackMyAgent, secretless-ai, and OpenA2A tools.

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

hma > why is my agent level 2
  Your agent is trust level 2 because:
    Missing: Build attestation (+80 pts)
    Fix: Add opena2a/build-action to your CI

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
