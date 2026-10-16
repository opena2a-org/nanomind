# Contributing

## Testing

The package test scripts need Node.js 22.6.0 or later, the first release with `--experimental-strip-types`; `engines` in the root `package.json` declares this minimum.

```bash
# The docs prose check, the tests in test/, then each workspace's test script
npm test

# The tests in test/ only
npm run test:root

# One workspace's tests, by package name
npm test --workspace=@nanomind/guard
```

The Python analyst in `packages/nanomind-analyst/` is not an npm workspace, so `npm test` does not run its tests. They are in `packages/nanomind-analyst/tests/`, and the `pyproject.toml` there configures pytest.
