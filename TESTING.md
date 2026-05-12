# Testing Guide

This document outlines the complete pre-release validation checklist, edge case coverage, and manual verification procedures for the squad-budget extension.

---

## Pre-Release Smoke Test

Run this checklist **before tagging a release**. Each step must pass on both Windows and Unix-like systems.

### 1. Clean Install on Windows

Delete any existing installation:
```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.copilot\extensions\squad-budget" -ErrorAction SilentlyContinue
```

Run the installer:
```powershell
.\scripts\install.ps1
```

**Expected:** Success message. File exists at `~/.copilot/extensions/squad-budget/extension.mjs`.

Verify:
```powershell
Test-Path "$env:USERPROFILE\.copilot\extensions\squad-budget\extension.mjs"
```

### 2. Clean Install on Unix

Delete any existing installation:
```bash
rm -rf "$HOME/.copilot/extensions/squad-budget"
```

Run the installer:
```bash
./scripts/install.sh
```

**Expected:** Success message. File exists at `~/.copilot/extensions/squad-budget/extension.mjs`.

Verify:
```bash
ls -lh "$HOME/.copilot/extensions/squad-budget/extension.mjs"
```

### 3. Re-Install (Overwrite Test)

Without deleting the existing installation, run the installer again (Windows or Unix):

```powershell
.\scripts\install.ps1
```

**Expected:** Output reports "updated" or "already installed". No errors. The extension still works.

### 4. Uninstall Test

Run the uninstall script:

**Windows:**
```powershell
.\scripts\uninstall.ps1
```

**Unix:**
```bash
./scripts/uninstall.sh
```

**Expected:** Directory `~/.copilot/extensions/squad-budget/` is removed completely. Success message displayed.

Verify removal:
```bash
# Should return false/not found
ls "$HOME/.copilot/extensions/squad-budget" 2>&1
```

### 5. Activation Test

**Setup:** Change directory into a Squad workspace (one that contains `.squad/` directory).

Start GitHub Copilot CLI in this directory. The extension should:

1. Detect the Squad workspace
2. Bind HTTP server to `http://127.0.0.1:51953/`
3. Automatically open the dashboard in your default browser

**Verify the dashboard is responding:**

```bash
curl -s http://127.0.0.1:51953/ | head -20
```

**Expected:** HTML page with dashboard UI (should contain "squad-budget" or "Budget Dashboard").

### 6. Inactivation Test

**Setup:** Change directory to a **non-Squad** directory (one that does NOT contain `.squad/` or `.github/agents/squad.agent.md`).

Start GitHub Copilot CLI in this directory.

**Expected:** 
- NO browser window opens
- NO server binds to port 51953
- No errors in Copilot CLI output

**Verify port 51953 is NOT bound:**

```bash
curl http://127.0.0.1:51953/
# Should fail with "Connection refused" or "Failed to connect"
```

### 7. Budget Enforcement Test

**Setup:** In a Squad workspace with the dashboard active:

1. In the browser dashboard, set budget to **1** (one premium request).
2. In Copilot CLI, trigger a tool call (e.g., ask Copilot to read a file: `@terminal what's in package.json?`).
3. After the first response, trigger a second tool call.

**Expected:**
- First tool call succeeds
- Second tool call is **denied** (blocked)
- Dashboard displays "Budget Exhausted" or similar warning
- Session aborts (autopilot stops if active)
- No infinite retry loops

---

## Edge Cases to Verify

| Scenario | Expected Behavior |
|----------|-------------------|
| **Path with spaces** (e.g., `C:\Users\Jane Doe\proj`) | Install succeeds; paths are properly quoted in scripts |
| **`squad-budget/` already exists with old version** | Overwrites cleanly without prompting user; no backup created |
| **`~/.copilot/extensions/` doesn't exist yet** | Installer creates it automatically; no manual mkdir required |
| **Port 51953 already in use** | Extension logs a warning; continues **without** dashboard (graceful degradation); does NOT crash the session |
| **Node version < 20** | Install script exits immediately with friendly error: "Node.js 20+ required" |
| **Repo cloned but `npm install` not run** | `node scripts/install.mjs` still works (installer has zero runtime dependencies) |
| **`.squad/` exists but is empty** | Extension activates (presence of directory is sufficient trigger) |
| **User closes browser dashboard** | Extension continues running; opening `http://127.0.0.1:51953/` manually re-displays it |
| **Multiple Copilot CLI sessions in Squad workspace** | Only first session binds port 51953; subsequent sessions fail gracefully (log warning, no dashboard) |
| **Network/firewall blocks 127.0.0.1** | Extension logs error; continues without dashboard (does not block Copilot CLI from working) |

---

## Manual Verification Commands

Use these commands during testing to confirm the extension is working correctly.

### Verify Install Target Exists

**Unix/macOS:**
```bash
ls -lh "$HOME/.copilot/extensions/squad-budget/extension.mjs"
```

**Windows:**
```powershell
Test-Path "$env:USERPROFILE\.copilot\extensions\squad-budget\extension.mjs"
Get-Item "$env:USERPROFILE\.copilot\extensions\squad-budget\extension.mjs" | Select-Object FullName, Length, LastWriteTime
```

### Verify Dashboard Responds

**Unix/macOS:**
```bash
# Fetch homepage
curl -s http://127.0.0.1:51953/ | head -20

# Verify SSE stream is live (should keep connection open)
curl -N http://127.0.0.1:51953/events
```

**Windows:**
```powershell
# Fetch homepage
Invoke-WebRequest -Uri http://127.0.0.1:51953/ -UseBasicParsing | 
    Select-Object -ExpandProperty Content | 
    Select-Object -First 20

# Check if server is listening on port 51953
Test-NetConnection -ComputerName 127.0.0.1 -Port 51953
```

### Check for Port Conflicts

**Unix/macOS:**
```bash
lsof -i :51953
# Should show node process if extension is active
```

**Windows:**
```powershell
Get-NetTCPConnection -LocalPort 51953 -ErrorAction SilentlyContinue
# Should show LISTENING state if extension is active
```

### Verify Node Version

```bash
node --version
# Must be v20.0.0 or higher
```

---

## What Success Looks Like

When the extension is working correctly:

1. **Automatic Activation:** When you start Copilot CLI in a Squad workspace, the dashboard opens automatically in your default browser at `http://127.0.0.1:51953/`.

2. **Live Dashboard Updates:** The dashboard displays:
   - A form to set your premium request budget (initially empty)
   - After setting budget: a real-time table showing Squad agents (Coordinator + subagents)
   - Request counts per agent increment as the session progresses
   - A live event log showing tool calls, agent spawns, and budget consumption

3. **Budget Enforcement:** When your premium request count reaches the budget limit:
   - The dashboard displays a clear "Budget Exhausted" warning
   - Further tool calls are **denied** (you see permission errors)
   - Autopilot sessions **abort** cleanly (no infinite loops)
   - The session must be restarted (or `/clear` issued) to reset the budget

4. **No Dashboard in Non-Squad Workspaces:** When you start Copilot CLI outside a Squad workspace, the extension remains dormant—no browser opens, no server starts, no interference with normal Copilot CLI operation.

5. **Graceful Degradation:** If the dashboard server fails to start (port conflict, network issue), the Copilot CLI session continues working; only the visual dashboard is missing.

---

## Failure Mode Indicators

If you see these, the extension is NOT working correctly:

- ❌ Browser opens in non-Squad directories
- ❌ Server fails to start and crashes the entire Copilot CLI session
- ❌ Budget is ignored (unlimited requests allowed after limit set)
- ❌ Session enters infinite retry loop when budget exhausted
- ❌ Dashboard shows no data after multiple tool calls
- ❌ Install script fails on paths with spaces
- ❌ Uninstall leaves behind files

---

## Testing on Fresh Systems

To simulate a new user installation, test on a VM or container with:

- **Windows:** Fresh Windows 10/11 with Node.js 20+ installed
- **macOS:** Clean macOS 13+ with Node.js 20+ installed  
- **Linux:** Ubuntu 22.04+ or similar with Node.js 20+ installed

Confirm that:
1. `~/.copilot/extensions/` directory doesn't exist before first install
2. Install script creates it automatically
3. Extension activates on first Copilot CLI launch in a Squad workspace
4. No manual configuration or environment variables required

---

## Reporting Issues

If a smoke test fails:

1. Note the **exact command** that failed
2. Capture the **full error output** (not truncated)
3. Record your **environment**: OS version, Node version, shell type
4. Check if the failure is **reproducible** (re-run the step)
5. Document in `.squad/decisions/inbox/` with title pattern: `vasquez-{failure-slug}.md`

Example: If port 51953 conflicts cause session crashes (instead of graceful fallback), create:

`.squad/decisions/inbox/vasquez-port-conflict-handling.md`

With content:
```markdown
# Issue: Port 51953 Conflict Causes Session Crash

**Found during:** Pre-release smoke test step 5  
**Environment:** Windows 11, Node v20.10.0  

## Observed Behavior
When port 51953 is already bound (tested by running `python -m http.server 51953`), 
the extension throws an unhandled exception and crashes the entire Copilot CLI session.

## Expected Behavior  
Extension should log warning, skip dashboard server, allow session to continue.

## Recommendation  
Hicks: Wrap `server.listen()` in try-catch in `src/extension.mjs`.  
Catch `EADDRINUSE`, log to session.log(), set state.dashboardDisabled = true.
```
