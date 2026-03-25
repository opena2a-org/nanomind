"use strict";
/**
 * @nanomind/codegen — Artifact Generation
 *
 * Generates CI/CD configuration artifacts for security tooling.
 * 9 artifact types covering all major CI platforms + Docker + ATC.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateArtifact = generateArtifact;
exports.listArtifactTypes = listArtifactTypes;
exports.detectArtifactType = detectArtifactType;
const TEMPLATES = {
    'github-action': (ctx) => `name: Security Scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run HackMyAgent scan
        run: npx hackmyagent secure . --ci --format json > hma-report.json

      - name: Upload scan results
        uses: actions/upload-artifact@v4
        with:
          name: security-report
          path: hma-report.json

      - name: Issue ATC
        if: success()
        uses: opena2a-org/opena2a-registry/action@main
        with:
          api-key: \${{ secrets.OPENA2A_API_KEY }}
          package-name: ${ctx.projectName}
          package-type: ${ctx.projectType}
          version: \${{ github.ref_name }}
          publisher: ${ctx.publisher || 'your-org'}
`,
    'gitlab-ci': (ctx) => `security-scan:
  stage: test
  image: node:20
  script:
    - npx hackmyagent secure . --ci --format json > hma-report.json
  artifacts:
    reports:
      security: hma-report.json
    when: always
`,
    'azure-pipelines': (ctx) => `trigger:
  - main

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'

  - script: npx hackmyagent secure . --ci
    displayName: 'Security Scan'
`,
    'circleci': (ctx) => `version: 2.1
jobs:
  security:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run:
          name: Security Scan
          command: npx hackmyagent secure . --ci
workflows:
  main:
    jobs:
      - security
`,
    'docker-compose': (ctx) => `services:
  security-scan:
    image: node:20-slim
    working_dir: /app
    volumes:
      - .:/app:ro
    command: npx hackmyagent secure . --ci
    environment:
      - CI=true
`,
    'dockerfile': (ctx) => `# Security scanning stage
FROM node:20-slim AS security
WORKDIR /app
COPY . .
RUN npx hackmyagent secure . --ci

# Build stage
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build
`,
    'pre-commit': (_ctx) => `repos:
  - repo: local
    hooks:
      - id: hackmyagent
        name: HackMyAgent Security Scan
        entry: npx hackmyagent secure . --ci
        language: system
        pass_filenames: false
        always_run: true
`,
    'makefile': (ctx) => `.PHONY: security scan fix

security: scan

scan:
\tnpx hackmyagent secure . --ci

fix:
\tnpx hackmyagent secure . --fix

attest:
\tcurl -X POST https://api.oa2a.org/internal/atc/build-attestation \\
\t  -H "Authorization: Bearer \$\${OPENA2A_API_KEY}" \\
\t  -H "Content-Type: application/json" \\
\t  -d '{"packageName":"${ctx.projectName}","packageType":"${ctx.projectType}","version":"$(shell git describe --tags --always)","publisher":"${ctx.publisher || 'your-org'}","repoUrl":"$(shell git remote get-url origin)","commitSha":"$(shell git rev-parse HEAD)","builderId":"make","contentHash":"$(shell find . -type f -not -path './.git/*' | sort | xargs sha256sum | sha256sum | cut -d\\  -f1)"}'
`,
    'build-action': (ctx) => `# Add this step to your CI pipeline to issue an Agent Trust Credential
# on every successful build.

- uses: opena2a-org/opena2a-registry/action@main
  with:
    api-key: \${{ secrets.OPENA2A_API_KEY }}
    package-name: ${ctx.projectName}
    package-type: ${ctx.projectType}
    version: \${{ github.ref_name }}
    publisher: ${ctx.publisher || 'your-org'}
    registry-url: ${ctx.registryUrl || 'https://api.oa2a.org'}
`,
};
/**
 * Generate a CI/CD artifact.
 */
function generateArtifact(type, context) {
    const template = TEMPLATES[type];
    if (!template) {
        throw new Error(`Unknown artifact type: ${type}. Available: ${Object.keys(TEMPLATES).join(', ')}`);
    }
    return template(context);
}
/**
 * List all available artifact types.
 */
function listArtifactTypes() {
    return Object.keys(TEMPLATES);
}
/**
 * Detect the best artifact type for a project.
 */
function detectArtifactType(projectDir) {
    const fs = require('node:fs');
    const path = require('node:path');
    if (fs.existsSync(path.join(projectDir, '.github/workflows')))
        return 'github-action';
    if (fs.existsSync(path.join(projectDir, '.gitlab-ci.yml')))
        return 'gitlab-ci';
    if (fs.existsSync(path.join(projectDir, 'azure-pipelines.yml')))
        return 'azure-pipelines';
    if (fs.existsSync(path.join(projectDir, '.circleci')))
        return 'circleci';
    if (fs.existsSync(path.join(projectDir, 'docker-compose.yml')))
        return 'docker-compose';
    if (fs.existsSync(path.join(projectDir, 'Dockerfile')))
        return 'dockerfile';
    if (fs.existsSync(path.join(projectDir, 'Makefile')))
        return 'makefile';
    return 'github-action'; // default
}
