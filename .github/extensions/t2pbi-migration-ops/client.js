/* global document, window, navigator, Blob, URL */
import { createPlanningView } from "./planning.js";
import { createAgentView } from "./agents.js";

"use strict";

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="canvas-token"]').content;
let state = { runs: [], batches: [], rows: [], snapshot: null };
let selectedRun = "";
let selectedBatch = null;
const selectedKeys = new Set();
const date = (value) => value ? new Date(value).toLocaleString() : "Not observed";
const label = (value) => String(value).replaceAll("_", " ");

function node(tag, content, className) {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
}

function pill(value) { return node("span", label(value), `pill ${value}`); }

async function api(action, input = {}) {
    const response = await window.fetch(`/api/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
        body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
}

function message(value, error = false) {
    $("message").textContent = value;
    $("message").classList.toggle("error", error);
    $("message").setAttribute("role", error ? "alert" : "status");
}

async function work(task, description) {
    const controls = [...document.querySelectorAll("button, input, select")].filter((control) => !control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    document.querySelector("main").setAttribute("aria-busy", "true");
    if (description) message(description);
    try {
        await task();
    } catch (error) {
        message(error.message, true);
    } finally {
        controls.filter((control) => control.isConnected).forEach((control) => { control.disabled = false; });
        document.querySelector("main").removeAttribute("aria-busy");
        applyAvailability();
    }
}

function tab(id) {
    document.querySelectorAll(".tab-panel").forEach((panel) => { panel.hidden = panel.id !== id; });
    document.querySelectorAll(".nav").forEach((button) => {
        const active = button.dataset.tab === id;
        button.classList.toggle("active", active);
        if (active) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
    });
    agents.activate(id === "agent-activity");
}

function applyAvailability() {
    $("refresh").disabled = !selectedRun;
    $("batch-form").querySelector("button").disabled = !state.snapshot;
    $("model-plan-form").querySelector("button").disabled = !state.snapshot;
    if (selectedBatch) renderBatchDetail();
    planning.applyAvailability();
    agents.applyAvailability();
}

async function load() {
    state = await api("get_state", selectedRun ? { run: selectedRun } : {});
    render();
}

function render() {
    const selector = $("run-select");
    selector.replaceChildren(node("option", state.runs.length ? "Select a run" : "No runs found"));
    selector.firstChild.value = "";
    for (const run of state.runs) {
        const option = node("option", run.name);
        option.value = run.path;
        selector.append(option);
    }
    selector.value = selectedRun;
    const snapshot = state.snapshot;
    $("as-of").textContent = snapshot ? `Observed ${date(snapshot.asOf)} - saved snapshot` : "Not refreshed - evidence unknown";
    $("metric-assessed").textContent = snapshot ? snapshot.assessment.workbooks.length : "\u2014";
    $("metric-assessment-label").textContent = label(snapshot?.assessment.status ?? "not_observed");
    $("metric-generated").textContent = snapshot ? snapshot.diagnostic.units.filter((u) => u.working === "present").length : "\u2014";
    $("metric-packaged").textContent = snapshot ? snapshot.diagnostic.units.filter((u) => u.package).length : "\u2014";
    $("metric-finished").textContent = state.batches.filter((batch) => batch.run === selectedRun && batch.status === "finished").length;
    $("next-action").textContent = snapshot
        ? `Diagnostic exit ${snapshot.diagnostic.exitCode} | Identity: ${snapshot.diagnostic.location} | ${snapshot.diagnostic.nextAction}`
        : "Select a run and refresh its evidence. No completion or liveness is inferred from run allocation metadata.";
    $("workspace-path").textContent = `${state.workspace} | Private tracking: ${state.storage}`;
    $("batch-count").textContent = state.batches.length;
    renderRows();
    renderAssessment();
    renderBatches();
    renderHistory();
    planning.render(state.assessmentSummary);
    agents.selectRun(selectedRun);
    applyAvailability();
}

function visibleRows() {
    const filter = $("filter").value.trim().toLowerCase();
    return state.rows.filter((row) => `${row.name} ${row.project} ${row.kind} ${row.sourceLuid ?? ""}`.toLowerCase().includes(filter));
}

function selectable(row) {
    return row.kind !== "unknown" && !["ambiguous", "historical", "source_request"].includes(row.scope);
}

function renderRows() {
    const body = $("work-rows");
    body.replaceChildren();
    const rows = visibleRows();
    for (const row of rows) {
        const tr = node("tr");
        const checkbox = node("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedKeys.has(row.key);
        checkbox.disabled = !selectable(row);
        checkbox.setAttribute("aria-label", `Select ${row.kind} ${row.name}`);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) selectedKeys.add(row.key);
            else selectedKeys.delete(row.key);
            selection();
        });
        const selectionCell = node("td");
        selectionCell.append(checkbox);
        const identity = node("td");
        identity.append(node("strong", row.name), node("small", `${row.kind} ${row.project ? ` / ${row.project}` : ""}`),
            node("small", row.sourceLuid ?? "Engine inventory; source identity not established"));
        const assessment = node("td");
        assessment.append(node("span", row.tier || "Not recorded"), node("small", `Complexity: ${row.complexity ?? "unknown"}`),
            node("small", row.mapping));
        const generated = node("td");
        generated.append(node("span", label(row.working)), node("small", row.package || "No package observed"),
            node("small", `Integrity: ${row.integrity} | Reference: ${row.reference}`));
        if (row.storedReadiness.length) {
            const details = node("details");
            details.append(node("summary", "Stored gate records (not current certification)"),
                node("small", JSON.stringify(row.storedReadiness)));
            generated.append(details);
        }
        const progress = node("td");
        const recorded = Object.entries(row.progress).filter(([, value]) => value !== "not_reported");
        if (!recorded.length) progress.append(node("small", "No batch progress reported"));
        for (const [stage, value] of recorded) progress.append(node("small", `${stage}: ${value}`));
        tr.append(selectionCell, identity, assessment, generated, progress);
        body.append(tr);
    }
    if (!rows.length) {
        const cell = node("td", state.snapshot ? "No matching work items. Assessment may be missing, incomplete, or empty." : "Refresh the selected run to load its work inventory.");
        cell.colSpan = 5;
        const row = node("tr");
        row.append(cell);
        body.append(row);
    }
    selection();
}

function selection() {
    $("selection-count").textContent = `${selectedKeys.size} selected`;
    const visible = visibleRows().filter(selectable);
    $("select-all").checked = visible.length > 0 && visible.every((row) => selectedKeys.has(row.key));
    $("select-all").indeterminate = visible.some((row) => selectedKeys.has(row.key)) && !$("select-all").checked;
}

function issues(id, entries) {
    $(id).replaceChildren(...entries.map((entry) => node("p", entry, "issue")));
}

function renderAssessment() {
    const snapshot = state.snapshot;
    $("assessment-status").replaceWith(Object.assign(pill(snapshot?.assessment.status ?? "not_observed"), { id: "assessment-status" }));
    $("assessment-outputs").replaceChildren();
    for (const output of snapshot?.assessment.outputs ?? []) {
        const card = node("article", undefined, "output");
        card.append(pill(output.status), node("strong", output.name), node("code", output.path));
        $("assessment-outputs").append(card);
    }
    issues("assessment-issues", snapshot?.assessment.issues ?? ["No assessment snapshot yet."]);
    issues("diagnostic-issues", snapshot?.diagnostic.issues ?? ["No diagnostic snapshot yet."]);
    $("dependency-rows").replaceChildren();
    for (const dependency of snapshot?.assessment.dependencies ?? []) {
        const row = node("tr");
        row.append(node("td", dependency.workbookName), node("td", dependency.datasourceName),
            node("td", `${dependency.workbookLuid || "unknown workbook LUID"} / ${dependency.datasourceLuid || "unknown datasource LUID"}`));
        $("dependency-rows").append(row);
    }
    $("phases").replaceChildren(...(snapshot?.diagnostic.phases ?? []).map((phase) =>
        node("p", `${phase.name}: ${phase.status}`, "muted")));
}

function renderBatches() {
    $("batch-total").textContent = `${state.batches.length} batches`;
    $("batch-list").replaceChildren();
    for (const batch of [...state.batches].reverse()) {
        const card = node("article", undefined, "batch-card");
        const description = node("div");
        description.append(node("strong", batch.label),
            node("p", `${batch.run ? pathName(batch.run) : "Awaiting allocated run"} / ${batch.workflow ?? batch.stage} / ${batch.items.length} item(s) / ${date(batch.updatedAt)}`));
        if (batch.source) description.append(node("p", `${label(batch.source.kind)}: ${batch.source.value}`));
        if (batch.parentAssessmentRun) description.append(node("p", `Parent assessment: ${pathName(batch.parentAssessmentRun)}`
            + (batch.groupId ? ` | Conversion group: ${batch.groupId}` : "")));
        const button = node("button", "Open track", "button secondary");
        button.type = "button";
        button.addEventListener("click", () => {
            selectedBatch = batch.id;
            renderBatchDetail();
            $("batch-detail").scrollIntoView({ behavior: "smooth", block: "start" });
        });
        card.append(pill(batch.status), description, button);
        $("batch-list").append(card);
    }
    if (!state.batches.length) $("batch-list").append(node("p", "No batches yet. Select work items in Batch creation, then approve a batch.", "muted"));
    renderBatchDetail();
}

const pathName = (value) => value.split(/[\\/]/u).at(-1);
function renderBatchDetail() {
    const batch = state.batches.find((candidate) => candidate.id === selectedBatch);
    $("batch-detail").hidden = !batch;
    if (!batch) return;
    $("batch-title").textContent = batch.label;
    $("batch-info").textContent = `${batch.id} | ${batch.run ?? "No run allocated yet"} | ${batch.stage} | ${batch.status}`
        + (batch.source ? ` | ${label(batch.source.kind)}: ${batch.source.value}` : "")
        + (batch.workflow ? ` | ${label(batch.workflow)}` : "")
        + (batch.parentAssessmentRun ? ` | Parent assessment: ${batch.parentAssessmentRun}` : "")
        + (batch.groupId ? ` | Group: ${batch.groupId}` : "");
    const terminal = ["finished", "cancelled"].includes(batch.status);
    $("handoff").value = [
        `Please dispatch approved batch ${batch.id} from canvas t2pbi-migration-ops (manual handoff; not started automatically).`,
        "Use list_canvas_capabilities, open the canvas, then invoke get_dispatch with this batch ID.",
        "Claim using update_batch(running) and your real session ID; follow the returned repository gates and task-tool agent routing.",
        batch.workflow ? [
            `Stage: ${batch.workflow}. Source workbook LUIDs: ${batch.items.map((item) => item.sourceLuid).filter(Boolean).join(", ") || "configured site (API metadata only)"}.`,
            batch.workflow === "api_assessment" ? "No workbook/datasource downloads. Allocate one assessment run and attach_batch_run before finishing."
                : batch.workflow === "artifact_investigation" ? "Only scoped download/parse investigation, including required providers. No conversion. Record discovered requirements and parse/download failures."
                    : "NEW conversion run per workbook; repeats survey/assessment/downloads. No checkpoint reuse. attach_batch_run must NOT use the parent assessment run.",
            batch.run ? "A run is already associated; preserve its identity. Do not allocate again."
                : "No run allocated yet. Follow the stage-specific dispatcher route, then attach_batch_run before finishing.",
            "Follow get_dispatch, not a generic migrator shortcut; API assessment and investigation do not go to @tableau-migrator.",
        ].join("\n") : batch.stage === "assessment" ? "Review existing assessment only; no recollection or migration."
            : batch.run ? "Reuse the exact existing run and bundles. Never rerun or overwrite retained work. Finish by recording evidence via update_batch."
            : "This is a one-off source request with no prior assessment. Resolve the source using the returned single-workbook/scoped-project route, allocate once, and call attach_batch_run before finishing.",
        "If context, credentials, readiness or required intake are missing, stop and ask. Do not equate batch finished with certified COMPLETE.",
    ].join("\n");
    $("copy-handoff").disabled = terminal;
    $("attach-form").hidden = !(batch.source || ["api_assessment", "wave_conversion"].includes(batch.workflow))
        || batch.run !== null || !["running", "blocked"].includes(batch.status);
    $("attach-form").elements.sessionId.value = batch.ownerSession;
    $("event-list").replaceChildren();
    for (const event of batch.history) {
        const entry = node("li");
        entry.append(pill(event.status), node("p", event.note),
            node("small", `${date(event.time)} | ${event.sessionId || "not claimed"} | ${event.evidence || "No evidence reference"}`));
        $("event-list").append(entry);
    }
    const form = $("update-form");
    const allowed = { queued: ["running", "cancelled"], running: ["blocked", "finished", "cancelled"],
        blocked: ["running", "cancelled"], finished: [], cancelled: [] }[batch.status];
    for (const option of form.elements.status.options) option.disabled = !allowed.includes(option.value);
    if (!allowed.includes(form.elements.status.value)) form.elements.status.value = allowed[0] ?? "";
    if (batch.ownerSession) form.elements.sessionId.value = batch.ownerSession;
    form.querySelector("button").disabled = terminal;
    form.elements.evidence.required = form.elements.status.value === "finished";
}

function renderHistory() {
    $("history-rows").replaceChildren();
    for (const run of state.runs) {
        const batches = state.batches.filter((batch) => batch.run === run.path || batch.parentAssessmentRun === run.path);
        const row = node("tr");
        const name = node("td");
        name.append(node("strong", run.name), node("small", run.path));
        const action = node("td");
        const button = node("button", "Inspect run", "button secondary");
        button.type = "button";
        button.addEventListener("click", () => work(async () => {
            selectedRun = run.path;
            selectedKeys.clear();
            await load();
            tab("assessment");
            message("Saved snapshot loaded. Refresh evidence to observe current files.");
        }));
        action.append(button);
        row.append(name, node("td", label(run.assessment)), node("td", date(run.asOf)),
            node("td", `${batches.filter((batch) => batch.status === "finished").length} / ${batches.length} (operator-reported)`), action);
        $("history-rows").append(row);
    }
}

document.querySelectorAll(".nav").forEach((button) => button.addEventListener("click", () => tab(button.dataset.tab)));
$("filter").addEventListener("input", renderRows);
$("select-all").addEventListener("change", () => {
    visibleRows().filter(selectable).forEach((row) => $("select-all").checked ? selectedKeys.add(row.key) : selectedKeys.delete(row.key));
    renderRows();
});
$("run-select").addEventListener("change", () => work(async () => {
    selectedRun = $("run-select").value;
    agents.selectRun(selectedRun);
    selectedKeys.clear();
    await load();
    message("Saved snapshot loaded; refresh evidence for current observations.");
}));
$("refresh").addEventListener("click", () => work(async () => {
    state = await api("refresh_run", { run: selectedRun });
    selectedKeys.clear();
    render();
    message(`Evidence observed ${date(state.snapshot.asOf)}. Diagnostic exit ${state.snapshot.diagnostic.exitCode}; not certification.`);
}, "Reading local run evidence; this can take up to two minutes for large runs. No migration is being launched."));
$("batch-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        input.run = selectedRun;
        input.keys = input.stage === "assessment" ? [] : [...selectedKeys];
        const wave = ["investigation", "wave_conversion"].includes(input.stage);
        const batchSize = Number(input.batchSize);
        delete input.batchSize;
        let count = 1;
        let groups = 1;
        if (wave) {
            input.stage = input.stage === "wave_conversion" ? "conversion" : input.stage;
            const result = await api("queue_wave", { ...input, batchSize });
            selectedBatch = result.batches[0].id;
            count = result.batches.length;
            groups = result.groups;
        } else {
            const batch = await api("queue_batch", input);
            selectedBatch = batch.id;
        }
        await load();
        tab("batches");
        message(wave ? `${count} stage track(s) queued in ${groups} group(s), not running. Manual handoff only; new conversions repeat collection in new runs.`
            : "Batch queued, not running. Copy its dispatcher request into Copilot to hand it off.");
    });
});
$("assessment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        const batch = await api("queue_assessment", input);
        selectedBatch = batch.id;
        await load();
        tab("batches");
        message("API assessment queued before run allocation; no workbook/datasource downloads and no process started.");
    });
});
$("model-plan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        const result = await api("queue_model_plan", { ...input, run: selectedRun });
        selectedBatch = result.batches[0].id;
        await load();
        tab("batches");
        message(`${result.batches.length} model/report handoffs queued, not running. Model mapping remains explicit; host binding checks are still required.`);
    });
});
$("source-form").elements.sourceKind.addEventListener("change", () => {
    const project = $("source-form").elements.sourceKind.value === "project";
    $("source-value-label").firstChild.textContent = project ? "Exact project name or LUID" : "Dashboard URL";
    $("source-value").type = project ? "text" : "url";
    $("source-value").placeholder = project ? "Exact project name or LUID" : "https://tableau.example.com/views/Workbook/Dashboard";
});
$("source-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        const batch = await api("queue_source_batch", {
            label: input.label, source: { kind: input.sourceKind, value: input.value }, numeric: input.numeric, policy: input.policy,
        });
        selectedBatch = batch.id;
        await load();
        tab("batches");
        message("One-off batch queued without assessment. Copy the dispatcher request to start the selected source workflow.");
    });
});
$("attach-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        await api("attach_batch_run", { ...input, id: selectedBatch });
        await load();
        message("Allocated run linked. This is a dispatcher-reported association, not source-scope certification.");
    });
});
$("update-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        await api("update_batch", { ...input, id: selectedBatch });
        await load();
        message("Progress recorded. A finished batch stage is operator-reported, not certified completion.");
    });
});
$("update-form").elements.status.addEventListener("change", () => {
    $("update-form").elements.evidence.required = $("update-form").elements.status.value === "finished";
});
$("copy-handoff").addEventListener("click", () => work(async () => {
    await navigator.clipboard.writeText($("handoff").value);
    message("Dispatcher request copied. Paste it into Copilot to dispatch the approved batch.");
}));
$("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new window.FormData(event.currentTarget));
    work(async () => {
        const result = await api("register_run", input);
        selectedRun = result.run;
        selectedKeys.clear();
        await load();
        message("Existing run registered. Refresh it to inspect evidence.");
    });
});
$("export").addEventListener("click", () => work(async () => {
    if (!$("all-runs").checked && !selectedRun) throw new Error("Select a run or choose Export all runs.");
    const result = await api("export_csv", $("all-runs").checked ? {} : { run: selectedRun });
    downloadCsv(result);
    message(`Exported ${result.records} CSV records. Snapshot timestamps and unknown/unrefreshed runs are included.`);
}));

function downloadCsv(result) {
    const url = URL.createObjectURL(new Blob([result.content], {
        type: result.filename.endsWith(".html") ? "text/html;charset=utf-8" : "text/csv;charset=utf-8",
    }));
    const anchor = node("a");
    anchor.href = url;
    anchor.download = result.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const planning = createPlanningView({
    node, api, work,
    download: (result) => {
        downloadCsv(result);
        message(result.filename.endsWith(".html") ? "Exported private offline assessment HTML report with scope caveats; not certification."
            : `Exported ${result.records} assessment planning CSV records, including evidence caveats.`);
    },
    onSelect: (luids) => {
        selectedKeys.clear();
        luids.forEach((id) => selectedKeys.add(`assessment:${id}`));
        $("filter").value = "";
        renderRows();
        tab("overview");
        message(`${luids.length} assessed workbooks selected for batch creation. Review scope and choose numeric comparison before approving.`);
    },
});

const agents = createAgentView({ node, api, download: downloadCsv });

work(async () => {
    await load();
    selectedRun = [...state.runs].sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? ""))[0]?.path ?? "";
    if (selectedRun) await load();
    message("Ready. Select a run, refresh evidence, then queue a wave for manual dispatcher handoff.");
});
