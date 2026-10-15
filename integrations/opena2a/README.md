# @nanomind/opena2a-adapter

NanoMind adapter for the [opena2a](https://www.npmjs.com/package/opena2a-cli) umbrella CLI, the cross-product interactive router.

From a single prompt, users reach HackMyAgent scans (`opena2a scan`), agent detection (`opena2a detect`), Secretless credential checks (`opena2a secretless`), a project review (`opena2a review`, also for requests to open the dashboard or report), the OpenA2A configuration (`opena2a config show`) and ATC trust queries and attestation (`opena2a trust`, `opena2a attest`). The routes are the `opena2a` table in [`@nanomind/router`](https://github.com/opena2a-org/nanomind/blob/main/packages/nanomind-router/README.md#general-intents-and-routes). AIM and OASB have no route yet.

## Install

```bash
npm install @nanomind/opena2a-adapter
```

Normally consumed transitively by `opena2a-cli`. Direct install is only needed when embedding the router in a custom surface.

## Usage

```ts
import { launchOpena2aInteractive } from "@nanomind/opena2a-adapter";

await launchOpena2aInteractive(process.argv.slice(2));
```

## Requires

- `@nanomind/cli` (peer).
- A running NanoMind runtime (either inline or via `@nanomind/daemon`).

## License

Apache-2.0. Part of the [OpenA2A](https://github.com/opena2a-org/nanomind) ecosystem.
