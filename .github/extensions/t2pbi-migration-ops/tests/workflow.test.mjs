import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { Script } from "node:vm";
import path from "node:path";
import { Operations } from "../operations.mjs";
import { Store } from "../store.mjs";
import { assessmentHtml, bundlePlanning } from "../assessment-html.mjs";
import { summarizeAssessment } from "../assessment-summary.mjs";
import { filteredPlanningCsv } from "../planning-data.mjs";

async function fixture(t) {
    const root = await fs.mkdtemp(path.resolve("_canvas-tests-workflow-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const run = path.join(root, "workspace", "_runs", "001-assessment");
    const execution = path.join(root, "workspace", "_runs", "002-conversion");
    await fs.mkdir(run, { recursive: true });
    await fs.mkdir(execution, { recursive: true });
    const snapshot = {
        run, asOf: "2026-01-02T03:04:05.000Z",
        assessment: { status: "inventory_observed", issues: [], outputs: [],
            workbooks: Array.from({ length: 101 }, (_, index) => ({
                name: `Workbook ${index}`, luid: `id-${index}`, project: "Project", tier: "review", complexity: null,
            })), dependencies: [
                { workbookName: "Workbook 0", workbookLuid: "id-0", datasourceName: "Provider", datasourceLuid: "ds-0" },
            ] },
        diagnostic: { exitCode: 0, location: "intact", inventory: "established", certification: "NOT_CHECKED",
            issues: [], nextAction: "Use readiness check", units: [], phases: [] },
    };
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const ops = new Operations(workspace, { home, discover: async () => [run, execution],
        observe: async (_workspace, selected) => ({ ...structuredClone(snapshot), run: selected }) });
    const wave = (overrides = {}) => ops.call("queue_wave", {
        run, label: "Wave", stage: "investigation", keys: ["assessment:id-0"], numeric: "required",
        policy: "stop", batchSize: 100, ...overrides,
    });
    const update = (batch, status, extra = {}) => ops.call("update_batch", {
        id: batch.id, status, sessionId: "real-session", note: "Recorded synthetic requirements",
        evidence: status === "finished" ? "private-evidence.json" : "", ...extra,
    });
    return { root, run, execution, snapshot, home, workspace, ops, wave, update };
}

test("API assessment exists before runs; manual contract never delegates assessment to migrator", async (t) => {
    const { ops, run, update } = await fixture(t);
    ops.discover = async () => [];
    assert.equal((await ops.call("get_state")).runs.length, 0);
    const batch = await ops.call("queue_assessment", { label: "Environment", policy: "stop" });
    assert.equal(batch.run, null);
    assert.equal(batch.numeric, "none");
    const dispatch = (await ops.call("get_dispatch", { id: batch.id })).instructions.join("\n");
    assert.match(dispatch, /--assess-only/u);
    assert.match(dispatch, /No workbook\/datasource downloads/u);
    assert.doesNotMatch(dispatch, /Dispatch @tableau-migrator|dispatch @tableau-migrator/u);
    await assert.rejects(ops.call("queue_assessment", { label: "Another", policy: "stop" }), /unfinished/u);
    assert.match((await ops.call("export_csv")).content, /api_assessment/u);
    await update(batch, "running");
    await assert.rejects(update(batch, "finished"), /Attach/u);
    await ops.call("attach_batch_run", { id: batch.id, run, sessionId: "real-session" });
    await update(batch, "finished");
    assert.match((await ops.call("get_state")).batches[0].history.at(-1).note, /requirements/u);
});

test("investigation accepts exactly 1..100 existing IDs and freezes provider-aware scope without conversion", async (t) => {
    const { ops, run, wave, snapshot } = await fixture(t);
    await assert.rejects(wave(), /Refresh/u);
    await ops.call("refresh_run", { run });
    for (const keys of [[], ["assessment:missing"], ["unit:workbook:Workbook 0"],
        ["assessment:id-0", "assessment:id-0"], snapshot.assessment.workbooks.map((w) => `assessment:${w.luid}`)]) {
        await assert.rejects(wave({ keys }), /1\.\.100|exact, unique/u);
    }
    for (const batchSize of [0, 101, 1.5, "2"]) await assert.rejects(wave({ batchSize }), /group size/u);
    const keys = snapshot.assessment.workbooks.slice(0, 100).map((w) => `assessment:${w.luid}`);
    const { batches: [batch] } = await wave({ keys });
    assert.equal(batch.items.length, 100);
    assert.equal(batch.parentAssessmentRun, run);
    assert.equal(batch.run, run);
    await assert.rejects(wave(), /unfinished/u);
    const dispatch = await ops.call("get_dispatch", { id: batch.id });
    assert.equal(dispatch.dependencies.length, 1);
    const contract = dispatch.instructions.join("\n");
    assert.match(contract, /--db <parent-assessment-run>\\assessment\\estate.db/u);
    assert.match(contract, /required published datasource providers/u);
    assert.match(contract, /Exit 0.*NOT parse success/u);
    assert.doesNotMatch(contract, /dispatch @tableau-migrator|START_READY/u);
    snapshot.assessment.workbooks[0].luid = "changed";
    await ops.call("refresh_run", { run });
    assert.equal((await ops.call("get_dispatch", { id: batch.id })).batch.items[0].sourceLuid, "id-0");
    assert.match((await ops.call("export_csv", { run })).content, /artifact_investigation/u);
});

test("conversion grouping is atomic, singleton tracks attach distinct NEW runs without conflating assessment", async (t) => {
    const { ops, run, execution, wave, update, snapshot, home, workspace } = await fixture(t);
    await ops.call("refresh_run", { run });
    const result = await wave({ stage: "conversion", batchSize: 2,
        keys: ["assessment:id-0", "assessment:id-1", "assessment:id-2"] });
    assert.equal(result.groups, 2);
    assert.equal(result.batches.length, 3);
    const [first, second, third] = result.batches;
    assert.equal(first.groupId, second.groupId);
    assert.notEqual(first.groupId, third.groupId);
    assert.ok(result.batches.every((batch) => batch.items.length === 1 && batch.run === null && batch.parentAssessmentRun === run));
    const before = (await ops.call("get_state")).batches.length;
    await assert.rejects(wave({ stage: "conversion", keys: ["assessment:id-3", "assessment:id-0"] }), /unfinished/u);
    assert.equal((await ops.call("get_state")).batches.length, before);
    const contract = (await ops.call("get_dispatch", { id: first.id })).instructions.join("\n");
    assert.match(contract, /REPEATS survey, assessment and downloads/u);
    assert.match(contract, /single frozen workbook LUID: id-0/u);
    assert.match(contract, /START_READY AND process exit 0/u);
    await update(first, "running");
    await assert.rejects(ops.call("attach_batch_run", { id: first.id, run, sessionId: "real-session" }), /parent assessment/u);
    await assert.rejects(ops.call("attach_batch_run", { id: first.id, run: execution, sessionId: "other-session" }), /another session/u);
    snapshot.diagnostic.location = "moved";
    await assert.rejects(ops.call("attach_batch_run", { id: first.id, run: execution, sessionId: "real-session" }), /not intact/u);
    snapshot.diagnostic.location = "intact";
    await ops.call("attach_batch_run", { id: first.id, run: execution, sessionId: "real-session" });
    await update(first, "finished");
    await update(second, "running");
    await assert.rejects(ops.call("attach_batch_run", { id: second.id, run: execution, sessionId: "real-session" }), /another request/u);
    const source = await ops.call("queue_source_batch", { label: "One-off", source: { kind: "project", value: "Exact project" },
        numeric: "none", policy: "stop" });
    await update(source, "running");
    await assert.rejects(ops.call("attach_batch_run", { id: source.id, run: execution, sessionId: "real-session" }), /another request/u);
    const reopened = await new Store(workspace, home).read();
    assert.equal(reopened.batches[0].parentAssessmentRun, run);
    assert.equal(reopened.batches[0].run, execution);
    const csv = await ops.call("export_csv", { run });
    assert.match(csv.content, /"parent_assessment_run","execution_run","group_id"/u);
    assert.match(csv.content, /wave_conversion/u);
    assert.match(csv.content, /Recorded synthetic requirements/u);
    const all = await ops.call("export_csv");
    assert.equal(all.content.split('"batch_event"').length - 1, reopened.batches.reduce((n, batch) => n + batch.history.length, 0));
});

test("legacy v1 queues stay readable and assessment dispatch is review-only", async (t) => {
    const { ops, run, workspace, home } = await fixture(t);
    await ops.call("refresh_run", { run });
    const legacy = await ops.call("queue_batch", { run, label: "Legacy assessment", stage: "assessment",
        keys: [], numeric: "none", policy: "stop" });
    const stored = await new Store(workspace, home).read();
    assert.equal(stored.version, 1);
    assert.equal(stored.batches[0].workflow, undefined);
    const dispatch = (await ops.call("get_dispatch", { id: legacy.id })).instructions.join("\n");
    assert.match(dispatch, /LEGACY ASSESSMENT REVIEW/u);
    assert.doesNotMatch(dispatch, /Dispatch @tableau-migrator/u);
});

test("HTML requires saved available assessment, escapes source strings and omits host paths/raw issues", async (t) => {
    const { ops, run, snapshot } = await fixture(t);
    await assert.rejects(ops.call("export_assessment_html", { run }), /Refresh/u);
    snapshot.assessment.status = "missing";
    await ops.call("refresh_run", { run });
    await assert.rejects(ops.call("export_assessment_html", { run }), /available saved assessment/u);
    snapshot.assessment.status = "degraded";
    snapshot.assessment.issues = ["Secret diagnostic C:\\private\\host\\token.txt"];
    const hostile = '</script><!--<script>alert("x")</script>&\u2028\u2029';
    snapshot.assessment.workbooks[0].name = hostile;
    snapshot.assessment.workbooks[0].project = '<img src="https://external.test/a">';
    snapshot.assessment.dependencies[0].datasourceName = "</td><script>bad()</script>";
    await ops.call("refresh_run", { run });
    const result = await ops.call("export_assessment_html", { run });
    assert.equal(result.filename, "assessment-planning-report.html");
    const data = JSON.parse(result.content.match(/\nconst summary = (.+);\n/u)[1]);
    assert.equal(data.workbooks[0].name, hostile);
    assert.equal(data.workbooks[0].project, '<img src="https://external.test/a">');
    assert.equal(data.datasources[0].name, "</td><script>bad()</script>");
    assert.equal(data.run, undefined);
    assert.match(result.content, /\\u003c\/script\\u003e\\u003c!--/u);
    assert.match(result.content, /\\u0026\\u2028\\u2029/u);
    assert.match(result.content, /Unknown/u);
    assert.match(result.content, /degraded/u);
    assert.match(result.content, /NOT_CHECKED/u);
    assert.match(result.content, /2026-01-02T03:04:05.000Z/u);
    assert.doesNotMatch(result.content, /<img|<link|<iframe|Secret diagnostic|private\\host|_canvas-tests-workflow-/iu);
    assert.equal((result.content.match(/<script\b/gu) ?? []).length, 1);
    const nonce = result.content.match(/script-src 'nonce-([^']+)'/u)[1];
    assert.ok(result.content.includes(`<script type="module" nonce="${nonce}">`));
    assert.match(result.content, /connect-src 'none'.*form-action 'none'/u);
    assert.doesNotMatch(result.content, /(?:src)=["']/iu);
    new Script(bundlePlanning());
    snapshot.assessment.workbooks = [];
    snapshot.assessment.dependencies = [];
    const zero = assessmentHtml(summarizeAssessment(snapshot));
    assert.equal(zero.records, 0);
    assert.match(zero.content, /"workbooks":\[\]/u);
});

test("offline bundle refuses unknown dependencies and unsupported syntax", () => {
    const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const replacement of ['import { nope } from "./node-only.mjs";',
        'import "./side-effect.mjs";', 'const request = import("https://external.test/module.js");',
        "export default 1;"]) {
        assert.throws(() => bundlePlanning((file) => file === "csv.mjs" ? replacement : source(file)),
            /Unsupported offline/u);
    }
});

test("offline data and local CSV redact metadata paths, URL credentials and complete authorization values", async (t) => {
    const { snapshot } = await fixture(t);
    const privateLabels = [
        "/home/alice/private/estate.db", "C:\\private\\estate.db", "\\\\private\\share\\estate.db",
        "http://user:password@127.0.0.1:8765/?access_token=offline-access",
        "http://[::1]:8765/private", "http://2130706433:8765/private",
        "https://external.test/a?access_token=offline-access", "https://user:password@external.test/a",
        "Authorization: Bearer offline-secret", 'password="two word secret"',
        "client_secret=client-credential", "db_password=database-credential",
        "file:/home/alice/estate.db", "C:\\Users\\Alice Smith\\private\\estate.db",
        "/home/Alice Smith/private/estate.db",
        '{"access_token":"quoted-private-token"}', '{"client_secret": "quoted-private-secret"}',
    ];
    snapshot.assessment.workbooks = privateLabels.map((name, index) => ({
        ...snapshot.assessment.workbooks[index], name,
    }));
    const original = summarizeAssessment(snapshot);
    const result = assessmentHtml(original);
    const data = JSON.parse(result.content.match(/\nconst summary = (.+);\n/u)[1]);
    const csv = filteredPlanningCsv(data, data.workbooks, data.views, {}, { type: "all", key: "" }).content;
    for (const secret of ["alice", "estate.db", "private\\\\share", "127.0.0.1", "8765",
        "2130706433", "offline-access", "offline-secret", "two word secret", "user:password",
        "client-credential", "database-credential", "Smith", "Alice", "quoted-private-token", "quoted-private-secret"]) {
        assert.ok(!result.content.includes(secret), `HTML leaked ${secret}`);
        assert.ok(!csv.includes(secret), `Local CSV leaked ${secret}`);
    }
    assert.equal(original.workbooks[0].name, privateLabels[0], "Export must not mutate interactive data");
});
