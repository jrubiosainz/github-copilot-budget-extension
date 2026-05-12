# Project Context

- **Owner:** Jorge
- **Project:** github-copilot-budget-extension
- **What the extension does:** Premium-request budget guard for Copilot CLI Squad sessions. Activates only in Squad workspaces (`.squad/` or `.github/agents/squad.agent.md` present). Spawns a local HTTP dashboard at http://127.0.0.1:51953/ where the user sets a max premium-request budget. Streams live consumption per Squad agent via SSE. When the budget is hit, further tool calls are denied (kills autopilot loops).
- **Stack:** Node.js (ESM), @github/copilot-sdk extension API
- **Created:** 2026-05-12

## Learnings

### 2026-05-12 · README.md complete

**What was done:**
- Wrote full README.md from the provided template structure
- Lead with what the extension does (budget guard), why it matters (stops runaway autopilot), how to use it (install + set budget)
- Included ASCII dashboard sketch to make the UI concrete before a user downloads
- Organized install instructions by platform (one-liner, PowerShell, bash) with copy-paste examples
- Added troubleshooting table for the three most likely user pain points (not in Squad workspace, port conflict, Node version)
- Explained internal mechanics (joinSession() hook, SSE for live updates, session.abort() for autopilot kill)
- Kept all voice calm, technical, no marketing fluff

**Key decisions:**
- Used "squad-budget" (lowercase) for consistency with source extension name
- Put the dashboard sketch early (before requirements) to immediately show what the user gets
- Emphasized that local-inference requests don't count (core value prop for long sessions)
- Noted that budget is soft-enforced (tool calls in-flight complete before abort takes effect)—this prevents confusion
- Single-file emphasis ("Single extension file") to emphasize simplicity and hackability

### 2026-05-12T14:30:00Z — v0.1.0 shipped

README.md (118 lines) approved as publication-ready. Documentation includes complete install instructions, feature explanation, dashboard ASCII sketch, usage walkthrough, troubleshooting table, and license. Decisions merged to decisions.md. Ready for publication.
