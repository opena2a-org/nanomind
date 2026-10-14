# Integration Adapters

| Tool | Adapter | What Happens |
|------|---------|-------------|
| HackMyAgent | `integrations/hma/` | `hma` with no args → NanoMind interactive |
| secretless-ai | `integrations/secretless-ai/` | `secretless-ai` with no args → NanoMind |
| OpenA2A CLI | `integrations/opena2a/` | Cross-product router |
| ARP | `integrations/arp/` | NanoMindL1 attaches to EventEngine |

`--no-smart` always restores raw CLI behavior. `--help` is never intercepted.

## Related

- [OpenA2A Registry](https://github.com/opena2a-org/opena2a-registry): issues ATCs, hosts fleet intelligence
- [HackMyAgent](https://github.com/opena2a-org/hackmyagent): security scanner with 310 static checks across 69 categories, 29 NanoMind semantic checks across 7 analyzers, 164 adversarial payloads, as of 2026-08-25 (hackmyagent 0.32.0; static counts: `npx hackmyagent check-metadata --json`)
- [Agent Threat Matrix](https://github.com/opena2a-org/agent-threat-matrix): 61 techniques, 40 attack classes, 9 tactics, as of 2026-08-25 (Matrix v1.1; live counts: `curl -s https://api.oa2a.org/api/v1/threat-matrix/stats`)
