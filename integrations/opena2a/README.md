# @nanomind/opena2a-adapter

NanoMind adapter for the [opena2a](https://www.npmjs.com/package/opena2a-cli) umbrella CLI — the cross-product interactive router.

Users can ask natural-language questions about HackMyAgent, AIM, Secretless, OASB, and ATC from a single prompt. The adapter classifies intent and hands off to the appropriate subcommand.

## Install

```bash
npm install @nanomind/opena2a-adapter
```

Normally consumed transitively by `opena2a-cli` — direct install is only needed when embedding the router in a custom surface.

## Usage

```ts
import { launchOpena2aInteractive } from "@nanomind/opena2a-adapter";

await launchOpena2aInteractive(process.argv.slice(2));
```

## Requires

- `@nanomind/cli` (peer).
- A running NanoMind runtime (either inline or via `@nanomind/daemon`).

## License

MIT. Part of the [OpenA2A](https://github.com/opena2a-org/nanomind) ecosystem.
