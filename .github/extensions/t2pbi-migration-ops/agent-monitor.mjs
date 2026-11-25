import { promises as fs, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { localDirectory } from "./evidence.mjs";
import { requireThat, object, toCsv } from "./common.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const identifier = (value) => typeof value === "string" && uuid.test(value);
const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const safeName = (value) => typeof value === "string" ? value.slice(0, 160) : "";
const samePath = (a, b) => process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const scopeNotice = "Session-wide activity may include unrelated work or other runs. Recorded states are not live-process proof or migration COMPLETE.";

export function runAnchors(manifest) {
    const anchors = new Map();
    const add = (kind, id) => {
        requireThat(identifier(id), "Run contains an invalid session/agent UUID.");
        anchors.set(`${kind}:${id.toLowerCase()}`, { kind, id: id.toLowerCase() });
    };
    const mapping = (value) => {
        if (!object(value)) return;
        for (const key of ["session_id", "root_session_id", "copilot_session_id"]) {
            if (value[key] !== undefined) add("session", value[key]);
        }
        for (const key of ["agent_id", "root_agent_id", "copilot_agent_id"]) {
            if (value[key] !== undefined) add("agent", value[key]);
        }
    };
    mapping(manifest);
    mapping(manifest.attribution);
    if (manifest.attribution?.roots !== undefined) {
        requireThat(Array.isArray(manifest.attribution.roots), "Invalid attribution roots.");
        manifest.attribution.roots.forEach(mapping);
    }
    requireThat(anchors.size <= 16, "Run exceeds the 16-anchor monitoring limit.");
    return [...anchors.values()];
}

export function eventProjection(sessionId) {
    const agents = new Map();
    const callers = new Map();
    let matched = false, mismatch = false, lastEvent = null, rootState = "unknown", rootTime = null;
    const root = { id: sessionId, name: "Session orchestrator", parentId: null, relationship: "session root",
        status: "unknown", stateAt: null, lastEvent: null, startedAt: null };
    const ensure = (id) => {
        if (!agents.has(id)) agents.set(id, { id, name: "Unnamed subagent", parentId: null, relationship: "unknown",
            status: "unknown", stateAt: null, lastEvent: null, startedAt: null, toolCallId: null });
        return agents.get(id);
    };
    const transition = (row, status, time) => {
        if (!row.stateAt || Date.parse(time) >= Date.parse(row.stateAt)) {
            row.status = status;
            row.stateAt = time;
        }
    };
    return {
        accept(event) {
            if (!object(event) || typeof event.type !== "string" || !stamp(event.timestamp)) return;
            const time = event.timestamp, d = object(event.data) ? event.data : {};
            if (!lastEvent || Date.parse(time) > Date.parse(lastEvent)) lastEvent = time;
            if (event.type === "session.start") {
                if (d.sessionId?.toLowerCase() === sessionId) matched = true;
                else mismatch = true;
                root.startedAt = time;
            }
            const agentId = identifier(event.agentId) ? event.agentId.toLowerCase() : null;
            if (event.type === "tool.execution_start" && typeof d.toolCallId === "string") {
                if (!callers.has(d.toolCallId)) callers.set(d.toolCallId, new Set());
                callers.get(d.toolCallId).add(agentId ?? sessionId);
            }
            const lifecycle = ["subagent.started", "subagent.completed", "subagent.failed"].includes(event.type);
            if (agentId && !agents.has(agentId) && !lifecycle) return;
            const row = agentId ? ensure(agentId) : root;
            if (!row.lastEvent || Date.parse(time) > Date.parse(row.lastEvent)) row.lastEvent = time;
            if (event.type === "subagent.started" && agentId) {
                row.name = safeName(d.agentDisplayName || d.agentName) || row.name;
                row.startedAt = time;
                row.toolCallId = typeof d.toolCallId === "string" ? d.toolCallId : null;
                transition(row, "running", time);
            } else if (event.type === "subagent.completed" && agentId) transition(row, "completed", time);
            else if (event.type === "subagent.failed" && agentId) transition(row, "failed", time);
            else if (event.type === "assistant.turn_start") transition(row, "running", time);
            else if (event.type === "assistant.turn_end") {
                if (!["completed", "failed"].includes(row.status)) transition(row, "idle", time);
            } else if (event.type === "session.shutdown" && !agentId) transition(root, "stopped", time);
            else if (event.type === "session.resume" && !agentId) transition(root, "unknown", time);
            rootState = root.status;
            rootTime = root.stateAt;
        },
        finish(asOf) {
            if (!matched || mismatch) return { status: "unknown", reason: "Session log identity is absent or mismatched.", agents: [], lastEvent: null };
            const rows = [...agents.values()].filter((row) => row.startedAt || row.stateAt);
            const ids = new Set(rows.map((row) => row.id));
            const cyclic = new Set();
            for (const row of rows) {
                const parents = callers.get(row.toolCallId);
                if (parents?.size === 1) {
                    const parent = [...parents][0];
                    if (parent !== row.id && (parent === sessionId || ids.has(parent))) {
                        row.parentId = parent;
                        row.relationship = "tool-call linked";
                    }
                }
            }
            for (const row of rows) {
                const visited = new Set([row.id]);
                let current = row;
                while (current.parentId && current.parentId !== sessionId) {
                    if (visited.has(current.parentId)) {
                        cyclic.add(row.id);
                        break;
                    }
                    visited.add(current.parentId);
                    current = rows.find((candidate) => candidate.id === current.parentId);
                    if (!current) break;
                }
            }
            for (const row of rows.filter((candidate) => cyclic.has(candidate.id))) {
                row.parentId = null;
                row.relationship = "unknown";
            }
            root.status = rootState;
            root.stateAt = rootTime;
            return {
                status: "observed", reason: scopeNotice, lastEvent,
                agents: [root, ...rows].map(({ toolCallId: _tool, ...row }) => ({
                    ...row, stale: !row.lastEvent || Date.parse(asOf) - Date.parse(row.lastEvent) > 120_000,
                    liveness: "not_verified",
                })),
            };
        },
    };
}

async function regularFile(file, limit) {
    const info = await fs.lstat(file);
    requireThat(info.isFile() && !info.isSymbolicLink(), "Linked/non-file monitoring evidence refused.");
    requireThat(info.size <= limit, "Monitoring evidence exceeds the read limit.");
    return info;
}

async function readSession(home, id, asOf, budget) {
    const result = { id, source: "Copilot local events adapter", status: "unknown", reason: "", lastEvent: null, agents: [] };
    try {
        const directory = await localDirectory(path.join(home, "session-state", id));
        const file = path.join(directory, "events.jsonl");
        const info = await regularFile(file, budget.remaining);
        budget.remaining -= info.size;
        const projection = eventProjection(id);
        if (info.size === 0) return { ...result, reason: "Session log is empty." };
        const handle = await fs.open(file, "r");
        let terminated;
        try {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, info.size - 1);
            terminated = last[0] === 10;
        } finally { await handle.close(); }
        const stream = createReadStream(file, { start: 0, end: info.size - 1 });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        // readline does not forward input-stream errors to its async iterator.
        stream.on("error", (error) => lines.emit("error", error));
        let pending = null, partialTail = false;
        const accept = (line, tail) => {
            requireThat(Buffer.byteLength(line) <= 16 * 1024 * 1024, "Session event exceeds the 16 MiB line limit.");
            try { projection.accept(JSON.parse(line)); }
            catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                if (!tail) throw new Error("Session log contains a malformed event.");
                partialTail = true;
            }
        };
        try {
            for await (const line of lines) {
                if (pending !== null) accept(pending, false);
                pending = line;
            }
            if (pending !== null) accept(pending, !terminated);
        } finally {
            lines.close();
            stream.destroy();
        }
        const after = await fs.lstat(file);
        requireThat(!after.isSymbolicLink() && after.ino === info.ino && after.size >= info.size,
            "Session log changed identity or was truncated during observation.");
        return { ...result, ...projection.finish(asOf), ...(partialTail ? { warning: "Incomplete final event ignored; writer may still be appending." } : {}) };
    } catch (error) {
        return { ...result, reason: error.code === "ENOENT"
            ? "Local session events unavailable for this anchor/host." : `Session observation refused: ${error.message}` };
    }
}

export async function observeAgents(run, { home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
    now = () => new Date(), maxBytes = 256 * 1024 * 1024 } = {}) {
    const result = { run, asOf: now().toISOString(), status: "unknown", notices: [scopeNotice], sessions: [], unknownAnchors: [] };
    try {
        const root = await localDirectory(run);
        const file = path.join(root, "run.json");
        await regularFile(file, 1024 * 1024);
        const manifest = JSON.parse(await fs.readFile(file, "utf8"));
        requireThat(object(manifest) && Number.isSafeInteger(manifest.run) && manifest.run > 0
            && typeof manifest.unit_key === "string" && manifest.unit_key.length > 0, "Run identity is not established.");
        requireThat((manifest.allocated_dir_name === undefined || manifest.allocated_dir_name === path.basename(root))
            && (manifest.allocated_abs_path === undefined || (typeof manifest.allocated_abs_path === "string"
                && samePath(manifest.allocated_abs_path, root))), "Run allocation identity mismatch.");
        const anchors = runAnchors(manifest);
        const budget = { remaining: maxBytes };
        for (const anchor of anchors.filter((row) => row.kind === "session")) {
            result.sessions.push(await readSession(home, anchor.id, result.asOf, budget));
        }
        for (const anchor of anchors.filter((row) => row.kind === "agent")) {
            if (!result.sessions.some((session) => session.agents.some((agent) => agent.id === anchor.id))) {
                result.unknownAnchors.push({ ...anchor, reason: "Agent anchor has no matching agent in the explicitly linked session logs; no global search performed." });
            }
        }
        result.status = result.sessions.some((session) => session.status === "observed") ? "observed" : "unknown";
        if (!anchors.length) result.notices.push("run.json contains no session or agent attribution anchors.");
        result.notices.push("Statuses change only on recorded lifecycle events. More than 120 seconds without an agent event is marked stale, not stopped. All session agents are shown, not proven run-specific work.");
    } catch (error) {
        result.notices.push(`Run observation refused: ${error.code === "ENOENT" ? "run.json or run directory is unavailable." : error.message}`);
    }
    return result;
}

export function agentActivityCsv(observation) {
    const rows = [];
    const base = { run: observation.run, observed_at: observation.asOf, observation_status: observation.status,
        certification: "NOT_CHECKED", limitations: observation.notices.join(" | ") };
    for (const session of observation.sessions) {
        if (!session.agents.length) rows.push({ ...base, session_id: session.id, recorded_status: "unknown", reason: session.reason });
        for (const agent of session.agents) rows.push({ ...base, session_id: session.id, agent_id: agent.id,
            agent_name: agent.name, parent_id: agent.parentId ?? "", relationship: agent.relationship,
            recorded_status: agent.status, state_at: agent.stateAt ?? "", last_event: agent.lastEvent ?? "",
            stale: agent.stale, liveness: agent.liveness, reason: [session.reason, session.warning].filter(Boolean).join(" | ") });
    }
    for (const anchor of observation.unknownAnchors) rows.push({ ...base, agent_id: anchor.id, recorded_status: "unknown", reason: anchor.reason });
    if (!rows.length) rows.push({ ...base, recorded_status: "unknown" });
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return { filename: "agent-activity.csv", content: toCsv(rows, columns), records: rows.length };
}
