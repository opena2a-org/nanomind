# @nanomind/hma-adapter

NanoMind adapter for [HackMyAgent](https://www.npmjs.com/package/hackmyagent).

When `hma` is invoked with no arguments, this adapter launches NanoMind's interactive mode: natural-language routing into `hma secure`, `hma detect`, `hma check` and `hma explain`. The routes are the `hma` table in [`@nanomind/router`](https://github.com/opena2a-org/nanomind/blob/main/packages/nanomind-router/README.md#general-intents-and-routes).

## Install

```bash
npm install @nanomind/hma-adapter
```

Normally consumed transitively by `hackmyagent`. Direct install is only needed when wiring a custom launcher.

## Usage

```ts
import { launchHmaInteractive } from "@nanomind/hma-adapter";

const interactive = await launchHmaInteractive(process.argv.slice(2));
if (!interactive) {
  // hma was given arguments: parse them as usual
}
```

`launchHmaInteractive` takes the arguments `hma` was run with. With none, it starts the session and resolves `true` once the prompt is shown; the session exits the process when the user types `exit`. With `--no-guard` and no other argument, it does the same with input screening off: the session prints a warning to stderr and does not screen piped or file input for prompt injection. When `hma` was given other arguments, `--help` and `--no-smart` among them, it resolves `false` and starts nothing, with or without `--no-guard`.

## Requires

- `@nanomind/cli` ^0.1.2, a peer dependency. `--no-guard` needs a `@nanomind/cli` release later than 0.1.2: 0.1.2 has no `noGuard` session option, so with 0.1.2 installed, `launchHmaInteractive(["--no-guard"])` starts a session that still screens piped and file input and prints no `--no-guard` warning.

## License

Apache-2.0. Part of the [OpenA2A](https://github.com/opena2a-org/nanomind) ecosystem.
