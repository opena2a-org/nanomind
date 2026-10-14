# Contributing

## Testing

The package test scripts need Node.js 22.6.0 or later, the first release with `--experimental-strip-types`; `engines` in the root `package.json` declares this minimum.

```bash
# All tests (56 total)
npx tsx --test packages/nanomind-guard/src/guard.test.ts \
  packages/nanomind-router/src/router.test.ts \
  packages/nanomind-cli/src/cli.test.ts \
  packages/nanomind-runtime/src/runtime.test.ts \
  packages/nanomind-runtime/src/fleet.test.ts

# E2E: full runtime lifecycle including production gradient submission
npx tsx --test packages/nanomind-runtime/src/e2e.test.ts
```
