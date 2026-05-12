// squad-budget — Premium-request budget guard for Copilot CLI Squad sessions.
//
// What it does:
//   • Activates only when the current repo is a Squad workspace
//     (i.e. it has a `.squad/` folder OR `.github/agents/squad.agent.md`).
//   • Spins up a tiny HTTP dashboard on http://127.0.0.1:51953/.
//   • The browser asks the user to enter a max number of premium requests
//     for the current session.
//   • Once the limit is set, the dashboard streams (SSE) live consumption,
//     broken down per Squad agent (Coordinator + each subagent spawned
//     via the `task` tool whose prompt names a member from .squad/agents/).
//   • When the budget is hit, every further tool call is denied
//     (kills autopilot loops) and the user is notified in the dashboard.

import { joinSession } from "@github/copilot-sdk/extension";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = 51953;
const URL = `http://${HOST}:${PORT}/`;

// ---------------------------------------------------------------------------
// In-memory state (lost on /clear or session restart — by design).
// ---------------------------------------------------------------------------
const state = {
    active: false,           // true once a Squad workspace is detected
    cwd: null,
    knownAgents: [],         // names found under .squad/agents/
    maxRequests: null,       // user-defined ceiling
    totalRequests: 0,
    perAgent: {},            // { name: { requests, role } }
    // Local-inference channel: requests served by on-device models (Foundry Local
    // hitting 127.0.0.1). Tracked separately so they DO NOT count against the
    // premium-request budget (zero token cost) but are still visible in the
    // dashboard chart + table + event log so the user can see the savings.
    localRequests: 0,
    perLocalAgent: {},       // { name: { requests, role, model } }
    blocked: false,
    startedAt: null,
    limitSetAt: null,
    events: [],              // recent log lines surfaced in the dashboard
    voices: [],              // recent per-member statements parsed from task results
    platformReportedTotal: null, // filled at session.shutdown if available
};

const sseClients = new Set();
let httpServer = null;
let browserOpened = false;
// Assigned after joinSession() resolves. Hooks/bump() use this to call
// session.abort() and forcibly halt autopilot once the budget is exhausted —
// permissionDecision:"deny" alone does NOT stop the model from kicking off
// another turn, which is what caused the infinite-retry loop in past sessions.
let session = null;

function safeAbort(reason) {
    if (!session || typeof session.abort !== "function") return;
    // Fire-and-forget. abort() rejects when nothing is in flight; that's fine.
    Promise.resolve()
        .then(() => session.abort())
        .catch(() => { /* nothing to abort, ignore */ });
    try {
        if (typeof session.log === "function") {
            session.log(`squad-budget: abort() — ${reason}`, { level: "warning" });
        }
    } catch { /* logging is best-effort */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function detectSquad(cwd) {
    if (!cwd) return false;
    if (existsSync(join(cwd, ".squad"))) return true;
    if (existsSync(join(cwd, ".github", "agents", "squad.agent.md"))) return true;
    return false;
}

function loadKnownAgents(cwd) {
    const dir = join(cwd, ".squad", "agents");
    if (!existsSync(dir)) return [];
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
            .map((d) => d.name);
    } catch {
        return [];
    }
}

function snapshot() {
    return {
        active: state.active,
        cwd: state.cwd,
        knownAgents: state.knownAgents,
        maxRequests: state.maxRequests,
        totalRequests: state.totalRequests,
        perAgent: state.perAgent,
        localRequests: state.localRequests,
        perLocalAgent: state.perLocalAgent,
        blocked: state.blocked,
        startedAt: state.startedAt,
        limitSetAt: state.limitSetAt,
        platformReportedTotal: state.platformReportedTotal,
        events: state.events.slice(-50),
        voices: state.voices.slice(-50),
    };
}

function pushEvent(level, message) {
    state.events.push({ ts: Date.now(), level, message });
    if (state.events.length > 200) state.events.shift();
    pushUpdate();
}

function pushUpdate() {
    if (sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(payload);
        } catch {
            /* dead client; will be removed on close */
        }
    }
}

function bump(agent, role) {
    if (!state.perAgent[agent]) state.perAgent[agent] = { requests: 0, role: role || "" };
    if (role && !state.perAgent[agent].role) state.perAgent[agent].role = role;
    state.perAgent[agent].requests += 1;
    state.totalRequests += 1;
    // One log row per premium request so the user sees what's consuming their budget.
    state.events.push({
        ts: Date.now(),
        level: "request",
        type: "premium-request",
        agent,
        role: role || state.perAgent[agent].role || "",
        message: "premium request",
    });
    if (state.events.length > 200) state.events.shift();
    if (state.maxRequests && state.totalRequests >= state.maxRequests && !state.blocked) {
        state.blocked = true;
        pushEvent(
            "error",
            `Premium request budget exhausted: ${state.totalRequests}/${state.maxRequests}. Autopilot halted — session.abort() called.`,
        );
        // Hard-stop the in-flight assistant turn so it cannot start more tool
        // calls or be auto-resumed by the platform. This is what flips the
        // session from "autopilot" back to "normal mode" — the user has to
        // type a new prompt to do anything else.
        safeAbort(`budget exhausted (${state.totalRequests}/${state.maxRequests})`);
        return; // pushEvent already broadcast.
    }
    pushUpdate();
}

// Local-inference channel. Same shape as bump() but DOES NOT count against
// the premium-request budget and never triggers safeAbort(). This is how
// O'Brien (Foundry Local) shows up in the dashboard — the user sees a slice
// in the doughnut + a row in the breakdown table + a green event row, while
// the premium counter stays untouched (these calls cost zero tokens).
function bumpLocal(agent, role, model) {
    if (!state.perLocalAgent[agent]) state.perLocalAgent[agent] = { requests: 0, role: role || "", model: model || "" };
    if (role  && !state.perLocalAgent[agent].role)  state.perLocalAgent[agent].role  = role;
    if (model && !state.perLocalAgent[agent].model) state.perLocalAgent[agent].model = model;
    state.perLocalAgent[agent].requests += 1;
    state.localRequests += 1;
    state.events.push({
        ts: Date.now(),
        level: "local",
        type: "local-inference",
        agent,
        role: role || state.perLocalAgent[agent].role || "",
        model: model || state.perLocalAgent[agent].model || "",
        message: model ? `local inference · ${model}` : "local inference",
    });
    if (state.events.length > 200) state.events.shift();
    pushUpdate();
}

// Detect a Foundry-Local OpenAI-compatible chat-completion call inside a
// shell command. Returns { agent, model } if matched, else null.
//
// Recognises the canonical loopback endpoint Foundry Local serves on
// (always 127.0.0.1, port assigned at runtime) plus the /v1/chat/completions
// path. We deliberately ignore foundry CLI metadata commands (status, list,
// load, etc.) — those don't run inference, so they don't represent O'Brien
// "doing work" and shouldn't show up in the breakdown.
const FOUNDRY_ENDPOINT_RE = /127\.0\.0\.1:\d{4,5}\/v1\/chat\/completions/i;
const FOUNDRY_MODEL_RE    = /["']?model["']?\s*[:=]\s*["']([^"']{3,120})["']/i;

function detectLocalInference(toolName, toolArgs) {
    if (!toolArgs) return null;
    // Inspect the most likely string payloads regardless of the shell tool name.
    const candidates = [];
    if (typeof toolArgs.command === "string") candidates.push(toolArgs.command);
    if (typeof toolArgs.script  === "string") candidates.push(toolArgs.script);
    if (typeof toolArgs.input   === "string") candidates.push(toolArgs.input);
    if (Array.isArray(toolArgs.args)) candidates.push(toolArgs.args.join(" "));
    const blob = candidates.join("\n");
    if (!blob) return null;
    if (!FOUNDRY_ENDPOINT_RE.test(blob)) return null;
    const m = blob.match(FOUNDRY_MODEL_RE);
    return { agent: "obrien", model: m ? m[1] : "" };
}

// Squad spawn template starts every prompt with:
//   "You are {Name}, the {Role} on this project."
function parseAgentFromTaskPrompt(prompt) {
    if (typeof prompt !== "string") return null;
    const m = prompt.match(/^\s*You are\s+([A-Za-z@][\w'\-@]*)(?:,\s+the\s+([^.\n]+))?/m);
    if (!m) return null;
    return { name: m[1], role: (m[2] || "").trim() };
}

// Fallback attribution: scan the task tool's prompt/name/description for any
// known agent name (word-boundary, case-insensitive). Real-world Squad task
// calls rarely start with "You are X" — they're conversational ("Ask Picard
// to review...", or the agent_id is encoded in the `name` param like
// "picard-roundtable"). Without this, every dispatch was attributed to
// "Coordinator" and the per-agent breakdown stayed empty.
function findKnownAgentInTaskArgs(toolArgs, knownAgents) {
    if (!toolArgs || !Array.isArray(knownAgents) || knownAgents.length === 0) return null;
    const rawHaystack = [
        toolArgs.prompt,
        toolArgs.name,
        toolArgs.description,
        toolArgs.agent_type,
    ].filter((s) => typeof s === "string").join("\n");
    if (!rawHaystack) return null;
    // Strip apostrophes so "O'Brien" / "O\u2019Brien" match the on-disk
    // agent id "obrien". Without this, the word-boundary regex below sees
    // the apostrophe as a non-word char and never matches the dir name.
    const haystack = rawHaystack.replace(/['\u2019\u2018]/g, "");
    let firstHit = null;
    let firstIdx = Infinity;
    for (const a of knownAgents) {
        // Word-boundary match (handles capitalisation + plain mentions like
        // "Picard:", "@picard", "ask picard to..."). Also try the dashed-id
        // variant ("call-obrien", "obrien-review") via underscore/hyphen.
        const safe = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(^|[^A-Za-z0-9])${safe}([^A-Za-z0-9]|$)`, "i");
        const m = haystack.match(re);
        if (m && m.index < firstIdx) {
            firstHit = a;
            firstIdx = m.index;
        }
    }
    if (!firstHit) return null;
    // Title-case for display (state.knownAgents is lowercased from dir scan).
    const name = firstHit.charAt(0).toUpperCase() + firstHit.slice(1);
    return { name, role: "" };
}

// ---------------------------------------------------------------------------
// Voice extraction: a single Squad task call (e.g., a roundtable facilitated
// by the lead) may include several named members "speaking" within one text
// response. We surface those as trace-only voice events — they do NOT bump
// the premium-request counter (the platform billed only the parent task).
// ---------------------------------------------------------------------------
const VOICE_BUFFER_MAX = 200;
const VOICE_TEXT_MAX = 280;

function stripEmoji(s) {
    // Strip common emoji blocks + variation selectors. Keep ASCII + most letters.
    return s
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, "")
        .trim();
}

function normalizeHeader(raw) {
    return stripEmoji(raw)
        .replace(/\*\*/g, "")
        .replace(/__/g, "")
        .replace(/`/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Match a header that is JUST a member name, optionally followed by role
// in (parens) or after — / – / -. Rejects multi-word "title-y" headers.
const HEADER_NAME_RE = /^([A-Z][A-Za-z'\-]{1,30})(?:\s*(?:\(([^)]+)\)|[—–-]\s*([^()\n]+?)))?\s*$/;

function parseSquadVoices(text, knownAgents) {
    if (typeof text !== "string" || !text) return [];
    const normalizedKnown = new Set(
        (knownAgents || []).map((a) => a.toLowerCase()),
    );
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const voices = [];
    let cur = null;
    let inFence = false;

    const flush = () => {
        if (cur && cur.text.trim().length > 0) {
            const trimmed = cur.text.trim();
            voices.push({
                name: cur.name,
                role: cur.role,
                text: trimmed.length > VOICE_TEXT_MAX
                    ? trimmed.slice(0, VOICE_TEXT_MAX - 1) + "…"
                    : trimmed,
            });
        }
        cur = null;
    };

    for (const line of lines) {
        // Skip fenced code blocks — headings inside them aren't squad voices.
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            if (cur) cur.text += line + "\n";
            continue;
        }
        if (inFence) {
            if (cur) cur.text += line + "\n";
            continue;
        }

        // Only level-3+ ATX headings are considered voice headers.
        const h = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
        if (h) {
            flush();
            const norm = normalizeHeader(h[2]);
            const nm = norm.match(HEADER_NAME_RE);
            if (!nm) continue;
            const name = nm[1];
            const role = (nm[2] || nm[3] || "").trim();
            // If we have a known-agent list, only accept names from it.
            // If no agents are registered, fall back to the regex shape alone.
            if (
                normalizedKnown.size > 0 &&
                !normalizedKnown.has(name.toLowerCase())
            ) {
                continue;
            }
            cur = { name, role, text: "" };
        } else if (cur) {
            cur.text += line + "\n";
        }
    }
    flush();
    return voices;
}

function pushVoices(parentAgent, voices) {
    if (!voices || voices.length === 0) return;
    const now = Date.now();
    for (const v of voices) {
        state.voices.push({
            ts: now,
            agent: v.name,
            role: v.role || "",
            parent: parentAgent || "",
            text: v.text,
        });
    }
    while (state.voices.length > VOICE_BUFFER_MAX) state.voices.shift();
    pushUpdate();
}

function openBrowser(url) {
    if (browserOpened) return;
    browserOpened = true;
    let cmd;
    if (process.platform === "win32") cmd = `cmd /c start "" "${url}"`;
    else if (process.platform === "darwin") cmd = `open "${url}"`;
    else cmd = `xdg-open "${url}"`;
    exec(cmd, () => {});
}

// ---------------------------------------------------------------------------
// HTTP server (dashboard + JSON API + SSE stream)
// ---------------------------------------------------------------------------
function startServer() {
    if (httpServer) return;
    httpServer = createServer((req, res) => {
        const url = req.url || "/";

        if (url === "/" || url.startsWith("/?")) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(DASHBOARD_HTML);
            return;
        }
        if (url === "/api/state") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(snapshot()));
            return;
        }
        if (url === "/api/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
                "access-control-allow-origin": "*",
            });
            res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
            sseClients.add(res);
            req.on("close", () => sseClients.delete(res));
            return;
        }
        if (url === "/api/limit" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                try {
                    const { max } = JSON.parse(body || "{}");
                    const raw = Math.floor(Number(max));
                    if (!Number.isFinite(raw)) throw new Error("invalid number");
                    // Minimum of 2: the coordinator's first assistant turn always
                    // consumes 1, so a limit of 1 blocks every subsequent tool
                    // call and traps the agent in a deny-retry loop.
                    const n = Math.max(2, raw);
                    state.maxRequests = n;
                    state.limitSetAt = Date.now();
                    state.blocked = state.totalRequests >= n;
                    pushEvent("info", `Session budget set to ${n} premium requests.`);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, maxRequests: n }));
                } catch (e) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: String(e) }));
                }
            });
            return;
        }
        if (url === "/api/reset" && req.method === "POST") {
            state.totalRequests = 0;
            state.perAgent = {};
            // Also wipe local-inference state — otherwise the doughnut keeps
            // a stale O'Brien (local) slice and renders all-green after reset.
            state.localRequests = 0;
            state.perLocalAgent = {};
            state.blocked = false;
            pushEvent("info", "Counters reset.");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (url === "/api/unblock" && req.method === "POST") {
            state.blocked = false;
            pushEvent("info", "Block manually cleared by user.");
            res.writeHead(200); res.end("ok");
            return;
        }
        // Local-inference bump endpoint. Wrapper scripts (call-obrien.ps1
        // and verify-obrien.ps1) hit this AFTER successfully calling
        // Foundry Local so the dashboard can show the call without
        // affecting the premium-request budget.
        if (url === "/api/local-bump" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
            req.on("end", () => {
                let payload = {};
                try { payload = JSON.parse(body || "{}"); } catch {}
                const agent = (payload.agent || "obrien").toString().slice(0, 60);
                const role  = (payload.role  || "Local Inference (Foundry Local)").toString().slice(0, 80);
                const model = (payload.model || "").toString().slice(0, 120);
                bumpLocal(agent, role, model);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, localRequests: state.localRequests }));
            });
            return;
        }
        if (url === "/api/reset-local" && req.method === "POST") {
            state.localRequests = 0;
            state.perLocalAgent = {};
            pushEvent("info", "Local counters reset.");
            res.writeHead(200); res.end("ok");
            return;
        }

        res.writeHead(404);
        res.end();
    });
    httpServer.on("error", (err) => {
        // Most likely EADDRINUSE — another session is already serving.
        // We silently ignore and assume the existing dashboard is in use.
        try { session.log(`squad-budget: HTTP server error: ${err.message}`, { level: "warning" }); } catch {}
    });
    httpServer.listen(PORT, HOST);
}

// ---------------------------------------------------------------------------
// Eager activation
//
// `joinSession`'s `onSessionStart` hook only fires when a NEW session begins.
// If the user reloads this extension mid-session (e.g. via extensions_reload
// after a code change), the existing session has long since started, the hook
// never fires, and the dashboard would silently stay offline. We mitigate by
// also probing the CLI's current working directory at module load and
// activating eagerly if it already looks like a Squad workspace.
// ---------------------------------------------------------------------------
function activate(cwd) {
    if (state.active) return;
    if (!cwd || !detectSquad(cwd)) return;
    state.cwd = cwd;
    state.active = true;
    state.startedAt = state.startedAt || Date.now();
    state.knownAgents = loadKnownAgents(cwd);
    startServer();
    openBrowser(URL);
}

// NOTE: eager activation moved to the END of this file, after DASHBOARD_HTML
// is defined. Starting the HTTP server here would register a request handler
// that references DASHBOARD_HTML while module evaluation is suspended on the
// `await joinSession(...)` below — an incoming browser request would hit the
// TDZ for DASHBOARD_HTML and crash the extension (code=1).

// ---------------------------------------------------------------------------
// Wire up the session
// ---------------------------------------------------------------------------
session = await joinSession({
    hooks: {
        onSessionStart: async (input) => {
            state.cwd = input.cwd;
            if (!detectSquad(input.cwd)) return; // silent no-op for non-Squad repos
            activate(input.cwd);
            await session.log(
                `🛡️ squad-budget active — open ${URL} to set the session premium-request limit.`,
            );
            if (!state.maxRequests) {
                return {
                    additionalContext:
                        `[squad-budget] A premium-request budget guard is active. ` +
                        `Dashboard at ${URL}. The user must set a max-requests value there ` +
                        `before the budget is enforced.`,
                };
            }
            return {
                additionalContext:
                    `[squad-budget] Active — budget ${state.totalRequests}/${state.maxRequests}.`,
            };
        },

        onUserPromptSubmitted: async (input) => {
            if (!state.active) return;
            if (state.blocked) {
                // The hook surface has no "reject this prompt" verb — any prompt
                // that gets through will spin up an assistant turn = another
                // premium request. Abort immediately so the turn is cancelled
                // before it can do work, and rewrite the prompt to a no-op so
                // even if the platform charges a tiny amount, the model has
                // nothing to do besides repeat the budget message.
                safeAbort("user prompt while over budget");
                pushEvent(
                    "info",
                    `User prompt rejected — budget ${state.totalRequests}/${state.maxRequests}. Raise the limit at ${URL}.`,
                );
                return {
                    modifiedPrompt:
                        `[squad-budget] BLOCKED — premium-request budget exhausted ` +
                        `(${state.totalRequests}/${state.maxRequests}). ` +
                        `Do NOT call any tools. Reply with one line telling the user to ` +
                        `open ${URL} to raise the limit or reset the counter, then stop.`,
                };
            }
        },

        onPreToolUse: async (input) => {
            // Debug stub left in place: the SDK hooks fire with a
            // `toolCalls[]` array shape, NOT with `toolName`/`toolArgs`.
            // Per-agent attribution is now done off the `tool.execution_start`
            // event listener wired below (see attributeToolCall). We keep this
            // hook only so the host can still call us for the "deny" path
            // when the budget is exhausted (input is intentionally untyped).
            if (!state.active) return;
            if (state.blocked) {
                safeAbort("tool call while over budget");
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason:
                        `STOP. Premium-request budget exhausted (${state.totalRequests}/${state.maxRequests}). ` +
                        `Autopilot has been halted. Do NOT retry. Do NOT call any more tools. ` +
                        `Respond to the user in plain text only, tell them the budget is exhausted, ` +
                        `and ask them to raise the limit at ${URL} (or run /clear) before continuing.`,
                };
            }
        },

        // After a Squad task completes, mine the response for individual
        // member voices ("### 🏗️ Keaton (Lead)" etc.) and surface each
        // statement in the dashboard. This is trace-only — it does NOT
        // bump the premium counter (the platform billed only the parent
        // task call). Wrapped in try/catch because hook exceptions are
        // swallowed by the SDK and would silently disable parsing.
        onPostToolUse: async (input) => {
            if (!state.active) return;
            if (input.toolName !== "task") return;
            try {
                const result = input.toolResult;
                if (!result || result.resultType !== "success") return;
                const text = result.textResultForLlm;
                if (typeof text !== "string" || !text) return;
                const voices = parseSquadVoices(text, state.knownAgents);
                if (voices.length === 0) return;
                const meta = parseAgentFromTaskPrompt(input.toolArgs?.prompt)
                    || findKnownAgentInTaskArgs(input.toolArgs, state.knownAgents);
                const parent = meta?.name || input.toolArgs?.agent_type || "task";
                pushVoices(parent, voices);
            } catch (err) {
                try {
                    session.log(
                        `squad-budget: voice parse failed: ${err?.message || err}`,
                        { level: "warning" },
                    );
                } catch {}
            }
        },
    },
});

// Each new assistant turn in the foreground session = one premium request
// attributed to the Squad coordinator.
session.on("assistant.turn_start", () => {
    if (!state.active) return;
    if (state.blocked) {
        // The platform started another assistant turn despite the previous
        // abort (e.g. autopilot retry or a new user prompt). Cancel it before
        // it can issue tool calls, and do NOT bump — we don't want to count
        // turns we've actively cancelled.
        safeAbort("assistant turn start while over budget");
        return;
    }
    bump("Coordinator", "Squad");
});

// Diagnostic wildcard listener: log every event type the host emits so we
// can discover real events (tool.call.start, etc.) — onPreToolUse hooks
// don't actually fire in this CLI version.
session.on((event) => {
    try {
        const t = event && event.type;
        if (!t) return;
        global.__sb_seenEvts = global.__sb_seenEvts || new Map();
        const n = (global.__sb_seenEvts.get(t) || 0) + 1;
        global.__sb_seenEvts.set(t, n);
        if (n <= 2) {
            let preview = "";
            try { preview = JSON.stringify(event.data).slice(0, 240); } catch {}
            pushEvent("info", `evt: ${t} #${n} data=${preview}`);
        }
    } catch {}
});

// ---------------------------------------------------------------------------
// REAL per-agent attribution.
//
// SDK hooks (onPreToolUse / onPostToolUse) fire with a different payload
// shape than the docs suggest (toolCalls[] array, not toolName/toolArgs)
// AND aren't reliable for sub-agent attribution. The host emits a much
// richer stream of events that we can subscribe to directly. The two
// signals we actually need are:
//   - `tool.execution_start` — for every tool call (task, powershell, …)
//     with full args and (when nested) a parentToolCallId.
//   - `tool.execution_complete` — with the result text, used to mine
//     individual member voices out of a Squad task response.
// ---------------------------------------------------------------------------

session.on("tool.execution_start", (event) => {
    if (!state.active) return;
    try {
        const d = event?.data || {};
        const toolName = d.toolName;
        const args = d.arguments || {};

        // SQUAD subagent dispatch: any call to the `task` tool launches a
        // Squad member. Attribute one premium request to whichever known
        // agent the prompt names (Picard, Geordi, …). We DO want to count
        // nested task calls too (a Squad member spawning another agent),
        // but we filter out *non-task* nested tool calls below.
        if (toolName === "task") {
            let meta = parseAgentFromTaskPrompt(args.prompt)
                || findKnownAgentInTaskArgs(args, state.knownAgents);
            if (meta) {
                // Normalize the matched name (strip apostrophes, lowercase)
                // so "O'Brien" matches the on-disk agent id "obrien".
                const normalized = meta.name
                    .replace(/['\u2019\u2018]/g, "")
                    .toLowerCase();
                const isKnown =
                    state.knownAgents.length === 0 ||
                    state.knownAgents.includes(normalized) ||
                    state.knownAgents.includes(meta.name.toLowerCase()) ||
                    state.knownAgents.includes(meta.name);
                // Prefer the canonical on-disk name for display when we
                // have a normalized match (so "O'Brien" → "Obrien" is
                // the same row as direct "obrien" matches).
                let displayName = meta.name;
                if (isKnown && state.knownAgents.includes(normalized)) {
                    displayName = normalized.charAt(0).toUpperCase() + normalized.slice(1);
                }
                const agent = isKnown ? displayName : `${meta.name} (unlisted)`;
                bump(agent, meta.role);
                // Stash for the matching tool.execution_complete (voice mining).
                if (d.toolCallId) {
                    global.__sb_toolParents = global.__sb_toolParents || new Map();
                    global.__sb_toolParents.set(d.toolCallId, agent);
                }
            } else {
                bump("subagent", args.agent_type || "");
            }
            return;
        }

        // For shell-style tool calls — only attribute LOCAL INFERENCE if
        // the command hits the Foundry Local endpoint. Both top-level (the
        // user shells out from the orchestrator) and nested-inside-Squad
        // (a subagent shells out) calls count.
        if (typeof toolName === "string" && /^(powershell|bash|shell|terminal)/i.test(toolName)) {
            const local = detectLocalInference(toolName, args);
            if (local) {
                bumpLocal(local.agent, "Local Inference (Foundry Local)", local.model);
            }
        }
    } catch (err) {
        try { session.log("squad-budget: tool.execution_start handler failed: " + (err?.message || err), { level: "warning" }); } catch {}
    }
});

session.on("tool.execution_complete", (event) => {
    if (!state.active) return;
    try {
        const d = event?.data || {};
        if (d.toolName !== "task") return; // we only mine voices from Squad task results
        if (d.success !== true) return;
        const text = d.result?.content;
        if (typeof text !== "string" || !text) return;
        const voices = parseSquadVoices(text, state.knownAgents);
        if (voices.length === 0) return;
        // Find the parent attribution (which agent the original task targeted).
        // Best effort — if not parseable, fall back to "task".
        let parent = "task";
        try {
            // The original task arguments aren't on the complete event, but
            // we can stash them via a per-toolCallId map populated in start.
            parent = (global.__sb_toolParents && global.__sb_toolParents.get(d.toolCallId)) || parent;
        } catch {}
        pushVoices(parent, voices);
    } catch (err) {
        try { session.log("squad-budget: tool.execution_complete handler failed: " + (err?.message || err), { level: "warning" }); } catch {}
    }
});

// At shutdown the platform reports the authoritative total — log it so the
// user can compare against the extension's per-agent attribution.
session.on("session.shutdown", (event) => {
    const total = event?.data?.totalPremiumRequests;
    if (typeof total === "number") {
        state.platformReportedTotal = total;
        pushEvent("info", `Platform reported total premium requests this session: ${total}.`);
    }
});

// ---------------------------------------------------------------------------
// Dashboard HTML (single self-contained page, Chart.js via CDN)
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Squad Budget</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    color-scheme: dark;
    /* GitHub Primer dark tokens */
    --bgColor-default: #0d1117;
    --bgColor-muted: #161b22;
    --bgColor-inset: #010409;
    --bgColor-emphasis: #21262d;
    --borderColor-default: #30363d;
    --borderColor-muted: #21262d;
    --fgColor-default: #e6edf3;
    --fgColor-muted: #9da7b3;
    --fgColor-onEmphasis: #ffffff;
    --accent-fg: #2f81f7;
    --accent-emphasis: #1f6feb;
    --accent-subtle: rgba(56,139,253,0.15);
    --success-fg: #3fb950;
    --success-emphasis: #238636;
    --success-subtle: rgba(46,160,67,0.15);
    --attention-fg: #d29922;
    --attention-subtle: rgba(187,128,9,0.15);
    --danger-fg: #f85149;
    --danger-subtle: rgba(248,81,73,0.15);
    --focus-ring: 0 0 0 2px var(--accent-emphasis);
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-pill: 999px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    background: var(--bgColor-default);
    color: var(--fgColor-default);
    padding: 24px;
    max-width: 1100px;
    margin-inline: auto;
  }
  h1 { margin: 0 0 4px 0; font-size: 24px; line-height: 1.25; font-weight: 600;
       display: flex; align-items: center; gap: 10px; letter-spacing: -0.01em; }
  h2 { margin: 0 0 8px 0; font-size: 16px; font-weight: 600; line-height: 1.4; }
  h3 { margin: 24px 0 8px 0; font-size: 13px; font-weight: 600; line-height: 1.4;
       text-transform: uppercase; letter-spacing: 0.04em; color: var(--fgColor-muted); }
  code { background: var(--bgColor-emphasis); padding: 1px 6px; border-radius: 4px;
         font-size: 12px; font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; }

  .muted { color: var(--fgColor-muted); font-size: 13px; }

  /* Status pill — color reflects state */
  .pill {
    font-size: 11px; font-weight: 500; padding: 3px 8px; border-radius: var(--radius-pill);
    border: 1px solid transparent; line-height: 1.4;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.idle      { background: var(--bgColor-emphasis); color: var(--fgColor-muted); border-color: var(--borderColor-default); }
  .pill.tracking  { background: var(--accent-subtle); color: var(--accent-fg); border-color: rgba(56,139,253,0.4); }
  .pill.near      { background: rgba(187,128,9,0.15); color: var(--attention-fg); border-color: rgba(187,128,9,0.4); }
  .pill.blocked   { background: var(--danger-subtle); color: var(--danger-fg); border-color: rgba(248,81,73,0.4); }

  .panel {
    background: var(--bgColor-muted);
    border: 1px solid var(--borderColor-default);
    border-radius: var(--radius-md);
    padding: 20px;
    margin-top: 16px;
  }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: center; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }

  /* Form controls */
  label { display: block; font-size: 13px; font-weight: 500; color: var(--fgColor-default); margin-bottom: 6px; }
  input[type=number] {
    background: var(--bgColor-default);
    color: var(--fgColor-default);
    border: 1px solid var(--borderColor-default);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    font-size: 14px;
    line-height: 20px;
    width: 200px;
    font-family: inherit;
  }
  input[type=number]:hover { border-color: var(--fgColor-muted); }
  input[type=number]:focus-visible { outline: none; border-color: var(--accent-emphasis); box-shadow: var(--focus-ring); }

  button {
    background: var(--success-emphasis);
    color: var(--fgColor-onEmphasis);
    border: 1px solid rgba(240,246,252,0.1);
    border-radius: var(--radius-sm);
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    cursor: pointer;
    margin-left: 8px;
    font-family: inherit;
    transition: background 0.12s, border-color 0.12s;
  }
  button:hover { background: #2ea043; }
  button.secondary {
    background: var(--bgColor-emphasis);
    color: var(--fgColor-default);
    border: 1px solid var(--borderColor-default);
  }
  button.secondary:hover { background: #30363d; border-color: var(--fgColor-muted); }
  button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
  button + button { margin-left: 8px; }

  /* Hero stat block */
  .hero {
    display: flex; align-items: baseline; gap: 8px;
    font-variant-numeric: tabular-nums;
    margin-bottom: 4px;
  }
  .hero .used { font-size: 36px; font-weight: 600; line-height: 1.1; color: var(--fgColor-default); letter-spacing: -0.02em; }
  .hero .sep  { font-size: 28px; color: var(--fgColor-muted); font-weight: 300; }
  .hero .limit { font-size: 28px; color: var(--fgColor-muted); font-weight: 500; }
  .hero-sub { color: var(--fgColor-muted); font-size: 13px; font-variant-numeric: tabular-nums; margin-bottom: 16px; }
  .hero-sub strong { color: var(--fgColor-default); font-weight: 500; }

  /* Threshold-colored progress bar */
  .bar-wrap {
    background: var(--bgColor-emphasis);
    border-radius: var(--radius-pill);
    height: 8px;
    overflow: hidden;
    margin: 12px 0 8px 0;
  }
  .bar-fill {
    height: 100%;
    width: 0%;
    background: var(--success-fg);
    border-radius: var(--radius-pill);
    transition: width 0.3s ease, background-color 0.2s;
  }
  .bar-fill.near    { background: var(--attention-fg); }
  .bar-fill.over    { background: var(--danger-fg); }

  .actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button { margin-left: 0; }

  .blocked-banner {
    background: var(--danger-subtle);
    border: 1px solid rgba(248,81,73,0.4);
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    color: var(--danger-fg);
    margin-top: 16px;
    font-weight: 500;
    font-size: 13px;
    display: flex; align-items: center; gap: 8px;
  }
  .blocked-banner::before { content: "⛔"; font-size: 16px; }

  /* Workspace meta in setup panel */
  .meta-grid { display: grid; gap: 10px; padding: 14px; margin: 14px 0;
               background: var(--bgColor-inset); border: 1px solid var(--borderColor-muted);
               border-radius: var(--radius-sm); font-size: 13px; }
  .meta-grid .row { display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: baseline; }
  .meta-grid .label { color: var(--fgColor-muted); }
  .meta-grid .value { color: var(--fgColor-default); font-family: ui-monospace, "SF Mono", "Cascadia Code", monospace;
                      font-size: 12px; word-break: break-all; }
  .agent-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-pill);
          background: var(--accent-subtle); color: var(--accent-fg);
          border: 1px solid rgba(56,139,253,0.3); font-family: inherit; }

  /* Chart container — keep doughnut small so it doesn't dominate the layout. */
  .chart-wrap {
    max-width: 200px;
    width: 100%;
    margin: 0 auto;
    aspect-ratio: 1 / 1;
    position: relative;
  }
  .chart-wrap canvas { width: 100% !important; height: 100% !important; display: block; }

  /* Event log — one row per premium request, newest first, scrollable. */
  .events {
    max-height: 280px; overflow-y: auto;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
    font-size: 12px; line-height: 1.6;
    background: var(--bgColor-inset);
    border: 1px solid var(--borderColor-muted);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  .events .ev {
    display: grid;
    grid-template-columns: 78px 1fr auto;
    gap: 12px;
    padding: 3px 0;
    align-items: baseline;
    border-bottom: 1px solid transparent;
  }
  .events .ev + .ev { border-top: 1px solid var(--borderColor-muted); }
  .events .ev .ts { color: var(--fgColor-muted); font-variant-numeric: tabular-nums; }
  .events .ev .body { color: var(--fgColor-default); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
  .events .ev .agent { color: var(--fgColor-default); font-weight: 600; }
  .events .ev .role  { color: var(--fgColor-muted); font-size: 11px; }
  .events .ev .msg   { color: var(--fgColor-muted); }
  .events .ev .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: var(--radius-pill);
    background: var(--accent-subtle); color: var(--accent-fg);
    border: 1px solid rgba(56,139,253,0.3);
    font-family: inherit;
  }
  .events .ev.error  .tag { background: var(--danger-subtle); color: var(--danger-fg); border-color: rgba(248,81,73,0.4); }
  .events .ev.warning .tag { background: rgba(187,128,9,0.15); color: var(--attention-fg); border-color: rgba(187,128,9,0.4); }
  .events .ev.info   .tag { background: var(--bgColor-emphasis); color: var(--fgColor-muted); border-color: var(--borderColor-default); }
  .events .ev.local  .tag { background: rgba(63,185,80,0.15); color: var(--success-fg, #3fb950); border-color: rgba(63,185,80,0.4); }
  .events .ev.local  .msg { color: var(--success-fg, #3fb950); }
  .events .ev.error  .msg { color: var(--danger-fg); }
  .events .ev.warning .msg { color: var(--attention-fg); }
  /* Per-agent table — small "free" tag for local-inference rows. */
  td .free-tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: var(--radius-pill); margin-left: 6px;
    background: rgba(63,185,80,0.15); color: var(--success-fg, #3fb950);
    border: 1px solid rgba(63,185,80,0.4);
  }
  .empty { color: var(--fgColor-muted); font-style: italic; padding: 12px 0; font-size: 13px; }

  /* Squad voices — multi-line rows showing individual member statements
     parsed from a single task() result. Trace-only, do not affect the
     budget counter. */
  .voices {
    max-height: 420px; overflow-y: auto;
    background: var(--bgColor-inset);
    border: 1px solid var(--borderColor-muted);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  .voice {
    padding: 10px 0;
    border-bottom: 1px solid var(--borderColor-muted);
  }
  .voice:last-child { border-bottom: none; }
  .voice .head {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    margin-bottom: 4px;
    font-size: 12px;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
  }
  .voice .ts { color: var(--fgColor-muted); font-variant-numeric: tabular-nums; }
  .voice .agent { color: var(--fgColor-default); font-weight: 600; font-size: 13px; }
  .voice .role { color: var(--fgColor-muted); font-size: 11px; }
  .voice .parent { color: var(--fgColor-muted); font-size: 11px; }
  .voice .tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 1px 6px; border-radius: var(--radius-pill);
    background: rgba(163,113,247,0.15); color: #a371f7;
    border: 1px solid rgba(163,113,247,0.4);
    font-family: inherit;
  }
  .voice .text {
    color: var(--fgColor-default);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-wrap: break-word;
    border-left: 2px solid #a371f7;
    padding-left: 10px;
    margin-left: 4px;
  }

  .hidden { display: none; }

  /* Per-agent table */
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--borderColor-muted); font-size: 13px; }
  thead th { color: var(--fgColor-muted); font-weight: 500; font-size: 12px;
             text-transform: uppercase; letter-spacing: 0.04em;
             border-bottom: 1px solid var(--borderColor-default); }
  tbody tr:last-child td { border-bottom: none; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.empty-cell { text-align: center; color: var(--fgColor-muted); font-style: italic; padding: 18px 0; }
</style>
</head>
<body>
  <h1>🛡️ Squad Budget <span class="pill idle" id="status-pill" role="status" aria-live="polite">connecting…</span></h1>
  <div class="muted" id="cwd"></div>

  <div class="panel" id="setup-panel">
    <h2>Set the premium-request budget for this session</h2>
    <p class="muted" style="margin-top:0">
      Every Copilot CLI premium request consumed by Squad — coordinator turns plus
      every subagent dispatched via the <code>task</code> tool — is counted here.
      When the limit is hit, all further tool calls are denied (even with autopilot on)
      until you raise the limit or reset.
    </p>

    <div class="meta-grid" id="setup-meta" aria-label="Detected workspace">
      <div class="row">
        <span class="label">Workspace</span>
        <span class="value" id="setup-cwd">—</span>
      </div>
      <div class="row">
        <span class="label">Agents detected</span>
        <span class="agent-chips" id="setup-agents"><span class="muted">none</span></span>
      </div>
    </div>

    <label for="limit-input">Maximum premium requests</label>
    <input type="number" id="limit-input" min="2" placeholder="e.g. 50" aria-describedby="limit-help" />
    <button id="limit-set" aria-label="Start tracking with the entered budget">Start tracking</button>
    <div class="muted" id="limit-help" style="margin-top:8px">Minimum 2 (the first coordinator turn always consumes 1). A typical Squad iteration burns 20–60 premium requests.</div>
  </div>

  <div class="panel hidden" id="dashboard-panel">
    <div class="grid">
      <div>
        <div class="hero" aria-label="Premium requests used out of limit">
          <span class="used" id="used">0</span>
          <span class="sep">/</span>
          <span class="limit" id="limit">–</span>
        </div>
        <div class="hero-sub">
          <strong id="remaining">–</strong> remaining · <span id="pct">0%</span> of budget used
          · <strong id="local-count" style="color:#3fb950">0</strong> local <span class="muted">(free, off-budget)</span>
        </div>
        <div class="bar-wrap" role="progressbar" aria-label="Budget consumption" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="bar-wrap">
          <div class="bar-fill" id="bar"></div>
        </div>
        <div class="blocked-banner hidden" id="blocked-banner" role="alert">
          Budget exhausted — Squad has been halted. Tool calls are being denied.
        </div>
        <div class="actions">
          <button class="secondary" id="reset" aria-label="Reset request counter to zero">Reset counter</button>
          <button class="secondary" id="raise" aria-label="Raise the maximum request limit">Raise limit…</button>
          <button class="secondary" id="unblock" aria-label="Clear the block and resume tool calls">Clear block</button>
        </div>
      </div>
      <div>
        <div class="chart-wrap">
          <canvas id="chart" aria-label="Per-agent request distribution chart"></canvas>
        </div>
      </div>
    </div>

    <h3>Per-agent breakdown</h3>
    <table>
      <thead><tr><th scope="col">Agent</th><th scope="col">Role</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Share</th></tr></thead>
      <tbody id="agent-rows">
        <tr><td colspan="4" class="empty-cell">No subagents dispatched yet.</td></tr>
      </tbody>
    </table>

    <h3>Recent activity</h3>
    <div class="events" id="events" role="log" aria-live="polite" aria-label="Recent budget events">
      <div class="empty">Waiting for activity…</div>
    </div>

    <h3>Squad voices</h3>
    <p class="muted" style="margin-top:-4px;margin-bottom:8px;font-size:12px">
      Individual member statements parsed from each <code>task</code> result.
      Trace-only — these don't count against the premium-request budget
      (the platform bills one request per <code>task</code> call regardless of how many members speak).
    </p>
    <div class="voices" id="voices" role="log" aria-live="polite" aria-label="Squad member voices">
      <div class="empty">No squad voices captured yet.</div>
    </div>

    <p class="muted" id="platform-total" style="margin-top:14px"></p>
  </div>

<script>
let chart = null;

async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({}));
}

document.getElementById("limit-set").onclick = async () => {
  const v = Number(document.getElementById("limit-input").value);
  if (!v || v < 2) { alert("Enter a number >= 2 (the first coordinator turn always consumes 1)."); return; }
  await postJSON("/api/limit", { max: v });
};
document.getElementById("reset").onclick = () => postJSON("/api/reset");
document.getElementById("unblock").onclick = () => postJSON("/api/unblock");
document.getElementById("raise").onclick = async () => {
  const v = prompt("New maximum number of premium requests:");
  if (v) await postJSON("/api/limit", { max: Number(v) });
};

function render(s) {
  // Workspace info (header + setup panel)
  document.getElementById("cwd").textContent = s.cwd ? "Workspace: " + s.cwd : "";
  document.getElementById("setup-cwd").textContent = s.cwd || "—";
  const agentsEl = document.getElementById("setup-agents");
  if (s.knownAgents && s.knownAgents.length) {
    agentsEl.innerHTML = s.knownAgents.map(a =>
      "<span class='chip'>" + a + "</span>").join("");
  } else {
    agentsEl.innerHTML = "<span class='muted'>none detected</span>";
  }

  const setup = document.getElementById("setup-panel");
  const dash  = document.getElementById("dashboard-panel");
  if (s.maxRequests) { setup.classList.add("hidden"); dash.classList.remove("hidden"); }
  else               { setup.classList.remove("hidden"); dash.classList.add("hidden"); }

  document.getElementById("used").textContent = s.totalRequests;
  document.getElementById("limit").textContent = s.maxRequests ?? "–";
  const remaining = s.maxRequests ? Math.max(0, s.maxRequests - s.totalRequests) : "–";
  document.getElementById("remaining").textContent = remaining;
  const pct = s.maxRequests ? Math.min(100, (s.totalRequests / s.maxRequests) * 100) : 0;
  const bar = document.getElementById("bar");
  bar.style.width = pct + "%";
  bar.classList.toggle("near", pct >= 60 && pct < 85);
  bar.classList.toggle("over", pct >= 85);
  document.getElementById("bar-wrap").setAttribute("aria-valuenow", pct.toFixed(0));
  document.getElementById("pct").textContent = pct.toFixed(1) + "%";

  // Status pill — reflect actual state with Primer-aligned color
  const pill = document.getElementById("status-pill");
  pill.classList.remove("idle", "tracking", "near", "blocked");
  if (s.blocked) {
    pill.classList.add("blocked"); pill.textContent = "blocked";
  } else if (s.maxRequests && pct >= 85) {
    pill.classList.add("near"); pill.textContent = "near limit";
  } else if (s.active && s.maxRequests) {
    pill.classList.add("tracking"); pill.textContent = "tracking";
  } else {
    pill.classList.add("idle"); pill.textContent = s.active ? "ready" : "idle";
  }

  document.getElementById("blocked-banner").classList.toggle("hidden", !s.blocked);
  document.getElementById("local-count").textContent = s.localRequests || 0;

  // Build a unified series for the doughnut: premium agents first (warm/blue
  // palette) followed by local agents (green palette + " (local)" suffix so
  // the user can tell at a glance which slices are zero-cost).
  const premiumEntries = Object.entries(s.perAgent || {}).sort((a,b) => b[1].requests - a[1].requests);
  const localEntries   = Object.entries(s.perLocalAgent || {}).sort((a,b) => b[1].requests - a[1].requests);
  const PREMIUM_COLORS = ["#2f81f7","#d29922","#a371f7","#f85149","#79c0ff","#ff7b72","#bc8cff","#ffa657"];
  const LOCAL_COLORS   = ["#3fb950","#56d364","#7ee787","#26a641"];
  const totalActivity  = (s.totalRequests || 0) + (s.localRequests || 0);
  let labels, data, backgroundColor, emptyState = false;
  if (totalActivity === 0) {
    // No activity yet — render a single neutral-grey ring so the chart
    // doesn't misleadingly show a stale agent palette.
    labels = ["No activity"];
    data = [1];
    backgroundColor = ["#30363d"];
    emptyState = true;
  } else {
    labels = [
      ...premiumEntries.map(([n]) => n),
      ...localEntries.map(([n]) => n + " (local)"),
    ];
    data = [
      ...premiumEntries.map(([,v]) => v.requests),
      ...localEntries.map(([,v]) => v.requests),
    ];
    backgroundColor = [
      ...premiumEntries.map((_, i) => PREMIUM_COLORS[i % PREMIUM_COLORS.length]),
      ...localEntries.map((_, i) => LOCAL_COLORS[i % LOCAL_COLORS.length]),
    ];
  }

  if (!chart) {
    chart = new Chart(document.getElementById("chart"), {
      type: "doughnut",
      data: { labels, datasets: [{ data, backgroundColor,
        borderColor: "#161b22", borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1,
        cutout: "62%",
        plugins: {
          legend: { display: !emptyState, position: "bottom",
            labels: { color: "#9da7b3", font: { size: 11, family: "-apple-system, Segoe UI, sans-serif" },
                      boxWidth: 8, boxHeight: 8, padding: 8, usePointStyle: true } },
          tooltip: { enabled: !emptyState, callbacks: {
            label: (ctx) => {
              const isLocal = ctx.label && ctx.label.endsWith("(local)");
              return ctx.label + ": " + ctx.parsed + (isLocal ? " (free)" : " premium");
            }
          } }
        }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].backgroundColor = backgroundColor;
    chart.options.plugins.legend.display = !emptyState;
    chart.options.plugins.tooltip.enabled = !emptyState;
    chart.update("none");
  }

  const premiumRows = premiumEntries.map(([name, v]) => {
    const share = s.totalRequests ? ((v.requests / s.totalRequests) * 100).toFixed(1) : "0.0";
    return "<tr><td>" + name + "</td><td>" + (v.role || "") + "</td>" +
           "<td class=num>" + v.requests + "</td><td class=num>" + share + "%</td></tr>";
  }).join("");
  const localRows = localEntries.map(([name, v]) => {
    const role = (v.role || "Local Inference") + (v.model ? " · " + v.model : "");
    return "<tr><td>" + name + " <span class='free-tag'>local</span></td>" +
           "<td>" + role + "</td>" +
           "<td class=num>" + v.requests + "</td>" +
           "<td class=num><span class='free-tag'>free</span></td></tr>";
  }).join("");
  const rows = premiumRows + localRows;
  document.getElementById("agent-rows").innerHTML = rows ||
    "<tr><td colspan=4 class=empty-cell>No subagents dispatched yet.</td></tr>";

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
  const fmtTs = (ts) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  };
  const evs = (s.events || []).slice().reverse().slice(0, 50).map(e => {
    const ts = fmtTs(e.ts);
    if (e.level === "request") {
      const agent = esc(e.agent || "—");
      const role = e.role ? "<span class='role'>" + esc(e.role) + "</span>" : "";
      return "<div class='ev request'>" +
        "<span class='ts'>" + ts + "</span>" +
        "<span class='body'><span class='agent'>" + agent + "</span>" + role +
        "<span class='msg'>" + esc(e.message) + "</span></span>" +
        "<span class='tag'>premium</span></div>";
    }
    if (e.level === "local") {
      const agent = esc(e.agent || "—");
      const role = e.role ? "<span class='role'>" + esc(e.role) + "</span>" : "";
      return "<div class='ev local'>" +
        "<span class='ts'>" + ts + "</span>" +
        "<span class='body'><span class='agent'>" + agent + "</span>" + role +
        "<span class='msg'>" + esc(e.message) + "</span></span>" +
        "<span class='tag'>local · free</span></div>";
    }
    const lvl = esc(e.level || "info");
    return "<div class='ev " + lvl + "'>" +
      "<span class='ts'>" + ts + "</span>" +
      "<span class='body'><span class='msg'>" + esc(e.message) + "</span></span>" +
      "<span class='tag'>" + lvl + "</span></div>";
  }).join("");
  document.getElementById("events").innerHTML = evs ||
    "<div class='empty'>Waiting for activity…</div>";

  // Squad voices — newest first, render with statement quoted.
  const voices = (s.voices || []).slice().reverse().slice(0, 50).map(v => {
    const ts = fmtTs(v.ts);
    const role = v.role ? "<span class='role'>" + esc(v.role) + "</span>" : "";
    const parent = v.parent && v.parent !== v.agent
      ? "<span class='parent'>via " + esc(v.parent) + "</span>"
      : "";
    return "<div class='voice'>" +
      "<div class='head'>" +
        "<span class='ts'>" + ts + "</span>" +
        "<span class='agent'>" + esc(v.agent) + "</span>" +
        role + parent +
        "<span class='tag'>voice</span>" +
      "</div>" +
      "<div class='text'>" + esc(v.text) + "</div>" +
    "</div>";
  }).join("");
  document.getElementById("voices").innerHTML = voices ||
    "<div class='empty'>No squad voices captured yet.</div>";

  document.getElementById("platform-total").textContent =
    s.platformReportedTotal != null
      ? "Platform-reported total at last shutdown: " + s.platformReportedTotal
      : "Per-agent counts are an approximation — Coordinator turns + 1 per task() dispatch. The Copilot platform reports the authoritative total when the session ends.";
}

const es = new EventSource("/api/events");
es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
es.onerror = () => {
  const p = document.getElementById("status-pill");
  p.classList.remove("tracking","near","blocked"); p.classList.add("idle");
  p.textContent = "disconnected";
};
fetch("/api/state").then(r => r.json()).then(render).catch(() => {});
</script>
</body>
</html>`;


// Eager activation — runs after DASHBOARD_HTML is defined so the HTTP
// handler can safely serve the dashboard as soon as the server is listening.
try { activate(process.cwd()); } catch { /* best-effort */ }

