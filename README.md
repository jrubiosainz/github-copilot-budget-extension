# squad-budget

> Premium-request budget guard for GitHub Copilot CLI Squad sessions.

Stop runaway autopilot loops from burning your premium requests. **squad-budget** is a lightweight extension that puts a live local dashboard in your browser, lets you set a max number of premium requests per session, shows you consumption broken down by Squad agent in real time, and kills autopilot when the budget is hit. Local-inference requests (on 127.0.0.1) are tracked separately and don't count against the budget.

## What you get

- A local dashboard at `http://127.0.0.1:51953/` that opens automatically when you start a Squad session.
- Set a max number of premium requests per session—no signup, no API keys, entirely local.
- See live per-agent consumption (Coordinator, Ripley, Hicks, and any other Squad members).
- When the budget is hit, autopilot aborts and further tool calls are denied.
- Local-inference (Foundry Local on 127.0.0.1) requests are tracked separately and **don't** count against the budget.

## Dashboard sketch

```
┌─────────────────────────────────────────────────────────┐
│  squad-budget Dashboard              [●] Live         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Max Premium Requests: [50]  [Set Budget]             │
│                                                         │
│  Consumption:                                           │
│  ┌─────────────────────────────────────────────────┐  │
│  │ Coordinator     ████████░░░░░░░░  18 / 50       │  │
│  │ Ripley          ████░░░░░░░░░░░░░   8 / 50      │  │
│  │ Hicks           ██░░░░░░░░░░░░░░░░  2 / 50      │  │
│  │ Local (free)    ████████████░░░░░░ 14 requests  │  │
│  └─────────────────────────────────────────────────┘  │
│                                                         │
│  Status: Running (28 / 50 premium used)               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Requirements

- **Node.js 20+**
- **GitHub Copilot CLI** installed and working
- A **Squad workspace** (a repo with `.squad/` folder or `.github/agents/squad.agent.md`)
  - The extension only activates in Squad workspaces; it's silent elsewhere.

## Install

### One-liner (any platform)

```bash
git clone https://github.com/jrubiosainz/github-copilot-budget-extension
cd github-copilot-budget-extension
npm run install:ext
```

### Windows (PowerShell)

```powershell
git clone https://github.com/jrubiosainz/github-copilot-budget-extension
cd github-copilot-budget-extension
.\scripts\install.ps1
```

### macOS / Linux

```bash
git clone https://github.com/jrubiosainz/github-copilot-budget-extension
cd github-copilot-budget-extension
./scripts/install.sh
```

**What the installer does:**
- Copies `src/extension.mjs` to `~/.copilot/extensions/squad-budget/extension.mjs`
- The Copilot CLI auto-discovers it on next start

## Use it

1. `cd` into a Squad workspace (one with `.squad/` or `.github/agents/squad.agent.md`).
2. Start a Copilot CLI session (e.g., `copilot task` or `copilot explore`).
3. The dashboard opens automatically at `http://127.0.0.1:51953/`.
4. Enter your max premium-request budget (e.g., `50`) and click **Set Budget**.
5. Work normally. Watch the chart fill up in real time. When the budget hits zero, the session aborts.

## Uninstall

```bash
npm run uninstall:ext
```

Or manually:

```powershell
# Windows
.\scripts\uninstall.ps1

# macOS / Linux
./scripts/uninstall.sh
```

## How it works

The extension hooks into the Copilot SDK `joinSession()` API to intercept every tool call. It counts premium-request calls and logs local-inference calls separately. A tiny HTTP server spawns on `127.0.0.1:51953` with Server-Sent Events (SSE) to push live consumption updates to the browser. Per-agent breakdown comes from parsing the task tool's `squad_member_id` metadata. When the budget is exhausted, the extension calls `session.abort()` **and** blocks further tool calls—the abort is what kills autopilot loops; denying tool calls alone wasn't enough to stop them.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard doesn't open | Ensure your repo has `.squad/` or `.github/agents/squad.agent.md`. The extension is silent if not in a Squad workspace. |
| Port 51953 already in use | Another squad-budget instance is running. Close the other Copilot CLI session. |
| Install script does nothing | Check `node -v` (must be ≥20). Re-run the install script. |
| Budget still consumed after abort | This is expected behavior—tool calls in-flight before the abort complete. Budget is soft-enforced; set it conservatively. |

## License

MIT — see [LICENSE](./LICENSE).

## Source

Single extension file: [`src/extension.mjs`](./src/extension.mjs). Read it, modify it, send PRs.
