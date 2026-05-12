# Project Context

- **Owner:** Jorge
- **Project:** github-copilot-budget-extension — packaging the squad-budget Copilot CLI extension for public release
- **Stack:** Node.js (ESM), @github/copilot-sdk extension API, single-file extension.mjs (~62KB)
- **Source extension:** `C:\Users\jrubiosainz\.copilot\extensions\squad-budget\extension.mjs`
- **Created:** 2026-05-12

## Learnings

### 2026-05-12T07:19:21Z: v0.1.0 scope decision
- **Decided:** Keep `.squad/` in public repo. Dogfoods the extension's own activation rule and demonstrates Squad project structure to users.
- **Decided:** MIT license. Standard, permissive, no-ceremony.
- **Decided:** No CI/CD, npm publish, or CONTRIBUTING.md in v0.1.0. Ship the working extension with clear install path first.
- **Principle confirmed:** The README is the product. Install scripts + clear feature description > automation ceremony.
- **Layout:** Single-file extension source in `src/`, dual-platform install/uninstall scripts in `scripts/`, minimal metadata in `package.json`. No build step needed (extension is already ESM).
## 2026-05-12T14:30:00Z — v0.1.0 Final Review

**Task:** Lead review of v0.1.0 packaging before publication.

**Review scope:**
- README.md install instructions vs. actual script behavior
- package.json repository placeholders
- LICENSE year/copyright
- Absolute path leakage in committed files
- .gitignore exclusions

**Findings:**
- ✅ All critical items passed verification
- ✅ No blocking issues detected
- ✅ Install/uninstall scripts match documentation
- ✅ LICENSE correct (2026, Jorge Rubio Sainz, MIT)
- ✅ No hardcoded absolute paths in shipped files
- ✅ .gitignore properly configured (doesn't ignore src/, scripts/, LICENSE)
- ✅ TESTING.md comprehensive

**Verdict:** APPROVED

**Deliverable:** .squad/decisions/inbox/ripley-v010-review.md

**Recommendation:** Ship v0.1.0. Suggested non-blocking polish: CHANGELOG.md, CI/CD workflow, demo GIF.

## 2026-05-12T14:30:00Z — v0.1.0 shipped

Package approved and ready for publication. All team deliverables complete: scope, packaging, README, testing, Node validation, final review. Decisions merged to decisions.md. Proceeding to publication (git init + commit handled separately by coordinator).
