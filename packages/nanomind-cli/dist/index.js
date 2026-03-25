#!/usr/bin/env node
"use strict";
/**
 * @nanomind/cli — Unified NanoMind CLI Entry Point
 *
 * When invoked with no args, launches the interactive NanoMind prompt.
 * When invoked with --no-smart, falls through to the underlying CLI tool.
 *
 * This is the entry point that HMA, secretless-ai, and opena2a adapters
 * delegate to when the user runs their CLI with no arguments.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSession = startSession;
const readline = __importStar(require("node:readline"));
const router_1 = require("@nanomind/router");
const atc_1 = require("@nanomind/atc");
const guard_1 = require("@nanomind/guard");
const WELCOME = `
  NanoMind — AI Security Assistant
  Type a question or command. Examples:
    "scan this project"
    "why is my agent level 2"
    "fix the credential issue"
    "generate a github action for trust"
  Type "exit" or Ctrl+C to quit.
`;
/**
 * Start an interactive NanoMind session.
 */
async function startSession(session) {
    const atcHandler = new atc_1.ATCIntentHandler({ registryUrl: session.registryUrl });
    const inputSource = (0, guard_1.detectInputSource)();
    console.log(WELCOME);
    console.log(`  Connected to: ${session.cliName} v${session.cliVersion}\n`);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${session.cliName} > `,
    });
    rl.prompt();
    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }
        if (input === 'exit' || input === 'quit') {
            rl.close();
            return;
        }
        // Guard: screen piped input for injection
        if (inputSource !== 'direct') {
            const guardResult = (0, guard_1.screenInput)(input, inputSource);
            if (!guardResult.safe) {
                console.log(`\n  ${guardResult.recommendation}\n`);
                rl.prompt();
                return;
            }
        }
        try {
            await handleInput(input, session, atcHandler);
        }
        catch (err) {
            console.log(`\n  Error: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
        }
        rl.prompt();
    });
    rl.on('close', () => {
        console.log('\n  Goodbye.\n');
        process.exit(0);
    });
}
async function handleInput(input, session, atcHandler) {
    const classification = (0, router_1.classifyIntent)(input);
    // ATC intents — handle directly via ATCIntentHandler
    if ((0, router_1.isATCIntent)(classification.intent)) {
        await handleATCIntent(classification, atcHandler);
        return;
    }
    // Map to CLI command
    const mapping = (0, router_1.mapToCommand)(classification, session.cliName);
    if (!mapping) {
        console.log(`\n  I'm not sure how to help with that. Try "help" for examples.\n`);
        return;
    }
    console.log(`\n  > ${mapping.description}`);
    console.log(`  > Running: ${mapping.command} ${mapping.args.join(' ')}\n`);
    try {
        const output = await session.onCommand(mapping.command, mapping.args);
        if (output) {
            console.log(output);
        }
    }
    catch (err) {
        console.log(`  Command failed: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    }
}
async function handleATCIntent(classification, atcHandler) {
    const agentId = classification.entities.agentId || classification.entities.packageName || '';
    switch (classification.intent) {
        case 'TRUST_QUERY': {
            if (!agentId) {
                console.log('\n  Please specify an agent: "what is the trust level of <agent-id>"\n');
                return;
            }
            const summary = await atcHandler.getTrustLevel(agentId);
            if (!summary) {
                console.log(`\n  No ATC found for agent "${agentId}". The agent may not be registered yet.\n`);
                return;
            }
            console.log(`\n  Agent: ${summary.agentId}`);
            console.log(`  Trust Level: ${summary.trustLevel}`);
            console.log(`  Trust Score: ${summary.trustScore}`);
            console.log(`  Version: ${summary.version}`);
            console.log(`  Signatures: ${summary.signatureCount}`);
            console.log(`  Expires: ${summary.expiresAt}\n`);
            return;
        }
        case 'ATC_STATUS': {
            const explanation = await atcHandler.explainTrustLevel(agentId || 'current');
            console.log(`\n${explanation.summary}\n`);
            return;
        }
        case 'ATTEST': {
            console.log(`
  To add trust attestation to your CI pipeline, add this to your GitHub Actions workflow:

  - uses: opena2a-org/opena2a-registry/action@main
    with:
      api-key: \${{ secrets.OPENA2A_API_KEY }}
      package-name: your-package-name
      package-type: mcp_server
      version: \${{ github.ref_name }}
      publisher: your-org

  This issues an Agent Trust Credential (ATC) on every successful build.
`);
            return;
        }
        default:
            console.log(`\n  ATC intent "${classification.intent}" is not yet implemented.\n`);
    }
}
exports.default = startSession;
