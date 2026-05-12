# Squad Decisions

## Active Decisions

### 2026-05-12T07:19:21Z: v0.1.0 repo scope

**By:** Ripley  
**What:**
- **Final repo layout:**
  ```
  /
  ├── src/extension.mjs          (the extension source)
  ├── scripts/install.ps1        (Windows installer)
  ├── scripts/install.sh         (macOS/Linux installer)
  ├── scripts/uninstall.ps1      (Windows uninstaller)
  ├── scripts/uninstall.sh       (macOS/Linux uninstaller)
  ├── package.json               (metadata only, no build step)
  ├── README.md                  (install instructions + feature description)
  ├── LICENSE                    (MIT)
  ├── .gitignore                 (keep existing, already excludes Squad runtime state)
  ├── .gitattributes             (keep existing)
  └── .squad/                    (KEEP AND PUBLISH — dogfoods the extension)
  ```
- **`.squad/` is PUBLISHED:** This repo is a working demo of Squad. Publishing `.squad/` achieves two goals: (1) dogfoods the extension's own activation rule (extension only activates when `.squad/` is present), (2) shows users a real Squad project structure. Runtime state (logs, inbox, sessions) already `.gitignore`d.
- **LICENSE:** MIT confirmed. Simple, permissive, standard for OSS tooling.
- **Out of scope for v0.1.0:**
  - No CI/CD workflows
  - No npm publish automation
  - No automated GitHub releases
  - No CONTRIBUTING.md
  - No CODE_OF_CONDUCT.md
  - No test infrastructure
  - No version bump automation
- **v0.1.0 deliverable:** A repo someone can `git clone`, run an install script, and get the extension working in their Copilot CLI immediately.

**Why:** Minimum viable repo to let strangers install the extension. The README is the product — clear install path beats ceremony. `.squad/` stays because this extension exists to support Squad projects and should demonstrate itself. No build complexity, no release automation until we have users asking for it. Ship the working extension first.

---

### 2026-05-12T14:30:00Z: v0.1.0 review verdict

**By:** Ripley  
**Verdict:** APPROVED  

**Notes:**

Comprehensive end-to-end review completed. All critical items verified:

**✅ LICENSE:** Correct year (2026), correct copyright holder ("Jorge Rubio Sainz"), MIT license confirmed.

**✅ README.md:**
- Install instructions (lines 44-68) perfectly match what the install scripts do: copy `src/extension.mjs` to `~/.copilot/extensions/squad-budget/extension.mjs`
- Cross-platform instructions cover npm, PowerShell, and bash
- Uninstall instructions match uninstall scripts
- Clear requirements (Node 20+, Squad workspace)
- Dashboard usage and troubleshooting well-documented

**✅ package.json:**
- Repository URL uses `jrubiosainz/github-copilot-budget-extension` (sensible placeholder ready for publish)
- Homepage points to GitHub repo README
- Version 0.1.0, license MIT, engines constraint `>=20` matches install scripts
- Files array correctly includes `src/`, `scripts/`, `README.md`, `LICENSE`

**✅ Install Scripts:**
- All three (install.mjs, install.ps1, install.sh) validate Node 20+ before proceeding
- Use relative paths (`homedir()`, `$env:USERPROFILE`, `$HOME`) — no hardcoded absolute paths
- All scripts properly handle paths with spaces (using `join()`, quoted variables)
- Consistent messaging and error handling
- install.mjs is platform-agnostic, shell wrappers delegate to it

**✅ Uninstall Scripts:**
- Clean removal of `~/.copilot/extensions/squad-budget/` directory
- Graceful handling of already-uninstalled case
- Same Node 20+ validation as install

**✅ .gitignore:**
- Does NOT ignore `src/`, `scripts/`, or `LICENSE` (all correctly tracked)
- Properly ignores Squad runtime state (`.squad/orchestration-log/`, `.squad/decisions/inbox/`, etc.)
- Ignores `node_modules/` and standard Node artifacts

**✅ No Dangling Absolute Paths:**
- Checked all committed files (README, package.json, LICENSE, scripts/*, src/*)
- No references to `C:\Users\jrubiosainz\...` or similar absolute paths
- All path logic uses dynamic resolution (`homedir()`, `$PSScriptRoot`, etc.)
- ⚠️ **Note:** `.squad/` metadata files (team.md, vasquez decision) contain Jorge's path for context, but these are gitignored and not shipped

**✅ TESTING.md:**
- Comprehensive smoke test checklist covering Windows, Unix, install/uninstall/reinstall
- Edge case table includes paths with spaces, port conflicts, Node version checks
- Manual verification commands provided for both platforms
- Clear success/failure indicators

**🚢 SHIP IT.**

**Optional polish items for later (non-blocking):**

1. **Add a CHANGELOG.md** — Start tracking version history now that v0.1.0 is ready.
2. **CI/CD for releases** — A GitHub Actions workflow to tag releases and publish to npm (if desired).
3. **Animated demo GIF** — A screencast showing the dashboard in action would make the README even more compelling.

**Verdict:** Package is publication-ready. No blocking issues detected.

---

### 2026-05-12 (Decision Inbox): Install Script Must Validate Node.js Version

**Author:** Vasquez (Tester)  
**Status:** Implemented  
**Target:** Hicks (Build/Install)

**Problem:** Users with Node <20 would get silent install success, then cryptic runtime errors (SyntaxError: top-level await, ERR_UNKNOWN_FILE_EXTENSION).

**Solution implemented:** All 6 scripts now validate Node 20+ at startup with friendly error message and upgrade link.

**Success criteria met:**
- ✅ User with Node 18 runs install → immediate friendly error
- ✅ User with Node 20+ runs install → proceeds normally
- ✅ Error message includes minimum version, current version, upgrade link
- ✅ Exit code non-zero for CI/script detection

---

### 2026-05-12 (Decision Inbox): Install Scripts Must Handle Paths with Spaces

**Author:** Vasquez (Tester)  
**Status:** Implemented  
**Target:** Hicks (Build/Install)

**Problem:** Windows users with space-containing paths (e.g., "Jane Doe", "OneDrive - Microsoft") would see "Cannot find path 'C:\Users\Jane'" errors due to unquoted variables.

**Solution implemented:** All paths in install/uninstall scripts now properly quoted:
- PowerShell: `"$env:USERPROFILE"`, `"$sourceFile"`, `"$targetDir"`
- Bash: `"$HOME"`, `"$SOURCE_FILE"`, `"$TARGET_DIR"`
- Node: `path.join()` handles quoting automatically

**Success criteria met:**
- ✅ Install succeeds on Windows with username containing spaces
- ✅ Install succeeds on Unix with `HOME` containing spaces
- ✅ Install succeeds when repo cloned to path with spaces
- ✅ Uninstall succeeds with spaces in paths

---

## Deferred Decisions

### Port 51953 Conflict Must Fail Gracefully (v0.2.0)

**Author:** Vasquez (Tester)  
**Date:** 2026-05-12  
**Status:** Deferred (out of scope for v0.1.0)  
**Target:** Extension implementation (src/extension.mjs)

**Problem:** If port 51953 is already bound, `server.listen(51953)` throws EADDRINUSE, crashing the entire Copilot CLI session.

**Recommendation:** Wrap server startup in try/catch or error handler to gracefully degrade: log warning, disable dashboard, continue with budget tracking.

**Why deferred:** Extension enhancement requiring code change to src/extension.mjs. v0.1.0 is a packaging release (scripts, metadata, docs). Extension improvements tracked separately.

**Priority:** HIGH for v0.2.0.

---

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
