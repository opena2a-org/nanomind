# @nanomind/secretless-adapter

NanoMind adapter for [secretless-ai](https://www.npmjs.com/package/secretless-ai).

When `secretless-ai` is invoked with no arguments, this adapter launches NanoMind interactive mode. `SECRETS_EXPOSE` intent routes to `secretless-ai diagnose`, `SCAN` to `secretless-ai scan` and `STATUS` to `secretless-ai verify`. The routes are the `secretless-ai` table in [`@nanomind/router`](https://github.com/opena2a-org/nanomind/blob/main/packages/nanomind-router/README.md#general-intents-and-routes).

## Install

```bash
npm install @nanomind/secretless-adapter
```

Normally consumed transitively by `secretless-ai`. Direct install is only needed when wiring a custom launcher.

## Usage

```ts
import { launchSecretlessInteractive } from "@nanomind/secretless-adapter";

await launchSecretlessInteractive(process.argv.slice(2));
```

## Requires

- `@nanomind/cli` (peer).
- A running NanoMind runtime (either inline or via `@nanomind/daemon`).

## License

MIT. Part of the [OpenA2A](https://github.com/opena2a-org/nanomind) ecosystem.
