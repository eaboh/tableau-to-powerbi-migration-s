import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { eventProjection, observeAgents, runAnchors, agentActivityCsv } from "../agent-monitor.mjs";
import { Operations } from "../operations.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const nestedId = "33333333-3333-4333-8333-333333333333";
const now = "2026-11-16T12:05:00.000Z";
const event = (type, data = {}, agentId, timestamp = "2026-11-16T12:00:00.000Z") => ({ type, data, agentId, timestamp });
const start = event("session.start", { sessionId });
const child = event("subagent.started", { agentDisplayName: "=Synthetic agent", toolCallId: "task-1" }, childId);

test("anchors reconcile direct and attribution fields; unsafe IDs fail without path traversal", () => {
    assert.deepEqual(runAnchors({ session_id: sessionId, attribution: { session_id: sessionId,
        roots: [{ session_id: nestedId }, { agent_id: childId }] } }), [
        { kind: "session", id: sessionId }, { kind: "session", id: nestedId }, { kind: "agent", id: childId },
    ]);
    assert.throws(() => runAnchors({ session_id: "..\\private" }), /UUID/u);
    assert.throws(() => runAnchors({ attribution: { roots: {} } }), /roots/u);
    const roots = Array.from({ length: 17 }, (_, i) => ({ session_id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}` }));
    assert.throws(() => runAnchors({ attribution: { roots } }), /16-anchor/u);
});

test("nested subagents link by exact tool-call caller; terminal events and stale are independent", () => {
    const projection = eventProjection(sessionId);
    [
        start, event("assistant.turn_start"),
        event("tool.execution_start", { toolCallId: "task-1", arguments: { secret: "not projected" } }),
        child, event("tool.execution_start", { toolCallId: "task-2" }, childId),
        event("subagent.started", { toolCallId: "task-2", agentName: "nested" }, nestedId),
        event("assistant.turn_end", {}, childId), event("subagent.completed", {}, childId),
        event("assistant.turn_end", {}, childId),
        event("assistant.turn_end", {}, undefined, "2026-11-16T12:04:59.000Z"),
    ].forEach(projection.accept);
    const result = projection.finish(now);
    assert.equal(result.agents[0].status, "idle");
    assert.equal(result.agents[0].stale, false);
    assert.equal(result.agents[1].parentId, sessionId);
    assert.equal(result.agents[1].status, "completed");
    assert.equal(result.agents[1].stale, true);
    assert.equal(result.agents[2].parentId, childId);
    assert.equal(result.agents[2].status, "running");
    assert.equal(result.agents[2].stale, true);
    assert.ok(result.agents.every((row) => row.liveness === "not_verified"));
    assert.ok(!JSON.stringify(result).includes("not projected"));
    const csv = agentActivityCsv({ run: "synthetic", asOf: now, status: "observed", notices: ["not live proof"],
        sessions: [{ id: sessionId, ...result }], unknownAnchors: [] });
    assert.equal(csv.records, 3);
    assert.match(csv.content, /"'=Synthetic agent"/u);
    assert.match(csv.content, /NOT_CHECKED/u);
    assert.match(csv.content, /Session-wide activity/u);
});

test("ambiguous and orphan parents stay unknown and mode selections are not subagents", () => {
    const projection = eventProjection(sessionId);
    [start, event("subagent.selected", { agentName: "mode" }, nestedId),
        event("tool.execution_start", { toolCallId: "task-1" }),
        event("tool.execution_start", { toolCallId: "task-1" }, nestedId), child,
    ].forEach(projection.accept);
    const result = projection.finish(now);
    assert.equal(result.agents.length, 2);
    assert.equal(result.agents[1].parentId, null);
    assert.equal(result.agents[1].relationship, "unknown");
});

test("identity mismatch refuses projected agents; shutdown/resume never fabricate child completion", () => {
    const projection = eventProjection(sessionId);
    [start, child, event("session.shutdown")].forEach(projection.accept);
    assert.equal(projection.finish(now).agents[0].status, "stopped");
    assert.equal(projection.finish(now).agents[1].status, "running");
    projection.accept(event("session.resume", {}, undefined, now));
    assert.equal(projection.finish(now).agents[0].status, "unknown");
    projection.accept(event("session.start", { sessionId: nestedId }));
    assert.equal(projection.finish(now).status, "unknown");
    assert.equal(projection.finish(now).agents.length, 0);
    const absent = eventProjection(sessionId);
    absent.accept(child);
    assert.equal(absent.finish(now).status, "unknown");
});

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-agent-test-"));
    t.after(() => fs.rm(root, { force: true, recursive: true }));
    const run = path.join(root, "_runs", "001-synthetic");
    const home = path.join(root, "home");
    const directory = path.join(home, "session-state", sessionId);
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(run, { recursive: true });
    const manifest = { run: 1, unit_key: "synthetic", allocated_dir_name: path.basename(run),
        allocated_abs_path: run, session_id: sessionId, status: "active" };
    await fs.writeFile(path.join(run, "run.json"), JSON.stringify(manifest));
    const log = path.join(directory, "events.jsonl");
    await fs.writeFile(log, [start, child].map(JSON.stringify).join("\n") + "\n");
    const read = (options = {}) => observeAgents(run, { home, now: () => new Date(now), ...options });
    return { root, run, home, directory, manifest, log, read };
}

test("adapter rereads append and truncation without stale cache; never modifies run manifest", async (t) => {
    const { run, log, read } = await fixture(t);
    const before = await fs.readFile(path.join(run, "run.json"), "utf8");
    assert.equal((await read()).sessions[0].agents[1].status, "running");
    await fs.appendFile(log, JSON.stringify(event("subagent.completed", {}, childId, now)) + "\n");
    assert.equal((await read()).sessions[0].agents[1].status, "completed");
    await fs.writeFile(log, JSON.stringify(start) + "\n");
    assert.equal((await read()).sessions[0].agents.length, 1);
    assert.equal(await fs.readFile(path.join(run, "run.json"), "utf8"), before);
});

test("partial final writes warn, malformed completed lines refuse, and size limits are explicit", async (t) => {
    const { log, read } = await fixture(t);
    await fs.appendFile(log, '{"type":');
    let result = await read();
    assert.equal(result.sessions[0].status, "observed");
    assert.match(result.sessions[0].warning, /Incomplete/u);
    await fs.appendFile(log, "\n");
    result = await read();
    assert.equal(result.sessions[0].status, "unknown");
    assert.match(result.sessions[0].reason, /malformed/u);
    assert.match((await read({ maxBytes: 1 })).sessions[0].reason, /read limit/u);
});

test("missing sessions, unsupported anchors and invalid run identity remain visible unknown", async (t) => {
    const { run, log, read, manifest } = await fixture(t);
    await fs.rm(log);
    assert.match((await read()).sessions[0].reason, /unavailable/u);
    delete manifest.session_id;
    manifest.attribution = { roots: [{ agent_id: childId }] };
    await fs.writeFile(path.join(run, "run.json"), JSON.stringify(manifest));
    let result = await read();
    assert.equal(result.unknownAnchors[0].id, childId);
    assert.equal(agentActivityCsv(result).records, 1);
    delete manifest.attribution;
    await fs.writeFile(path.join(run, "run.json"), JSON.stringify(manifest));
    assert.match((await read()).notices.join(" "), /no session or agent/u);
    manifest.allocated_abs_path = path.dirname(run);
    await fs.writeFile(path.join(run, "run.json"), JSON.stringify(manifest));
    result = await read();
    assert.equal(result.sessions.length, 0);
    assert.match(result.notices.join(" "), /identity mismatch/u);
});

test("linked session directories are refused without reading outside session storage", async (t) => {
    const { root, directory, read } = await fixture(t);
    await fs.rm(path.join(directory, "events.jsonl"));
    await fs.rmdir(directory);
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    assert.match((await read()).sessions[0].reason, /Linked/u);
});

test("operations validate run scope, coalesce concurrent reads, return export and never require assessment", async (t) => {
    const { root, run, home } = await fixture(t);
    let reads = 0;
    const ops = new Operations(root, { home, monitor: async (...args) => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return observeAgents(...args);
    } });
    const [first, second] = await Promise.all([ops.call("get_agent_activity", { run }), ops.call("get_agent_activity", { run })]);
    assert.equal(reads, 1);
    assert.equal(first.csv.content, second.csv.content);
    assert.equal(first.sessions[0].agents.length, 2);
    await assert.rejects(ops.call("get_agent_activity", { run: home }), /not registered/u);
    await assert.rejects(ops.call("get_agent_activity", { run, home }), /Unknown input/u);
});
