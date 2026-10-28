# Disable Extensions by moving them aside, not through native switches

Claude Code only has a native per-item off switch for Plugins (`enabledPlugins`) and project MCP servers (`disabledMcpjsonServers`). Skills, Subagents, Commands, Output styles, Hooks, Status lines and user/local MCP servers have none. To keep "Disable" reversible for every category, cc-inventory moves the item out of where Claude Code looks — a sibling `*-disabled/` folder for file-based items, or `~/.claude/cc-inventory/disabled.json` for entries removed from `settings.json` / via `claude mcp remove` — and moves it back on Enable.

We picked this over hard-deleting (not reversible) and over a `disableAllHooks`-style global switch (too coarse). The `skills-disabled/` folder matches a convention the first user already had.

## Consequences

- Items disabled this way are invisible to Claude Code and to other tools; only cc-inventory knows how to bring them back. Deleting `~/.claude/cc-inventory/disabled.json` loses disabled Hooks and MCP configs (backups remain in `backups/`).
- Re-enabling a user MCP server re-adds it with `claude mcp add-json`; OAuth tokens may not survive the round trip.
- If Claude Code adds native off switches later, switch the affected categories over and migrate stored entries.
