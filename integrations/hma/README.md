# @nanomind/hma-adapter

NanoMind adapter for [HackMyAgent](https://www.npmjs.com/package/hackmyagent).

When `hma` is invoked with no arguments, this adapter launches NanoMind's interactive mode: natural-language routing into `hma secure`, `hma detect` and `hma check`. The routes are the `hma` table in [`@nanomind/router`](https://github.com/opena2a-org/nanomind/blob/main/packages/nanomind-router/README.md#general-intents-and-routes).

## Install

```bash
npm install @nanomind/hma-adapter
```

Normally consumed transitively by `hackmyagent`. Direct install is only needed when wiring a custom launcher.

## Usage

```ts
import { launchHmaInteractive } from "@nanomind/hma-adapter";

await launchHmaInteractive(process.argv.slice(2));
```

## Requires

- `@nanomind/cli` (peer).
- A running NanoMind runtime (either inline or via `@nanomind/daemon`).

## License

MIT. Part of the [OpenA2A](https://github.com/opena2a-org/nanomind) ecosystem.
