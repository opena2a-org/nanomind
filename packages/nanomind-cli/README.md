# @nanomind/cli

NanoMind interactive CLI: routes plain-language requests to HackMyAgent, secretless-ai, and OpenA2A commands. Requests are matched against fixed patterns. No model is involved.

## Install

```bash
npm install @nanomind/cli
```

## Usage

```bash
npx nanomind             # start the interactive session
npx nanomind --no-guard  # start it without screening piped or file input (not recommended)
npx nanomind --help      # describe the session and the requests it acts on
npx nanomind --version   # print the version
```

### Interactive Session

```
nanomind > scan this project

  > Run security scan
  > Running: hackmyagent secure .
```

The command is printed before it runs, and its output follows. Scan, fix, status and help requests run `hackmyagent`, which must be on `PATH`:

```bash
npm install -g hackmyagent
```

Trust level requests look the agent up in the OpenA2A registry. Set `OPENA2A_REGISTRY_URL` to use a different registry. Type `exit` or press Ctrl+C to leave the session.

### Inside a CLI tool

When integrated into a CLI tool, NanoMind launches when the tool is run with no arguments:

```bash
hma          # launches NanoMind interactive mode
hma --help   # traditional help (NanoMind never intercepts --help)
hma secure   # runs scan directly (NanoMind doesn't intercept commands)
```

## Features

- Pattern-based request routing: scan, fix, status, help, trust level and build attestation requests
- Prompt injection detection on piped and file input: a critical match blocks the line, and a high or medium match prints a warning or notice before the line is routed (`nanomind --no-guard`, or a session started with `noGuard: true`, skips it and prints a warning)
- 9 CI/CD artifact generators
- Session context (follow-up questions)
- Skill level adaptation

## License

Apache-2.0
