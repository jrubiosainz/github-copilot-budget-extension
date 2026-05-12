# Project Context

- **Owner:** Jorge
- **Project:** github-copilot-budget-extension
- **Stack:** Node.js (ESM), @github/copilot-sdk
- **Source extension:** `C:\Users\jrubiosainz\.copilot\extensions\squad-budget\extension.mjs` (~62KB single file)
- **Install target:** `~/.copilot/extensions/squad-budget/extension.mjs`
- **Created:** 2026-05-12

## Learnings

### 2026-05-12 — Initial packaging
- **Copied extension**: 60KB `extension.mjs` from `~/.copilot/extensions/squad-budget/` to `src/` using PowerShell Copy-Item (byte-for-byte fidelity for large files).
- **package.json**: Set `type: "module"` and `engines.node: ">=20"` (the extension uses top-level await and ESM imports). Used wildcard `"*"` for `@github/copilot-sdk` dependency to match any version the CLI provides.
- **Install scripts**: Cross-platform Node.js scripts (`install.mjs` / `uninstall.mjs`) + shell wrappers (`.ps1` / `.sh`) for convenience. Node scripts resolve `~/.copilot/extensions/squad-budget/` using `os.homedir()` and copy `src/extension.mjs` in place. Tested on Windows — works correctly.
- **package.json files array**: Listed `src/`, `scripts/`, `README.md`, `LICENSE` to control what ships via npm.
- **License**: MIT, copyright 2026 Jorge Rubio Sainz.
- **Lessons**: 
  - PowerShell Copy-Item is safer than view+create for large binary-like files (avoids encoding issues).
  - The Copilot extensions contract is simple: `~/.copilot/extensions/{name}/extension.mjs` — no compilation, no bundling.
  - Node >=20 is required because the extension uses modern ESM features.

### 2026-05-12 — v0.1.0 gap fix: Node version validation
- **Issue**: Install scripts didn't validate Node version. Users with Node <20 got cryptic errors later.
- **Fix**: Added Node version checks to all six scripts:
  - `install.mjs` & `uninstall.mjs`: Parse `process.versions.node`, exit with friendly message if major <20.
  - `install.ps1` & `uninstall.ps1`: Check `node` command exists, extract major version, error with upgrade link if <20.
  - `install.sh` & `uninstall.sh`: Use `command -v node`, parse `node --version` with sed/cut, exit if major <20.
- **Tested**: `node scripts/install.mjs` runs successfully on Node 22.
- **Status**: Ready for v0.1.0 release.

### 2026-05-12T14:30:00Z — v0.1.0 shipped

Package structure (src/, scripts/, metadata) plus Node 20+ validation delivered and approved. All scripts ready for cross-platform installation. Version bumps and CI/CD deferred to v0.2.0+. Ready for publication.
