# Glossary

**Extension**
Anything that extends Claude Code's behaviour and that cc-inventory lists: Skill, Subagent, Command, Hook, MCP server, Status line, Output style, Plugin.

**Plugin**
An Extension that is a container of other Extensions. Installed from a Marketplace. The Extensions inside it cannot be disabled or deleted one by one — only the whole Plugin.

**Marketplace**
A source that lists Plugins available to install (a git repo).

**Scope**
Where an Extension comes from: `user` (everywhere for this person), `project` (one project, shared via git), `local` (one project, this person only), `plugin` (inside a Plugin), `synced` (pushed from claude.ai, read-only), `builtin` (ships with Claude Code, read-only).

**Status**
- **Active** — Claude Code loads it.
- **Disabled** — turned off in a way that can be undone.
- **Ignored** — configured somewhere Claude Code never reads, so it never loads (e.g. `~/.claude/mcp.json`).

**Disable** / **Delete**
Disable turns an Extension off and can be undone. Delete removes it permanently, after a backup.

**Overlap**
Two or more Active Extensions whose jobs are similar enough that Claude may pick between them inconsistently.

**Explanation**
The six-part description of one Extension: what it is, what it does, how to use it, how it works, what it overlaps with, and what to watch out for.
