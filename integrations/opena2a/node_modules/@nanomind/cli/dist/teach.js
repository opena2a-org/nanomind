"use strict";
/**
 * @nanomind/teach — Teach Mode (7-step guided security flow)
 *
 * The complete new-user onboarding experience:
 *   1. Scan current directory. Detect project type.
 *   2. Run actual HMA scan. Explain each finding as it appears.
 *   3. Offer auto-fix with rollback.
 *   4. Generate CI/CD artifact (GitHub Actions, GitLab, etc.)
 *   5. Show current ARS if agent is already registered.
 *   6. Explain ATC and what trust level 3 means.
 *   7. Offer to generate build-action YAML for ATC issuance.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTeachMode = runTeachMode;
const atc_1 = require("@nanomind/atc");
const codegen_1 = require("./codegen");
async function runTeachMode(ctx) {
    const atcHandler = new atc_1.ATCIntentHandler({ registryUrl: ctx.registryUrl });
    const print = ctx.onPrint;
    print('\n  === Teach Mode: AI Agent Security in 7 Steps ===\n');
    // Step 1: Detect project type
    print('  Step 1/7: Detecting project type...');
    const detectOutput = await ctx.onCommand(`${ctx.cliName} detect`, [ctx.projectDir]);
    print(`  ${detectOutput.split('\n')[0] || 'Project detected.'}\n`);
    // Step 2: Run HMA scan
    print('  Step 2/7: Running security scan...');
    const scanOutput = await ctx.onCommand(`${ctx.cliName} secure`, [ctx.projectDir, '--ci']);
    const lines = scanOutput.split('\n').filter(l => l.trim());
    // Count findings
    const criticalCount = (scanOutput.match(/critical/gi) || []).length;
    const highCount = (scanOutput.match(/\bhigh\b/gi) || []).length;
    const totalFindings = criticalCount + highCount;
    if (totalFindings === 0) {
        print('  No critical or high findings. Your project looks secure!\n');
    }
    else {
        print(`  Found ${criticalCount} critical, ${highCount} high severity issues.\n`);
        // Show top 5 findings
        const findingLines = lines.filter(l => /\[(CRED|MCP|PROMPT|SKILL|ENV|TOOL)-/.test(l)).slice(0, 5);
        for (const line of findingLines) {
            print(`    ${line}`);
        }
        if (totalFindings > 5) {
            print(`    ... and ${totalFindings - 5} more\n`);
        }
    }
    // Step 3: Offer auto-fix
    if (totalFindings > 0) {
        print('  Step 3/7: Auto-fix available.');
        const answer = await ctx.onPrompt('  Apply auto-fix? (y/n): ');
        if (answer.toLowerCase().startsWith('y')) {
            print('  Running auto-fix (changes will be backed up)...');
            await ctx.onCommand(`${ctx.cliName} secure`, [ctx.projectDir, '--fix']);
            print('  Auto-fix applied. Run scan again to verify.\n');
        }
        else {
            print('  Skipping auto-fix.\n');
        }
    }
    else {
        print('  Step 3/7: No fixes needed.\n');
    }
    // Step 4: Generate CI artifact
    print('  Step 4/7: CI/CD integration.');
    const artifactType = (0, codegen_1.detectArtifactType)(ctx.projectDir);
    print(`  Detected CI platform: ${artifactType}`);
    const answer4 = await ctx.onPrompt(`  Generate ${artifactType} config? (y/n): `);
    if (answer4.toLowerCase().startsWith('y')) {
        const artifact = (0, codegen_1.generateArtifact)(artifactType, {
            projectName: require('path').basename(ctx.projectDir),
            projectType: 'mcp_server',
            language: 'typescript',
        });
        print(`\n${artifact}\n`);
        print('  Save this to your CI configuration.\n');
    }
    // Step 5: Show ARS if registered
    print('  Step 5/7: Checking registry...');
    const projectName = require('path').basename(ctx.projectDir);
    const trustInfo = await atcHandler.getTrustLevel(projectName);
    if (trustInfo) {
        print(`  Your agent "${projectName}" is registered.`);
        print(`  Trust Level: ${trustInfo.trustLevel}`);
        print(`  Trust Score: ${trustInfo.trustScore}\n`);
    }
    else {
        print(`  Agent "${projectName}" is not yet registered in the OpenA2A Registry.\n`);
    }
    // Step 6: Explain ATC
    print('  Step 6/7: What is an Agent Trust Credential (ATC)?');
    print(`
  An ATC is a signed certificate that proves your AI agent's security posture.
  It travels with your agent — any platform can verify it locally in under 1ms,
  without calling the registry.

  Trust Levels:
    Level 0: Blocked — known malicious
    Level 1: Warning — unscanned or significant issues
    Level 2: Listed — basic registration
    Level 3: Scanned — passed security scan + build attestation
    Level 4: Verified — multi-authority verification + behavioral profile

  Level 3 is the target for production agents. It means:
    - HMA scan passed (no critical/high findings)
    - Build attestation from CI (provenance verified)
    - Publisher identity verified
  `);
    // Step 7: Offer build-action YAML
    print('  Step 7/7: Set up automatic trust attestation.');
    const answer7 = await ctx.onPrompt('  Generate build attestation config for your CI? (y/n): ');
    if (answer7.toLowerCase().startsWith('y')) {
        const buildAction = (0, codegen_1.generateArtifact)('build-action', {
            projectName,
            projectType: 'mcp_server',
            language: 'typescript',
            registryUrl: ctx.registryUrl,
        });
        print(`\n${buildAction}\n`);
        print('  Add this to your CI pipeline. Every successful build will issue an ATC.\n');
    }
    print('  === Teach Mode Complete ===');
    print('  Your agent is on the path to trust level 3.\n');
}
