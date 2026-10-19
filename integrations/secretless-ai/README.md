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

const interactive = await launchSecretlessInteractive(process.argv.slice(2));
if (!interactive) {
  // secretless-ai was given arguments: parse them as usual
}
```

`launchSecretlessInteractive` takes the arguments `secretless-ai` was run with. With none, it starts the session and resolves `true` once the prompt is shown; the session exits the process when the user types `exit`. When `secretless-ai` was given arguments, `--help` and `--no-smart` among them, it resolves `false` and starts nothing.

## Requires

- `@nanomind/cli` ^0.1.2, a peer dependency.

## License

Apache-2.0. Part of the [OpenA2A](https://github.com/opena2a-org/nanomind) ecosystem.
