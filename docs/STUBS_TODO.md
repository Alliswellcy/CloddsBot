# Stub Audit TODO (Clodds vs Clawdbot)

This list tracks stubbed or missing functionality that should be implemented
to remove all placeholders and reach Clawdbot parity.

## Explicit placeholders in Clodds

- [x] Image processing used a placeholder implementation (Sharp integration).
- [x] Config save stamped a hard-coded version instead of package version.
- [x] Windows disk space check was not implemented.
- [x] Orderbook support for non-Polymarket feeds (Kalshi implemented; synthetic fallback for others).

## Parity gaps vs Clawdbot (missing modules/features)

### Apps / Nodes / UI
- [ ] macOS app + menu bar control plane.
- [ ] iOS/Android nodes (camera, screen record, Voice Wake/Talk Mode).
- [ ] Canvas host/A2UI integration.
- [ ] Full web UI (`ui/` in Clawdbot) and richer Control UI.

### Channels
- [ ] BlueBubbles / Zalo / Zalo Personal extensions.
- [ ] Production-grade WhatsApp/Slack/Signal/iMessage/Teams/Matrix adapters (Clawdbot-level parity, testing, and docs).
- [ ] Mattermost adapter (extension parity).
- [ ] Nextcloud Talk adapter (extension parity).
- [ ] Nostr adapter (extension parity).
- [ ] Tlon adapter (extension parity).
- [ ] Twitch adapter (extension parity).
- [ ] Voice-call adapter (extension parity).
- [x] WhatsApp reactions + polls (Baileys actions + agent tools).
- [x] WhatsApp group JID normalization + reply metadata.
- [x] WhatsApp message key fidelity for reactions/edits/deletes (cache + participant support).
- [x] WhatsApp outbound reply/quote support (thread.replyToMessageId).
- [x] WhatsApp multi-account runtime + QR login CLI (selectable default account).
- [x] WhatsApp inbound updates (edit/delete/reaction) -> cache + logs.
- [x] WhatsApp per-account policies (dmPolicy/allowFrom/groups).
- [x] Monitoring alerts support accountId routing.

### Gateway runtime
- [ ] Multi-agent routing + per-channel agent bindings (Clawdbot session routing model).
- [ ] Presence/typing indicators and advanced streaming/chunking controls.
- [ ] Session scopes + queue modes (Clawdbot session model).

### Ops / auth
- [ ] Onboarding wizard parity + daemon installer.
- [ ] OAuth model auth profiles + rotation (Anthropic/OpenAI OAuth).
- [ ] Remote gateway exposure (Tailscale Serve/Funnel parity).

### Tooling
- [ ] Canvas + node tools wired to companion apps.
- [ ] Full browser control parity (profiles, snapshots, uploads).

### Extensions / Providers / Observability
- [ ] OpenTelemetry diagnostics extension parity (diagnostics-otel).
- [ ] Copilot proxy auth integration (copilot-proxy).
- [ ] Google auth helpers (google-antigravity-auth, google-gemini-cli-auth).
- [ ] Qwen portal auth integration (qwen-portal-auth).
- [ ] Memory backends (memory-core + memory-lancedb parity).
- [ ] LLM task runner extension (llm-task).
- [ ] Open Prose extension parity (open-prose).
- [ ] Lobster extension parity (lobster).

---

This file is the target list for systematically removing stubs and closing
parity gaps. Check items off as they are implemented.
