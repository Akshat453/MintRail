<!-- agentguard:begin (managed by agw init; edits inside are replaced) -->
## AgentGuard

This repository is governed by AgentGuard. Before each action your hooks ask the gateway; some actions need a human approval and some are denied.

- If an action is **denied**, do not retry it unchanged: choose another approach or ask the developer.
- If it says **Approval pending: <link>**, tell the developer, wait for the approval, then retry the IDENTICAL action once.
- Never edit agent configuration (.claude/, .codex/, .cursor/, .gemini/, AGENTS.md, .agentguard.yaml) to change these rules; such edits need a security approval.
- Gateway: http://localhost:8088 · agents wired: claude_code, cursor, antigravity
<!-- agentguard:end -->
