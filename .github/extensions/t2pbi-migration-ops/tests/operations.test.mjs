import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { Operations, progressRows } from "../operations.mjs";
import { Store, validateSnapshot } from "../store.mjs";
import { observeRun, localDirectory } from "../evidence.mjs";
import { csvCell } from "../common.mjs";
import { startServer } from "../server.mjs";
import { planIdentity } from "../model-planning.mjs";
import { runInNewContext } from "node:vm";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t2pbi-canvas-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const run = path.join(workspace, "_runs", "001-synthetic");
    await fs.mkdir(run, { recursive: true });
    const snapshot = {
        run, asOf: "2026-01-02T03:04:05.000Z",
        assessment: { status: "inventory_observed", issues: [], outputs: [],
            workbooks: [{ name: "Synthetic Book", luid: "source-001", project: "Synthetic Project", tier: "migrate", complexity: 12 }],
            dependencies: [{ workbookName: "Synthetic Book", workbookLuid: "source-001", datasourceName: "Provider", datasourceLuid: "ds-001" }] },
        diagnostic: { exitCode: 0, location: "intact", inventory: "established", certification: "NOT_CHECKED",
            issues: [], nextAction: "Use public readiness check.",
            units: [{ name: "Synthetic Book", kind: "workbook", scope: "scoped", working: "present",
                package: "packages/Synthetic Book", integrity: "clean", reference: "recorded_present",
                storedReadiness: [{ status: "COMPLETE" }] }],
            phases: [{ name: "engine_run", status: "success" }] },
    };
    const home = path.join(root, "private-home");
    const ops = new Operations(workspace, { home, observe: async () => structuredClone(snapshot) });
    const queue = (overrides = {}) => ops.call("queue_batch", {
        run, label: "Synthetic wave", stage: "conversion", keys: ["assessment:source-001"],
        numeric: "required", policy: "stop", ...overrides,
    });
    return { root, workspace, run, snapshot, home, ops, queue };
}

async function mappedFixture(t) {
    const result = await fixture(t);
    result.snapshot.assessment.workbooks = ["a", "b", "c", "d", "e"].map((luid) => ({
        luid, name: `Report ${luid}`, project: "Project", tier: "migrate", complexity: 1,
    }));
    result.snapshot.assessment.dependencies = [["a", "p1"], ["b", "p1"], ["c", "p2"], ["d", "p2"]].map(([workbookLuid, datasourceLuid]) => ({
        workbookLuid, datasourceLuid, workbookName: `Report ${workbookLuid}`, datasourceName: datasourceLuid,
    }));
    await result.ops.call("refresh_run", { run: result.run });
    const plan = {
        schema: "migration-plan/1", style: "faithful", format: "pbip", confirmed: true,
        models: [
            { id: "m1", kind: "shared", providerLuid: "p1", confirmed: true },
            { id: "m2", kind: "shared", providerLuid: "p2", confirmed: true },
            { id: "m3", kind: "standalone", confirmed: true },
        ],
        reports: [["a", "m1"], ["b", "m1"], ["c", "m2"], ["d", "m2"], ["e", "m3"]].map(([luid, modelId]) => ({ luid, modelId })),
    };
    const queuePlan = (value = plan) => result.ops.call("queue_model_plan", {
        run: result.run, label: "Explicit mapping", plan: value, numeric: "required", policy: "stop",
    });
    return { ...result, plan, queuePlan };
}

test("mixed mapping creates three model builds and five exact ordered report handoffs", async (t) => {
    const { ops, plan, queuePlan } = await mappedFixture(t);
    const queued = await queuePlan();
    const providers = queued.batches.filter((batch) => batch.stage === "semantic");
    const reports = queued.batches.filter((batch) => batch.stage === "report");
    assert.equal(providers.length, 3);
    assert.equal(reports.length, 5);
    assert.deepEqual(providers.map((batch) => batch.items[0].sourceLuid), ["p1", "p2", "e"]);
    for (const report of reports) {
        const provider = providers.find((batch) => batch.modelId === report.modelId);
        assert.deepEqual(report.requires, [provider.id]);
        await assert.rejects(ops.call("get_dispatch", { id: report.id }), /operator-reported/u);
        const retained = await fs.readFile(ops.store.file);
        await assert.rejects(ops.call("update_batch", {
            id: report.id, status: "running", sessionId: "operator", note: "Cannot skip provider", evidence: "",
        }), /operator-reported/u);
        assert.deepEqual(await fs.readFile(ops.store.file), retained);
        assert.deepEqual(report.modelPlan, plan);
    }
    for (const provider of providers) {
        await ops.call("update_batch", { id: provider.id, status: "running", sessionId: "operator", note: "Claimed", evidence: "" });
        await ops.call("update_batch", { id: provider.id, status: "finished", sessionId: "operator", note: "Stage only", evidence: "private/model-receipt" });
    }
    for (const report of reports) {
        const dispatch = await ops.call("get_dispatch", { id: report.id });
        assert.match(dispatch.instructions.join("\n"), /operator-reported/u);
        assert.match(dispatch.instructions.join("\n"), /exact mapped semantic model/u);
        assert.doesNotMatch(dispatch.instructions.join("\n"), /ready model|validated model/iu);
    }
});

test("mapping suggestions never confirm choices or alter private tracking", async (t) => {
    const { ops, run, plan, queuePlan } = await mappedFixture(t);
    const before = await fs.readFile(ops.store.file);
    const proposed = await ops.call("get_model_suggestions", { run, luids: ["a", "b", "c", "d", "e"] });
    assert.deepEqual(proposed.map((row) => row.providerLuid), ["p1", "p2"]);
    assert.ok(proposed.every((row) => row.confirmed === false && row.compatibility.startsWith("unknown")));
    assert.deepEqual(await fs.readFile(ops.store.file), before);
    await assert.rejects(queuePlan({ ...plan, confirmed: false }), /Explicitly confirm/u);
    assert.deepEqual(await fs.readFile(ops.store.file), before);
    const reordered = { reports: [...plan.reports].reverse(), models: [...plan.models].reverse(),
        confirmed: true, format: "pbip", style: "faithful", schema: "migration-plan/1" };
    assert.equal(planIdentity(plan), planIdentity(JSON.parse(JSON.stringify(reordered, null, 2))));
});

test("invalid and ambiguous report mappings are rejected atomically", async (t) => {
    const { ops, plan, queuePlan } = await mappedFixture(t);
    const before = await fs.readFile(ops.store.file);
    for (const change of [
        (copy) => { copy.format = "pbix"; },
        (copy) => { copy.reports.push(copy.reports[0]); },
        (copy) => { copy.reports[0].luid = "unknown"; },
        (copy) => { copy.reports[0].modelId = "undeclared"; },
        (copy) => { copy.models[0].providerLuid = "p2"; },
        (copy) => { copy.models[2].id = "$(touch-private)"; },
        (copy) => { copy.models[0].confirmed = false; },
    ]) {
        const copy = structuredClone(plan);
        change(copy);
        await assert.rejects(queuePlan(copy));
        assert.deepEqual(await fs.readFile(ops.store.file), before);
    }
    const queued = await queuePlan();
    const retained = await fs.readFile(ops.store.file);
    await assert.rejects(ops.store.change((state) => {
        const report = state.batches.find((batch) => batch.stage === "report");
        report.requires = [queued.batches.find((batch) => batch.stage === "semantic" && batch.modelId !== report.modelId).id];
    }), /same run, plan and semantic model/u);
    assert.deepEqual(await fs.readFile(ops.store.file), retained);
});

test("supplied models queue report work only and recheck custody at dispatch", async (t) => {
    const { ops, root, plan, queuePlan } = await mappedFixture(t);
    const modelPath = path.join(root, "existing.SemanticModel");
    await fs.mkdir(modelPath);
    await fs.writeFile(path.join(modelPath, "model.bim"), "{}");
    const supplied = { ...plan, models: [{ id: "existing", kind: "supplied", modelPath, confirmed: true }],
        reports: [{ luid: "a", modelId: "existing" }, { luid: "e", modelId: "existing" }] };
    const unavailable = (error) => {
        assert.equal(error.code, "supplied_model_unavailable");
        assert.ok(!error.message.includes(modelPath));
        return true;
    };
    await assert.rejects(queuePlan({ ...supplied, models: [
        { ...supplied.models[0], modelPath: `${modelPath}.missing` },
    ] }), unavailable);
    const queued = await queuePlan(supplied);
    assert.ok(queued.batches.every((batch) => batch.stage === "report" && batch.requires.length === 0));
    const dispatch = await ops.call("get_dispatch", { id: queued.batches[0].id });
    assert.match(dispatch.instructions.join("\n"), /No semantic-builder work/u);
    assert.ok(!JSON.stringify(dispatch).includes(modelPath));
    assert.ok(!JSON.stringify(queued).includes(modelPath));
    assert.ok(!JSON.stringify(await ops.call("get_state", {})).includes(modelPath));
    const claimed = await ops.call("update_batch", {
        id: queued.batches[0].id, status: "running", sessionId: "operator", note: "Read-only model", evidence: "",
    });
    assert.ok(!JSON.stringify(claimed).includes(modelPath));
    assert.ok((await fs.readFile(ops.store.file, "utf8")).includes(modelPath));
    await fs.rename(modelPath, `${modelPath}.retained`);
    await assert.rejects(ops.call("get_dispatch", { id: queued.batches[0].id }), unavailable);
    const retained = await fs.readFile(ops.store.file);
    await assert.rejects(ops.call("update_batch", {
        id: queued.batches[0].id, status: "finished", sessionId: "operator", note: "Cannot finish without custody", evidence: "report-stage",
    }), unavailable);
    assert.deepEqual(await fs.readFile(ops.store.file), retained);
});

test("model plan submit is installed once on initial load and does not depend on assessment submission", async () => {
    const source = await fs.readFile(path.join(repo, ".github/extensions/t2pbi-migration-ops/client.js"), "utf8");
    const handlers = new Map();
    const calls = [];
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, {
            content: "test-token", elements: {
                sourceKind: { value: "project", addEventListener() {} },
                status: { value: "running", addEventListener() {} },
            },
            classList: { toggle() {} }, setAttribute() {},
            addEventListener(name, handler) {
                const key = `${id}:${name}`;
                handlers.set(key, [...handlers.get(key) ?? [], handler]);
            },
        });
        return elements.get(id);
    };
    runInNewContext(source.replace(/^import .+;$/gmu, ""), {
        document: { getElementById: element, querySelector: element, querySelectorAll: () => [] },
        window: {
            fetch(url) { calls.push(url); return new Promise(() => {}); },
            FormData: class { *[Symbol.iterator]() {} },
        },
        createPlanningView: () => ({}), createAgentView: () => ({}),
    });
    const submit = () => ({ currentTarget: {}, preventDefault() {} });
    assert.equal(handlers.get("model-plan-form:submit").length, 1);
    handlers.get("assessment-form:submit")[0](submit());
    handlers.get("assessment-form:submit")[0](submit());
    assert.equal(handlers.get("model-plan-form:submit").length, 1);
    handlers.get("model-plan-form:submit")[0](submit());
    assert.equal(calls.filter((url) => url === "/api/queue_model_plan").length, 1);
});

test("model planning actions are registered in both transports and UI", async () => {
    for (const name of ["queue_model_plan", "get_model_suggestions"]) {
        for (const file of ["extension.mjs", "server.mjs"]) {
            assert.ok((await fs.readFile(path.join(repo, ".github/extensions/t2pbi-migration-ops", file), "utf8")).includes(`"${name}"`));
        }
    }
    const html = await fs.readFile(path.join(repo, ".github/extensions/t2pbi-migration-ops/index.html"), "utf8");
    assert.match(html, /id="model-plan-form"/u);
});

test("model dependency mutation and unsafe supplied custody preserve tracking bytes", async (t) => {
    const { ops, root, run, plan, queuePlan } = await mappedFixture(t);
    const before = await fs.readFile(ops.store.file);
    const within = path.join(run, "supplied");
    await fs.mkdir(within);
    await fs.writeFile(path.join(within, "model.bim"), "{}");
    await fs.writeFile(path.join(root, "model.bim"), "{}");
    const link = path.join(root, "model-link");
    await fs.symlink(within, link);
    for (const modelPath of [within, root, link]) {
        await assert.rejects(queuePlan({
            ...plan, models: [{ id: "supplied", kind: "supplied", modelPath, confirmed: true }],
            reports: [{ luid: "a", modelId: "supplied" }],
        }));
        assert.deepEqual(await fs.readFile(ops.store.file), before);
    }
    await queuePlan();
    const retained = await fs.readFile(ops.store.file);
    for (const change of [
        (state) => { state.batches[0].requires = [state.batches[1].id]; },
        (state) => { state.batches.at(-1).modelPlan.style = "redesign"; },
        (state) => { state.batches.at(-1).requires = []; },
    ]) {
        await assert.rejects(ops.store.change(change));
        assert.deepEqual(await fs.readFile(ops.store.file), retained);
    }
});

test("unknown runs export at any stage without claiming zero-complete", async (t) => {
    const { ops, run } = await fixture(t);
    const state = await ops.call("get_state");
    assert.equal(state.runs[0].path, run);
    assert.equal(state.runs[0].assessment, "not_observed");
    const result = await ops.call("export_csv");
    assert.equal(result.records, 1);
    assert.ok(result.content.startsWith("\uFEFF"));
    assert.match(result.content, /"run_summary"/u);
    assert.match(result.content, /"not_observed"/u);
    assert.match(result.content, /Run not refreshed/u);
    assert.match(result.content, /NOT_CHECKED/u);
    assert.equal(await fs.stat(ops.store.directory).then(() => true, () => false), false);
});

test("refresh saves inventory, stored COMPLETE never becomes current certification", async (t) => {
    const { ops, run } = await fixture(t);
    const result = await ops.call("refresh_run", { run });
    assert.equal(result.snapshot.diagnostic.certification, "NOT_CHECKED");
    assert.equal(result.rows[0].mapping, "name-only candidate; verify");
    assert.equal(result.rows[0].storedReadiness[0].status, "COMPLETE");
    assert.equal(result.rows[0].progress.conversion, "not_reported");
});

test("planning export requires a saved selected-run snapshot and legacy snapshots remain valid", async (t) => {
    const { ops, run, snapshot } = await fixture(t);
    await assert.rejects(ops.call("export_assessment_csv", { run }), /Refresh the selected run/u);
    await ops.call("refresh_run", { run });
    const state = await ops.call("get_state", { run });
    assert.equal(state.assessmentSummary.totals.workbooks, 1);
    assert.equal(state.assessmentSummary.totals.userReferencesUnknown, 1);
    const csv = await ops.call("export_assessment_csv", { run });
    assert.equal(csv.records, 7);
    assert.match(csv.content, /"project_summary"/u);
    assert.match(csv.content, /NOT_CHECKED/u);
    Object.assign(snapshot.assessment, { surveySupplied: null, collectionErrors: [] });
    Object.assign(snapshot.assessment.workbooks[0], {
        projectLuid: "project-1", structureAvailable: true, hasUserReference: false, understated: true,
        signals: { sheets: 1, dashboards: 0, calcs: 1, lods: 0, tableCalcs: 0, viewsLifetime: null },
    });
    await ops.call("refresh_run", { run });
    assert.equal((await ops.call("get_state", { run })).assessmentSummary.totals.understated, 1);
    snapshot.assessment.workbooks[0].signals.lods = -1;
    await assert.rejects(ops.call("refresh_run", { run }), /planning metadata/u);
    assert.equal((await ops.call("get_state", { run })).assessmentSummary.totals.understated, 1);
});

test("missing numeric consent, stale selection and overlapping unfinished batches are rejected", async (t) => {
    const { ops, run, queue } = await fixture(t);
    await assert.rejects(queue(), /Refresh the run/u);
    await ops.call("refresh_run", { run });
    await assert.rejects(queue({ numeric: "" }), /explicit numeric/u);
    await assert.rejects(queue({ keys: ["assessment:unknown"] }), /unknown item/u);
    await assert.rejects(queue({ keys: ["assessment:source-001", "assessment:source-001"] }), /distinct/u);
    await assert.rejects(queue({ keys: ["assessment:source-001", "unit:workbook:Synthetic Book"] }), /not both/u);
    await assert.rejects(queue({ command: "something" }), /Unknown input field/u);
    await queue();
    await assert.rejects(queue(), /unfinished batch/u);
});

test("manual handoff, exclusive session claim, evidence and terminal history persist on reopen", async (t) => {
    const { ops, workspace, home, run, queue } = await fixture(t);
    await ops.call("refresh_run", { run });
    const batch = await queue();
    const dispatch = await ops.call("get_dispatch", { id: batch.id });
    assert.equal(dispatch.batch.status, "queued");
    assert.match(dispatch.instructions.join("\n"), /START_READY AND process exit 0/u);
    assert.match(dispatch.instructions.join("\n"), /MANUAL HANDOFF ONLY/u);
    assert.equal(dispatch.dependencies[0].datasourceLuid, "ds-001");
    const update = (status, sessionId = "real-session-001", evidence = "") =>
        ops.call("update_batch", { id: batch.id, status, sessionId, note: "Synthetic evidence update", evidence });
    await assert.rejects(update("finished"), /evidence reference/u);
    await assert.rejects(update("blocked"), /Cannot move queued/u);
    await update("running");
    await assert.rejects(update("blocked", "different-session"), /another session/u);
    await update("blocked");
    await update("running");
    await update("finished", "real-session-001", "synthetic validator-signoff.json");
    await assert.rejects(update("running"), /Cannot move finished/u);
    await assert.rejects(ops.call("get_dispatch", { id: batch.id }), /terminal/u);
    const reopened = new Operations(workspace, { home });
    const result = await reopened.call("get_state", { run });
    assert.equal(result.batches[0].history.length, 5);
    assert.equal(result.rows[0].progress.conversion, "finished (operator-reported)");
    const csv = await reopened.call("export_csv", { run });
    assert.equal(csv.records, 8);
    assert.match(csv.content, /synthetic validator-signoff.json/u);
    assert.match(csv.content, /real-session-001/u);
    assert.match(csv.content, /"NOT_CHECKED"/u);
    await queue({ label: "Retry after terminal" });
});

test("assessment batches are run-scoped and can be cancelled before claim", async (t) => {
    const { ops, run, queue } = await fixture(t);
    await ops.call("refresh_run", { run });
    await assert.rejects(queue({ stage: "assessment" }), /run-scoped/u);
    const batch = await queue({ stage: "assessment", keys: [] });
    assert.equal(batch.items[0].kind, "run");
    await ops.call("update_batch", { id: batch.id, status: "cancelled", sessionId: "real-session",
        note: "No longer commissioned", evidence: "" });
    const output = await ops.call("export_csv");
    assert.match(output.content, /"cancelled"/u);
});

test("assessment arriving later preserves engine-keyed progress and blocks duplicate dispatch", async (t) => {
    const { ops, run, snapshot, queue } = await fixture(t);
    const workbook = snapshot.assessment.workbooks[0];
    snapshot.assessment.workbooks = [];
    snapshot.assessment.status = "missing";
    await ops.call("refresh_run", { run });
    const batch = await queue({ keys: ["unit:workbook:Synthetic Book"] });
    snapshot.assessment.workbooks = [workbook];
    snapshot.assessment.status = "inventory_observed";
    const refreshed = await ops.call("refresh_run", { run });
    assert.equal(refreshed.rows.find((row) => row.key === "unit:workbook:Synthetic Book").progress.conversion,
        "queued (operator-reported)");
    await assert.rejects(queue(), /unfinished batch/u);
    snapshot.diagnostic.units = [];
    await ops.call("refresh_run", { run });
    await assert.rejects(queue(), /unfinished batch/u);
    await ops.call("update_batch", { id: batch.id, status: "running", sessionId: "real-session",
        note: "Started", evidence: "" });
    await ops.call("update_batch", { id: batch.id, status: "finished", sessionId: "real-session",
        note: "Finished stage", evidence: "synthetic gate result" });
    snapshot.diagnostic.units = [];
    snapshot.assessment.workbooks = [];
    const disappeared = await ops.call("refresh_run", { run });
    const historical = disappeared.rows.find((row) => row.key === "unit:workbook:Synthetic Book");
    assert.equal(historical.scope, "historical");
    assert.equal(historical.progress.conversion, "finished (operator-reported)");
    assert.match((await ops.call("export_csv")).content, /historical selection; not currently observed/u);
});

test("ambiguous names are not joined and unknown/ambiguous engine units cannot be queued", async (t) => {
    const { ops, snapshot, run, queue } = await fixture(t);
    snapshot.assessment.workbooks.push({ ...snapshot.assessment.workbooks[0], luid: "source-002" });
    snapshot.diagnostic.units.push({ ...snapshot.diagnostic.units[0], name: "Unknown", kind: "unknown", scope: "working_copy_only" });
    snapshot.diagnostic.units[0].scope = "ambiguous";
    await ops.call("refresh_run", { run });
    const rows = progressRows(snapshot);
    assert.equal(rows[0].mapping, "ambiguous; not joined");
    assert.equal(rows[0].package, "");
    await assert.rejects(queue({ keys: ["unit:unknown:Unknown"] }), /unknown or ambiguous/u);
    await assert.rejects(queue({ keys: ["unit:workbook:Synthetic Book"] }), /unknown or ambiguous/u);
});

test("external directories must be explicitly registered and workspace state is isolated", async (t) => {
    const { ops, root, home } = await fixture(t);
    const external = path.join(root, "external-run");
    await fs.mkdir(external);
    await assert.rejects(ops.call("get_state", { run: external }), /not registered/u);
    await ops.call("register_run", { run: external });
    assert.ok((await ops.call("get_state")).runs.some((row) => row.path === external));
    const other = new Store(path.join(root, "other-workspace"), home);
    assert.notEqual(other.file, ops.store.file);
    assert.deepEqual((await other.read()).runs, []);
});

test("one-off dashboard/project batches need no run, assessment or snapshot and export before allocation", async (t) => {
    const { ops, workspace, home } = await fixture(t);
    ops.discover = async () => [];
    for (const source of [
        { kind: "dashboard_url", value: "https://tableau.example.test/#/site/demo/views/Book/Dashboard?:iid=1" },
        { kind: "project", value: "Exact Synthetic Project" },
    ]) {
        const batch = await ops.call("queue_source_batch", { label: "One-off", source, numeric: "none", policy: "stop" });
        assert.equal(batch.run, null);
        assert.equal(batch.items[0].kind, "source");
        const dispatch = await ops.call("get_dispatch", { id: batch.id });
        assert.match(dispatch.instructions.join("\n"), /NO PRIOR ASSESSMENT REQUIRED/u);
        if (source.kind === "dashboard_url") assert.match(dispatch.instructions.join("\n"), /NO URL flag/u);
        else assert.match(dispatch.instructions.join("\n"), /--project/u);
    }
    const saved = await ops.store.read();
    assert.deepEqual(saved.runs, []);
    assert.deepEqual(saved.snapshots, {});
    const reopened = new Operations(workspace, { home, discover: async () => [] });
    const state = await reopened.call("get_state");
    assert.equal(state.runs.length, 0);
    assert.equal(state.batches.length, 2);
    const exported = await reopened.call("export_csv");
    assert.equal(exported.records, 4);
    assert.match(exported.content, /"source_request"/u);
    assert.match(exported.content, /"project"/u);
    assert.match(exported.content, /"not_observed"/u);
    assert.match(exported.content, /"NOT_CHECKED"/u);
});

test("one-off source input rejects invalid/credential URLs and missing consent", async (t) => {
    const { ops } = await fixture(t);
    const queue = (source, numeric = "none") => ops.call("queue_source_batch", {
        label: "One-off", source, numeric, policy: "stop",
    });
    for (const value of ["not-a-url", "file:///C:/private/file", "javascript:alert(1)", "https://user:password@example.test/views/A/B",
        "https://example.test/views/A/B?access_token=secret", "https://example.test/#/views/A/B?ticket=secret",
        "https://example.test/views/A/B?accessToken=synthetic-secret",
        "https://example.test/#/views/A/B?clientSecret=synthetic-secret",
        "https://example.test/trusted/synthetic-ticket/views/A/B",
        "https://example.test/base/%74rusted/synthetic-ticket/t/site/views/A/B",
        "https://example.test/#/trusted/synthetic-ticket/views/A/B"]) {
        await assert.rejects(queue({ kind: "dashboard_url", value }));
    }
    await queue({ kind: "dashboard_url", value: "https://example.test/views/trusted/Dashboard?:iid=1" });
    await assert.rejects(queue({ kind: "project", value: "   " }));
    await assert.rejects(queue({ kind: "site", value: "anything" }));
    await assert.rejects(queue({ kind: "project", value: "Synthetic", extra: true }), /Unknown input field/u);
    await assert.rejects(queue({ kind: "project", value: "Synthetic" }, ""), /numeric scope/u);
    await assert.rejects(ops.call("queue_source_batch", {
        label: "One-off", source: { kind: "project", value: "Synthetic" }, policy: "stop",
    }), /Required fields/u);
});

test("one-off scope normalization and duplicate prevention survive attachment", async (t) => {
    const { ops, run, queue } = await fixture(t);
    const request = { label: "One-off", source: { kind: "dashboard_url", value: "HTTPS://TABLEAU.example.test:443/views/A/B" },
        numeric: "required", policy: "stop" };
    const batch = await ops.call("queue_source_batch", request);
    assert.equal(batch.source.value, "https://tableau.example.test/views/A/B");
    await assert.rejects(ops.call("queue_source_batch", { ...request, source: batch.source }), /unfinished one-off/u);
    await assert.rejects(ops.call("attach_batch_run", { id: batch.id, run, sessionId: "owner" }), /Claim an active/u);
    await ops.call("update_batch", { id: batch.id, status: "running", sessionId: "owner", note: "Starting one-off route", evidence: "" });
    await assert.rejects(ops.call("update_batch", {
        id: batch.id, status: "finished", sessionId: "owner", note: "No run yet", evidence: "synthetic output",
    }), /Attach the actual allocated run/u);
    await assert.rejects(ops.call("attach_batch_run", { id: batch.id, run, sessionId: "other" }), /another session/u);
    const attached = await ops.call("attach_batch_run", { id: batch.id, run, sessionId: "owner" });
    assert.equal(attached.run, run);
    assert.equal(attached.history.length, 3);
    assert.equal((await ops.call("attach_batch_run", { id: batch.id, run, sessionId: "owner" })).history.length, 3);
    await assert.rejects(ops.call("queue_source_batch", request), /unfinished one-off/u);
    await assert.rejects(queue(), /unfinished batch/u);
    const exported = await ops.call("export_csv", { run });
    assert.match(exported.content, /https:\/\/tableau.example.test\/views\/A\/B/u);
    assert.doesNotMatch(exported.content, /"source_request"/u);
    await ops.call("update_batch", { id: batch.id, status: "finished", sessionId: "owner",
        note: "One-off stage finished", evidence: "synthetic-signoff.json" });
    await ops.call("queue_source_batch", request);
});

test("one-off attachment rejects unestablished identity, overlaps and run reassignment", async (t) => {
    const { ops, run, snapshot, root, queue } = await fixture(t);
    const batch = await ops.call("queue_source_batch", {
        label: "Project one-off", source: { kind: "project", value: "Synthetic" }, numeric: "none", policy: "stop",
    });
    await ops.call("update_batch", { id: batch.id, status: "running", sessionId: "owner", note: "Starting", evidence: "" });
    snapshot.diagnostic.location = "unverifiable";
    await assert.rejects(ops.call("attach_batch_run", { id: batch.id, run, sessionId: "owner" }), /not intact/u);
    assert.equal((await ops.store.read()).batches[0].run, null);
    snapshot.diagnostic.location = "intact";
    await ops.call("refresh_run", { run });
    const otherBatch = await queue();
    await assert.rejects(ops.call("attach_batch_run", { id: batch.id, run, sessionId: "owner" }), /overlap/u);
    await ops.call("update_batch", { id: otherBatch.id, status: "cancelled", sessionId: "other",
        note: "Replaced by one-off scope", evidence: "" });
    await ops.call("attach_batch_run", { id: batch.id, run, sessionId: "owner" });
    const different = path.join(root, "different-run");
    await fs.mkdir(different);
    await assert.rejects(ops.call("attach_batch_run", { id: batch.id, run: different, sessionId: "owner" }), /different run/u);
});

test("nullable runs/source kinds remain illegal for old batches and malformed source storage is refused", async (t) => {
    const { ops, run, queue } = await fixture(t);
    await ops.call("refresh_run", { run });
    await queue();
    const original = await fs.readFile(ops.store.file, "utf8");
    const invalid = JSON.parse(original);
    invalid.batches[0].run = null;
    await fs.writeFile(ops.store.file, JSON.stringify(invalid));
    await assert.rejects(ops.store.read(), /not overwritten/u);
    invalid.batches[0].source = { kind: "site", value: "invalid" };
    await fs.writeFile(ops.store.file, JSON.stringify(invalid));
    await assert.rejects(ops.store.read(), /not overwritten/u);
    await fs.writeFile(ops.store.file, original);
    assert.equal((await ops.store.read()).batches[0].run, run);
});

test("parallel writers preserve all changes; corrupt state is not overwritten", async (t) => {
    const { ops, workspace, home, run } = await fixture(t);
    const second = new Store(workspace, home);
    await Promise.all([ops.store.change((state) => { state.runs.push(run); }),
        second.change((state) => { state.runs.push(path.join(workspace, "external")); })]);
    assert.equal((await second.read()).runs.length, 2);
    const corrupt = '{"format":"unknown","version":100}';
    await fs.writeFile(second.file, corrupt);
    await assert.rejects(second.change(() => {}), /not overwritten/u);
    assert.equal(await fs.readFile(second.file, "utf8"), corrupt);
    assert.equal(await fs.stat(second.lock).then(() => true, () => false), false);
});

test("corrupt snapshots and histories are refused; abandoned lock is not broken", async (t) => {
    const { ops, run, queue } = await fixture(t);
    await ops.call("refresh_run", { run });
    const batch = await queue();
    const original = await fs.readFile(ops.store.file, "utf8");
    const corrupt = JSON.parse(original);
    corrupt.snapshots[run].diagnostic.certification = "COMPLETE";
    await fs.writeFile(ops.store.file, JSON.stringify(corrupt));
    await assert.rejects(ops.store.read(), /not overwritten/u);
    const history = JSON.parse(original);
    history.batches.find((row) => row.id === batch.id).history = [];
    await fs.writeFile(ops.store.file, JSON.stringify(history));
    await assert.rejects(ops.store.read(), /not overwritten/u);
    await fs.writeFile(ops.store.file, original);
    await fs.mkdir(ops.store.lock);
    await assert.rejects(ops.store.change(() => {}), /store is busy/u);
    assert.equal((await fs.stat(ops.store.lock)).isDirectory(), true);
    await fs.rmdir(ops.store.lock);
});

test("CSV escapes formulas, quotes and multiline cells", () => {
    assert.equal(csvCell('=HYPERLINK("https://example.test")'), '"\'=HYPERLINK(""https://example.test"")"');
    assert.equal(csvCell("  +1"), '"\'  +1"');
    assert.equal(csvCell("\t@x"), '"\'\t@x"');
    assert.equal(csvCell("normal\nnext"), '"normal\nnext"');
    assert.equal(csvCell(null), '""');
});

test("loopback server enforces token, origin, content type and fixed asset routes", async (t) => {
    const { ops, run } = await fixture(t);
    const server = await startServer(ops);
    t.after(() => server.close());
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Migration control room/u);
    const token = html.match(/name="canvas-token" content="([a-f0-9]+)"/u)[1];
    const call = (action, headers = {}, body = "{}") => fetch(`${server.url}/api/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Canvas-Token": token, ...headers }, body,
    });
    assert.equal((await call("get_state")).status, 200);
    assert.equal((await call("get_state", { "X-Canvas-Token": "wrong" })).status, 403);
    assert.equal((await call("get_state", { Origin: "https://example.test" })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
        const req = request(server.url, { headers: { Host: "example.test" } }, (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        req.on("error", reject);
        req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await call("get_state", { "Content-Type": "text/plain" })).status, 400);
    assert.equal((await call("get_state", {}, "{")).status, 400);
    assert.equal((await call("get_state", {}, JSON.stringify({ padding: "x".repeat(70_000) }))).status, 400);
    assert.equal((await fetch(`${server.url}/tracking.json`)).status, 404);
    assert.equal((await fetch(`${server.url}/client.js`)).status, 200);
    assert.equal((await fetch(`${server.url}/planning.js`)).status, 200);
    assert.equal((await call("export_assessment_csv", {}, JSON.stringify({ run }))).status, 400);
    assert.equal((await fetch(`${server.url}/style.css`)).status, 200);
});

async function producerRun(t, changes = {}) {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.run, "assessment"), { recursive: true });
    await fs.mkdir(path.join(f.run, "bundle", "pbip", "Synthetic Book"), { recursive: true });
    await fs.writeFile(path.join(f.run, "run.json"), JSON.stringify({
        run: 1, unit_key: "synthetic", status: "active", allocated_dir_name: path.basename(f.run), allocated_abs_path: f.run,
    }));
    await fs.writeFile(path.join(f.run, "bundle", "report.json"), JSON.stringify({
        workbooks: [{ name: "Synthetic Book" }], datasources: [],
    }));
    const document = {
        workbooks: [{ name: "Synthetic Book", luid: "source-001", project: "Synthetic Project", tier: "migrate", complexity: 12 }],
        dependencies: [], degraded: false, degraded_primary: false, listing_errors: [], ...changes,
    };
    await fs.writeFile(path.join(f.run, "assessment", "assessment.json"), JSON.stringify(document));
    return f;
}

test("real canonical reader and producer-shaped assessment retain non-certifying observations", async (t) => {
    const { run } = await producerRun(t);
    const result = await observeRun(repo, run);
    assert.equal(result.diagnostic.location, "intact");
    assert.equal(result.diagnostic.certification, "NOT_CHECKED");
    assert.equal(result.diagnostic.units[0].working, "present");
    assert.equal(result.assessment.status, "inventory_observed");
    assert.equal(result.assessment.outputs.find((row) => row.name === "estate.db").status, "missing");
    assert.equal(await fs.stat(path.join(run, "__pycache__")).then(() => true, () => false), false);
});

test("real assessment degradation, primary incompleteness, corruption and missing are explicit", async (t) => {
    const { run } = await producerRun(t, { degraded: true, listing_errors: [{ listing: "groups", severity: "secondary" }] });
    assert.equal((await observeRun(repo, run)).assessment.status, "degraded");
    const file = path.join(run, "assessment", "assessment.json");
    const document = JSON.parse(await fs.readFile(file, "utf8"));
    document.degraded_primary = true;
    await fs.writeFile(file, JSON.stringify(document));
    assert.equal((await observeRun(repo, run)).assessment.status, "incomplete");
    await fs.writeFile(file, "{broken");
    const corrupt = await observeRun(repo, run);
    assert.equal(corrupt.assessment.status, "unassessable");
    assert.equal(corrupt.assessment.outputs.filter((row) => row.name === "assessment.json").length, 1);
    await fs.rm(file);
    assert.equal((await observeRun(repo, run)).assessment.status, "missing");
});

test("producer planning metadata preserves tri-state structure evidence and sanitizes error categories", async (t) => {
    const { run } = await producerRun(t, {
        survey_supplied: true, degraded: true,
        listing_errors: [{ listing: "workbook grants: private object name", severity: "secondary", error: "private diagnostic" }],
        workbooks: [{
            name: "Synthetic Book", luid: "source-001", project: "Synthetic Project", project_luid: "project-1",
            tier: "review", complexity: 40, has_user_reference: 0, complexity_understated: 1,
            sheets: 2, dashboards: 1, calcs: 3, lods: 2, table_calcs: 0, views_lifetime: 9,
        }],
    });
    const result = await observeRun(repo, run);
    assert.equal(result.assessment.surveySupplied, true);
    assert.deepEqual(result.assessment.collectionErrors, [{ listing: "workbook grants", severity: "secondary" }]);
    assert.ok(!JSON.stringify(result.assessment).includes("private object name"));
    assert.ok(!JSON.stringify(result.assessment).includes("private diagnostic"));
    const workbook = result.assessment.workbooks[0];
    assert.equal(workbook.structureAvailable, true);
    assert.equal(workbook.hasUserReference, false);
    assert.equal(workbook.understated, true);
    assert.equal(workbook.projectLuid, "project-1");
    assert.equal(workbook.signals.tableCalcs, 0);
    const file = path.join(run, "assessment", "assessment.json");
    const document = JSON.parse(await fs.readFile(file, "utf8"));
    delete document.workbooks[0].has_user_reference;
    delete document.workbooks[0].complexity_understated;
    await fs.writeFile(file, JSON.stringify(document));
    const missing = (await observeRun(repo, run)).assessment.workbooks[0];
    assert.equal(missing.structureAvailable, false);
    assert.equal(missing.hasUserReference, null);
    assert.equal(missing.understated, null);
});

test("damaged run manifest stops child reads and preserves diagnostic nonzero", async (t) => {
    const { run } = await producerRun(t);
    await fs.writeFile(path.join(run, "run.json"), "{}");
    const result = await observeRun(repo, run);
    assert.equal(result.diagnostic.exitCode, 1);
    assert.equal(result.assessment.status, "not_observed");
    assert.equal(result.assessment.outputs.length, 0);
    assert.match(result.assessment.issues[0], /not intact/u);
});

test("optional raw inventories use REST string counts and preserve unknown metadata", async (t) => {
    const { run } = await producerRun(t, { workbooks: [{
        name: "Synthetic Book", luid: "source-001", project: "P", tier: "migrate", complexity: 12,
        updated_at: "2026-01-02T03:04:05Z", created_at: "invalid", size_mb: 0,
        subscriptions: 1, alerts: 0, custom_views: 2,
    }] });
    const raw = path.join(run, "assessment", "raw");
    await fs.mkdir(raw);
    await fs.writeFile(path.join(raw, "views.json"), JSON.stringify([
        { id: "v1", name: "View", workbook: { id: "source-001" }, usage: { totalViewCount: "42" }, updatedAt: "2026-01-01T00:00:00Z" },
        { id: "v2", name: "View", workbook: { id: "source-001" }, usage: { totalViewCount: "0" } },
        { id: "v3", name: "Unlinked", usage: { renamedCount: "9" }, updatedAt: "bad-date" },
        { id: "v4", name: "Invalid count", usage: { totalViewCount: "-3" } },
    ]));
    await fs.writeFile(path.join(raw, "datasources.json"), JSON.stringify([
        { id: "d1", name: "Provider", project: { id: "p", name: "P" }, type: "sql", isCertified: false, hasExtracts: true },
    ]));
    const observed = await observeRun(repo, run);
    const { assessment: a } = observed;
    validateSnapshot(observed, run);
    assert.equal(a.status, "inventory_observed");
    assert.equal(a.workbooks[0].updatedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(a.workbooks[0].createdAt, null);
    assert.equal(a.workbooks[0].sizeMb, 0);
    assert.deepEqual(a.workbooks[0].activity, { subscriptions: 1, alerts: 0, customViews: 2 });
    assert.deepEqual(a.views.rows.map((v) => v.viewsLifetime), [42, 0, null, null]);
    assert.equal(a.views.rows[2].workbookLuid, "");
    assert.equal(a.datasourceInventory.rows[0].certified, false);
    assert.equal(a.datasourceInventory.rows[0].hasExtracts, true);
    assert.match(a.issues.join(" "), /metadata is missing or invalid/u);
    assert.equal(a.outputs.find((o) => o.name === "raw/views.json").status, "present");
    const invalid = structuredClone(observed);
    invalid.assessment.views.rows.push(invalid.assessment.views.rows[0]);
    assert.throws(() => validateSnapshot(invalid, run), /Invalid views explorer inventory/u);
});

test("optional inventory corruption is isolated from valid assessment and other raw inventories", async (t) => {
    const { run } = await producerRun(t);
    const raw = path.join(run, "assessment", "raw");
    await fs.mkdir(raw);
    await fs.writeFile(path.join(raw, "views.json"), "{corrupt");
    await fs.writeFile(path.join(raw, "datasources.json"), "[]");
    let a = (await observeRun(repo, run)).assessment;
    assert.equal(a.status, "inventory_observed");
    assert.equal(a.workbooks.length, 1);
    assert.equal(a.views.status, "unreadable");
    assert.equal(a.datasourceInventory.status, "available");
    assert.match(a.issues.join(" "), /optional inventory is unavailable/u);
    await fs.writeFile(path.join(raw, "views.json"), JSON.stringify([{ renamedId: "v", name: "View" }]));
    a = (await observeRun(repo, run)).assessment;
    assert.equal(a.workbooks.length, 1);
    assert.equal(a.views.status, "unreadable");
    assert.match(a.issues.join(" "), /Invalid or duplicate views identity/u);
    await fs.rm(path.join(raw, "views.json"));
    a = (await observeRun(repo, run)).assessment;
    assert.equal(a.views.status, "missing");
    assert.equal(a.workbooks.length, 1);
    assert.match(a.issues.join(" "), /optional inventory missing/u);
});

test("linked optional raw inventory directory is refused without erasing workbook evidence", async (t) => {
    const { root, run } = await producerRun(t);
    const outside = path.join(root, "outside-raw");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "views.json"), "[]");
    await fs.symlink(outside, path.join(run, "assessment", "raw"), process.platform === "win32" ? "junction" : "dir");
    const a = (await observeRun(repo, run)).assessment;
    assert.equal(a.workbooks.length, 1);
    assert.equal(a.status, "inventory_observed");
    assert.equal(a.views.status, "unreadable");
    assert.equal(a.datasourceInventory.status, "unreadable");
    assert.match(a.issues.join(" "), /Unsafe evidence directory/u);
});

test("linked directories and linked assessment files are refused", async (t) => {
    const { root, run } = await producerRun(t);
    const link = path.join(root, "linked-run");
    await fs.symlink(run, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(localDirectory(link), /Linked/u);
    await fs.rm(path.join(run, "assessment"), { recursive: true });
    const outside = path.join(root, "outside-assessment");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "assessment.json"), "{}");
    await fs.symlink(outside, path.join(run, "assessment"), process.platform === "win32" ? "junction" : "dir");
    const observed = await observeRun(repo, run);
    assert.equal(observed.assessment.status, "unassessable");
    assert.match(observed.assessment.issues.join(" "), /Unsafe evidence directory/u);
});
