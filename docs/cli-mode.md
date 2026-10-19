# CLI Mode

How NanoMind routes a line typed into a CLI session to a command, and how it screens input that does not come from a terminal. The calls and the intent table are in the [README](../README.md#cli-mode).

## Intent routing

NanoMind replaces the help screen when a CLI tool is run with no arguments. It classifies natural language into one of 22 intent types or `UNKNOWN` and maps the intent to a command through a per-CLI routing table in `@nanomind/router`. The tables for `hma`, `secretless-ai` and `opena2a` are listed in the [router README](../packages/nanomind-router/README.md#general-intents-and-routes); an intent with no route there maps to no command, and the session says that CLI has no command for it.

## Prompt Injection Guard

Input that does not come from a terminal is screened before routing. Piped stdin is screened as `piped` and a file redirected to stdin as `file`. Agent output reaches a session the same way, through a pipe or a file. A caller that passes agent output to `screenInput` directly labels it `agent-output`. Output from the commands a session runs is printed and never routed.
