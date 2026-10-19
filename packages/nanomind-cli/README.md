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
npx nanomind teach       # run teach mode, a 7-step guided walkthrough
npx nanomind setup       # download the llamafile and the model that @nanomind/engine runs
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

Trust level requests look the agent up in the OpenA2A registry. Set `OPENA2A_REGISTRY_URL` to use a different registry. A 404 from the registry means it has no ATC for the agent, and the session says so. When the registry answers with another error status, cannot be reached, or does not finish its answer within 10 seconds, the session prints `Could not look up agent "<id>"` followed by the registry address and the reason, and the registry step of teach mode prints the same line. Type `exit` or press Ctrl+C to leave the session.

### Teach mode

Type `teach` in the session, or run `nanomind teach`, for a 7-step walkthrough: it detects and scans the project with `hackmyagent`, offers its auto-fix when the scan reports critical or high findings, looks the project up in the registry, and offers to generate CI configs. Each question takes the next line as its answer. The auto-fix, `hackmyagent secure . --fix`, runs only when you answer yes. NanoMind keeps no copy of the files it changes, so undoing the fix relies on `hackmyagent`.

### Setup

`nanomind setup` downloads the two files that `@nanomind/engine` runs to the paths the engine reads by default, so that the engine's first call has nothing to download. The interactive session uses neither file.

| File | Path | Size |
|------|------|------|
| llamafile 0.8.13 | `~/.nanomind/bin/llamafile` | 241,352,637 bytes |
| SmolLM2-135M, Q4_K_M | `~/.nanomind/models/SmolLM2-135M.Q4_K_M.gguf` | 101,016,128 bytes |

Each file comes from a pinned URL. The download goes to a new file beside its path, and that file is moved to the path only when its size and SHA-256 match the pinned ones; otherwise it is deleted, and setup prints why and exits with status 1. A setup interrupted during a download, by Ctrl+C for example, leaves that file behind. Its name holds the ID of the process that wrote it, and the next download to the same path deletes it unless a process other than the one downloading runs with that ID. A file already at its path is not downloaded again. Setup keeps it when its SHA-256 matches; when it does not, setup leaves it as it is, names it, and exits with status 1. Delete such a file and run `nanomind setup` again to download the pinned one.

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
- Teach mode: a 7-step guided walkthrough (`nanomind teach`, or `teach` in a session)
- Setup: `nanomind setup` downloads the files `@nanomind/engine` runs and checks their size and SHA-256
- 9 CI/CD artifact generators
- Session context: the findings the last command printed, read from lines of the form `[CRED-001] title (severity)`, and the agent the last trust answer named are kept, so "fix the first one" and "explain that finding" are read as naming that first finding and "my agent" as naming that agent; the session prints how it read the line
- Skill level adaptation: once three lines have been typed, the session infers beginner, intermediate or expert from them; the message for a line that matches no request pattern and the note after a command that printed findings are longer for a beginner, and an expert gets a shorter message and no note

## License

Apache-2.0
