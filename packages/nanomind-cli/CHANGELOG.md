# @nanomind/cli CHANGELOG

## Unreleased

- Generated templates call no internal registry route and name no registry
  credential. No template carries a build attestation step, and the artifact
  types are github-action, gitlab-ci, azure-pipelines, circleci,
  docker-compose, dockerfile, pre-commit and makefile. A request for a build
  action or a build attestation is answered that NanoMind generates no build
  attestation step, with the request that prints a scan config; step 7 of
  teach mode says the same and asks no question.
- `nanomind --help` says that a build attestation request is answered that
  NanoMind generates no build attestation step, where it said that the
  request prints a CI workflow step.
- The GitHub Actions workflow pins each action it uses by a full commit sha,
  and the first line of every generated template is a comment naming the
  project.
