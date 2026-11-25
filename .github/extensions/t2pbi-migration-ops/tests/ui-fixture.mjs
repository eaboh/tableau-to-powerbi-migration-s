import { promises as fs } from "node:fs";
import path from "node:path";
import { Operations } from "../operations.mjs";
import { startServer } from "../server.mjs";

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("An absolute test-owned fixture directory is required.");
const workspace = path.join(root, "workspace");
const run = path.join(workspace, "_runs", "001-synthetic");
await fs.mkdir(run, { recursive: true });
const external = path.join(root, "external-synthetic-run");
await fs.mkdir(external, { recursive: true });
const snapshot = {
    run, asOf: "2026-01-02T03:04:05.000Z",
    assessment: { status: "inventory_observed", issues: [], outputs: [], surveySupplied: true, collectionErrors: [],
        workbooks: [{
            name: "<Synthetic & safe>", luid: "source-001", project: "Synthetic Project", projectLuid: "project-001",
            tier: "migrate", complexity: 12, structureAvailable: true, hasUserReference: false, understated: true,
            signals: { sheets: 2, dashboards: 1, calcs: 3, lods: 1, tableCalcs: 0, viewsLifetime: 20 },
            updatedAt: "2026-01-02T03:04:05.000Z", createdAt: null, sizeMb: 3,
            activity: { subscriptions: 1, alerts: 0, customViews: 2 },
        }],
        views: { status: "available", rows: [
            { luid: "view-001", name: "<Synthetic view>", workbookLuid: "source-001", viewsLifetime: 19,
                updatedAt: "2026-01-02T03:04:05.000Z" },
            { luid: "view-orphan", name: "Unmatched view", workbookLuid: "unknown-source", viewsLifetime: 1, updatedAt: null },
        ] },
        datasourceInventory: { status: "available", rows: [
            { luid: "provider-001", name: "Shared synthetic provider", project: "Synthetic Project", projectLuid: "project-001",
                updatedAt: "2026-01-02T03:04:05.000Z", connectionType: "sql", certified: true, hasExtracts: false },
            { luid: "unreferenced", name: "Provider without observed edges", project: "Other", projectLuid: "other",
                updatedAt: null, connectionType: "", certified: null, hasExtracts: null },
        ] },
        dependencies: Array.from({ length: 2 }, () => ({
            workbookName: "<Synthetic & safe>", workbookLuid: "source-001",
            datasourceName: "Shared synthetic provider", datasourceLuid: "provider-001",
        })) },
    diagnostic: { exitCode: 0, location: "intact", inventory: "established", certification: "NOT_CHECKED", issues: [],
        nextAction: "Use public readiness check.", units: [], phases: [] },
};
if (process.argv.includes("--planning-scale")) {
    snapshot.assessment.workbooks.push(...Array.from({ length: 100 }, (_, index) => ({
        ...structuredClone(snapshot.assessment.workbooks[0]),
        name: `Synthetic workload ${index + 1}`, luid: `large-source-${index + 1}`,
        project: "Large synthetic project", projectLuid: "project-large", complexity: 40, tier: "review", understated: false,
        updatedAt: index === 0 ? "2025-12-30T23:59:59.000Z" : null,
        activity: { subscriptions: 0, alerts: 0, customViews: 0 },
    })));
}
if (process.argv.includes("--offline-hostile")) {
    snapshot.assessment.workbooks[0].name = '</script><!--<img src="https://external.test/a" onerror="globalThis.injected=true">&\u2028\u2029';
    snapshot.assessment.issues.push("Private diagnostic C:\\private\\evidence.txt token=never-export-this http://127.0.0.1:1234/?token=private");
    snapshot.assessment.views.rows[1].name = "Unmatched view /home/alice/private/estate.db Authorization: Bearer offline-secret";
}
const operations = new Operations(workspace, {
    home: path.join(root, "private-home"),
    observe: async (_workspace, selected) => ({ ...structuredClone(snapshot), run: selected }),
    ...(process.argv.includes("--no-runs") ? { discover: async () => [] } : {}),
});
const sessionId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
await fs.writeFile(path.join(run, "run.json"), JSON.stringify({
    run: 1, unit_key: "synthetic", session_id: sessionId, allocated_dir_name: path.basename(run), allocated_abs_path: run,
}));
const sessionFolder = path.join(root, "private-home", "session-state", sessionId);
await fs.mkdir(sessionFolder, { recursive: true });
await fs.writeFile(path.join(sessionFolder, "events.jsonl"), [
    { type: "session.start", data: { sessionId } },
    { type: "assistant.turn_start", data: {} },
    { type: "tool.execution_start", data: { toolCallId: "synthetic-task" } },
    { type: "subagent.started", agentId, data: { agentDisplayName: "<Synthetic builder>", toolCallId: "synthetic-task" } },
    { type: "assistant.turn_end", data: {} },
].map((row) => JSON.stringify({ ...row, timestamp: "2026-01-02T03:04:05.000Z" })).join("\n") + "\n");
const server = await startServer(operations);
process.stdout.write(JSON.stringify({ url: server.url, run, external }) + "\n");
process.stdin.resume();
process.stdin.on("end", async () => { await server.close(); process.exitCode = 0; });
