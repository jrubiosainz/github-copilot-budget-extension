# Project Context

- **Owner:** Jorge
- **Project:** github-copilot-budget-extension
- **Stack:** Node.js (ESM), @github/copilot-sdk
- **Install target:** `~/.copilot/extensions/squad-budget/extension.mjs`
- **Runtime details:** Extension binds HTTP server to 127.0.0.1:51953, opens a browser tab on activation, only activates when cwd contains `.squad/` or `.github/agents/squad.agent.md`.
- **Windows note:** The cwd path here contains a space ("OneDrive - Microsoft") — install scripts must handle spaces.
- **Created:** 2026-05-12

## Learnings

### 2026-05-12: Created TESTING.md — Pre-Release Validation

**Task:** Authored comprehensive testing guide covering maintainer smoke tests, edge case table, and manual verification commands.

**Key Coverage Areas:**
- 7-step pre-release checklist (clean install, re-install, uninstall, activation, inactivation, budget enforcement)
- 10 edge cases including path-with-spaces, port conflicts, Node version checks, missing extensions dir
- Platform-specific verification commands (bash/PowerShell) for dashboard, port binding, file system
- "What Success Looks Like" section (plain language) describing dashboard auto-open, live updates, budget abort behavior
- "Failure Mode Indicators" to help maintainers spot regressions quickly

**Critical Test Cases Identified:**
1. **Budget enforcement must abort session** — denying tool calls alone isn't enough; infinite retry loops prove that autopilot needs explicit `session.abort()` when budget exhausted.
2. **Port conflict must NOT crash session** — if 51953 is bound, extension should log warning and continue WITHOUT dashboard (graceful degradation).
3. **Path with spaces** — Jorge's own cwd contains "OneDrive - Microsoft" — installer must quote paths correctly.
4. **Empty `.squad/` triggers activation** — presence of directory is sufficient; no files required inside.
5. **Node <20 should exit friendly** — installer should check version upfront with clear error message.

**Potential Installer Gaps Found:**
- Port conflict handling: If `server.listen()` throws `EADDRINUSE`, does installer/extension catch it? Risk: session crash instead of graceful fallback.
- Node version check: Does install script verify `node --version` >= 20 before copying files? Risk: cryptic runtime errors (e.g., top-level await) if user runs Node 18.
- Windows path quoting: Does `install.ps1` wrap `$env:USERPROFILE` in quotes? Risk: install fails for "Jane Doe" usernames.

**Decision Filed:** None yet — waiting to see Hicks's install scripts before filing inbox items. If scripts lack the checks above, will file decisions recommending additions.

**Testing Philosophy:**
- Skeptical stance: assume it's broken until proven working from scratch.
- Verify end-to-end: don't just check "file copied"; verify server binds, browser opens, budget aborts.
- Edge cases are NOT edge cases in the wild: paths with spaces, port conflicts, version mismatches happen constantly.
- Graceful degradation > hard failure

### 2026-05-12T14:30:00Z — v0.1.0 shipped

TESTING.md (comprehensive validation guide) approved as publication-ready. Three identified gaps (Node validation, path quoting, port conflict) addressed: first two implemented in v0.1.0, port conflict deferred to v0.2.0. Decisions merged to decisions.md. Package ready for publication.: if dashboard can't start, extension should log + continue, not blow up the session.
