# CLI Mode

How NanoMind routes a line typed into a CLI session to a command, and how it screens input that does not come from a terminal. The calls and the intent table are in the [README](../README.md#cli-mode).

## Intent routing

NanoMind replaces the help screen when a CLI tool is run with no arguments. It classifies natural language into one of 22 intent types or `UNKNOWN` and maps the intent to a command through a per-CLI routing table in `@nanomind/router`. The tables for `hma`, `secretless-ai` and `opena2a` are listed in the [router README](../packages/nanomind-router/README.md#general-intents-and-routes); an intent with no route there maps to no command, and the session says that CLI has no command for it.

## Prompt Injection Guard

Input that does not come from a terminal is screened before routing. Piped stdin is screened as `piped` and a file redirected to stdin as `file`. Agent output reaches a session the same way, through a pipe or a file. A caller that passes agent output to `screenInput` directly labels it `agent-output`. Output from the commands a session runs is printed and never routed.

## Session context

A session keeps the findings the last command printed, read from lines of the form `[CRED-001] title (severity)`, and the agent the last trust answer named. A later line that says "the first one", "that finding" or "my agent" is read with that id in place of the words, and the session prints the line as it read it before routing it. An id is taken only as far as it is made of the characters a command argument may contain, and the output itself is never routed. Lines are handled one at a time, in order, so a follow-up refers to the output of the line before it even when several lines arrive together from a pipe or a file.
