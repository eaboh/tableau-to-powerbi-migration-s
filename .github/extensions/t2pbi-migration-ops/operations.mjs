import path from "node:path";
import { randomUUID } from "node:crypto";
import { fields, requireThat, text, stages, toCsv, sourceScope, sourceItem } from "./common.mjs";
import { discoverRuns, localDirectory, observeRun } from "./evidence.mjs";
import { Store, validateSnapshot } from "./store.mjs";
import { summarizeAssessment, assessmentSummaryCsv } from "./assessment-summary.mjs";
import { observeAgents, agentActivityCsv } from "./agent-monitor.mjs";
import { active, assessmentRun, needsAllocatedRun, workflowDispatch } from "./workflow.mjs";
import { assessmentHtml } from "./assessment-html.mjs";
import { promises as fs } from "node:fs";
import { planIdentity, validateObservedPlan, suggestions, requireProviderProgress, publicBatch } from "./model-planning.mjs";
import { categories, overridable, currentBlock, currentApproval, requireFallbackAuthority, fallbackBinding, safeReason } from "./continuation.mjs";

const transitions = {
    queued: ["running", "cancelled"],
    running: ["blocked", "finished", "cancelled"],
    blocked: ["running", "cancelled"],
    finished: [],
    cancelled: [],
};
const unitKey = (unit) => `unit:${unit.kind}:${unit.name}`;

export function progressRows(snapshot, batches = []) {
    if (!snapshot) return [];
    const assessed = snapshot.assessment.workbooks;
    const units = snapshot.diagnostic.units;
    const rows = assessed.map((workbook) => {
        const sameName = units.filter((unit) => unit.kind === "workbook" && unit.name === workbook.name);
        const unique = sameName.length === 1 && assessed.filter((row) => row.name === workbook.name).length === 1;
        return {
            key: `assessment:${workbook.luid}`, name: workbook.name, kind: "workbook", sourceLuid: workbook.luid,
            scope: "assessed_source",
            project: workbook.project, tier: workbook.tier, complexity: workbook.complexity,
            mapping: unique ? "name-only candidate; verify" : sameName.length ? "ambiguous; not joined" : "unmatched",
            unit: unique ? sameName[0] : null,
        };
    });
    for (const unit of units) {
        rows.push({ key: unitKey(unit), name: unit.name, kind: unit.kind, sourceLuid: null, scope: unit.scope,
            project: "", tier: "", complexity: null, mapping: "engine inventory only", unit });
    }
    for (const batch of batches.filter((b) => b.run === snapshot.run)) {
        for (const item of batch.items) {
            if (item.kind !== "run" && !rows.some((row) => row.key === item.key)) {
                rows.push({ ...item, scope: item.kind === "source" ? "source_request" : "historical",
                    project: "", tier: "", complexity: null,
                    mapping: item.kind === "source" ? "one-off scope; unit mapping not established"
                        : "historical selection; not currently observed", unit: null });
            }
        }
    }
    return rows.map(({ unit, ...row }) => {
        const progress = {};
        for (const stage of stages) {
            const batch = batches.filter((b) => assessmentRun(b) === snapshot.run && b.stage === stage
                && b.items.some((item) => item.key === row.key)).at(-1);
            progress[stage] = batch ? `${batch.status} (operator-reported)` : "not_reported";
        }
        return {
            ...row, working: unit?.working ?? "not_observed", package: unit?.package ?? "",
            integrity: unit?.integrity ?? "not_observed", reference: unit?.reference ?? "not_observed",
            storedReadiness: unit?.storedReadiness ?? [], progress,
        };
    });
}

export class Operations {
    constructor(workspace, { home, observe = observeRun, discover = discoverRuns, monitor = observeAgents } = {}) {
        this.workspace = workspace;
        this.store = new Store(workspace, home);
        this.observe = observe;
        this.discover = discover;
        this.monitor = monitor;
        this.monitorHome = home;
        this.agentReads = new Map();
    }

    async knownRuns(state) {
        return [...new Set([...(await this.discover(this.workspace)), ...state.runs, ...Object.keys(state.snapshots)])].sort().reverse();
    }

    async selectedRun(input, state) {
        requireThat(text(input) && path.isAbsolute(input), "Select an absolute run path.");
        const known = await this.knownRuns(state);
        requireThat(known.includes(input), "Run is not registered. Register external runs explicitly.");
        return input;
    }

    async call(action, input = {}) {
        switch (action) {
            case "get_state": return this.getState(input);
            case "get_agent_activity": {
                fields(input, ["run"]);
                const state = await this.store.read();
                const run = await this.selectedRun(input.run, state);
                if (!this.agentReads.has(run)) {
                    this.agentReads.set(run, Promise.resolve().then(() => this.monitor(run, { home: this.monitorHome }))
                        .finally(() => this.agentReads.delete(run)));
                }
                const observation = await this.agentReads.get(run);
                return { ...observation, csv: agentActivityCsv(observation) };
            }
            case "register_run": return this.register(input);
            case "refresh_run": return this.refresh(input);
            case "queue_batch": return this.queue(input);
            case "queue_source_batch": return this.queueSource(input);
            case "queue_assessment": return this.queueAssessment(input);
            case "queue_wave": return this.queueWave(input);
            case "queue_model_plan": return this.queueModelPlan(input);
            case "get_model_suggestions": {
                fields(input, ["run", "luids"]);
                const state = await this.store.read();
                await this.selectedRun(input.run, state);
                return suggestions(state.snapshots[input.run], input.luids);
            }
            case "attach_batch_run": return this.attach(input);
            case "get_dispatch": return this.dispatch(input);
            case "request_continuation": return this.requestContinuation(input);
            case "approve_continuation": return this.approveContinuation(input);
            case "update_batch": return this.update(input);
            case "export_csv": return this.export(input);
            case "export_assessment_csv": {
                fields(input, ["run"]);
                const state = await this.store.read();
                await this.selectedRun(input.run, state);
                requireThat(state.snapshots[input.run], "Refresh the selected run before exporting its assessment summary.");
                return assessmentSummaryCsv(summarizeAssessment(state.snapshots[input.run]));
            }
            case "export_assessment_html": {
                fields(input, ["run"]);
                const state = await this.store.read();
                await this.selectedRun(input.run, state);
                const snapshot = state.snapshots[input.run];
                requireThat(snapshot, "Refresh the selected run before exporting its assessment report.");
                const summary = summarizeAssessment(snapshot);
                // Raw producer issues may contain local paths or authentication diagnostics.
                summary.notices = summary.notices.filter((notice) => !snapshot.assessment.issues.includes(notice));
                return assessmentHtml(summary, { issueCount: snapshot.assessment.issues.length });
            }
            default: requireThat(false, "Unknown action.");
        }
    }

    async getState(input) {
        fields(input, ["run"], []);
        const state = await this.store.read();
        const paths = await this.knownRuns(state);
        if (input.run !== undefined) await this.selectedRun(input.run, state);
        const snapshot = state.snapshots[input.run] ?? null;
        return {
            workspace: this.workspace, storage: this.store.file,
            runs: paths.map((run) => ({
                path: run, name: path.basename(run), asOf: state.snapshots[run]?.asOf ?? null,
                assessment: state.snapshots[run]?.assessment.status ?? "not_observed",
            })),
            snapshot, rows: progressRows(snapshot, state.batches), batches: state.batches.map(publicBatch),
            assessmentSummary: summarizeAssessment(snapshot),
        };
    }

    async register(input) {
        fields(input, ["run"]);
        const run = await localDirectory(input.run);
        await this.store.change((state) => {
            if (!state.runs.includes(run)) state.runs.push(run);
        });
        return { run };
    }

    async refresh(input) {
        fields(input, ["run"]);
        const run = await this.selectedRun(input.run, await this.store.read());
        const snapshot = await this.observe(this.workspace, run);
        validateSnapshot(snapshot, run);
        await this.store.change((state) => { state.snapshots[run] = snapshot; });
        return this.getState({ run });
    }

    async queue(input) {
        fields(input, ["run", "label", "stage", "keys", "numeric", "policy"]);
        requireThat(text(input.label, 120) && stages.includes(input.stage)
            && input.stage !== "investigation"
            && ["none", "required"].includes(input.numeric) && ["stop", "degrade"].includes(input.policy),
        "Provide a label, valid stage, explicit numeric scope (none|required), and stop/degrade policy.");
        requireThat(Array.isArray(input.keys) && input.keys.length <= 100
            && input.keys.every((key) => text(key)) && new Set(input.keys).size === input.keys.length,
        "Select at most 100 distinct work items.");
        await this.selectedRun(input.run, await this.store.read());
        return this.store.change((state) => {
            const snapshot = state.snapshots[input.run];
            requireThat(snapshot, "Refresh the run before queuing work.");
            const rows = progressRows(snapshot);
            let items;
            if (input.stage === "assessment") {
                requireThat(input.keys.length === 0, "Assessment batches are run-scoped; clear unit selection.");
                items = [{ key: "run", name: path.basename(input.run), kind: "run", sourceLuid: null }];
            } else {
                requireThat(input.keys.length > 0, "Select work items for this batch.");
                items = input.keys.map((key) => {
                    const row = rows.find((candidate) => candidate.key === key);
                    requireThat(row, "Selection changed or contains an unknown item. Refresh and reselect.");
                    requireThat(row.kind !== "unknown" && row.scope !== "ambiguous",
                        "Resolve unknown or ambiguous unit identities before queuing them.");
                    return { key, name: row.name, kind: row.kind, sourceLuid: row.sourceLuid };
                });
            }
            const conflicts = (left, right) => {
                if (left.key === right.key) return true;
                if (left.kind !== "workbook" || right.kind !== "workbook" || left.name !== right.name) return false;
                return left.key.startsWith("assessment:") !== right.key.startsWith("assessment:");
            };
            requireThat(!items.some((item, index) => items.slice(index + 1).some((candidate) => conflicts(item, candidate))),
                "Select either the assessment or engine row for a workbook, not both name-only counterparts.");
            requireThat(!state.batches.some((batch) => assessmentRun(batch) === input.run && batch.stage === input.stage
                && ["queued", "running", "blocked"].includes(batch.status)
                && (batch.source || batch.items.some((item) => items.some((candidate) => conflicts(item, candidate))))),
            "An unfinished batch already contains this work or its name-only counterpart at this stage. Resolve identity before redispatch.");
            const now = new Date().toISOString();
            const batch = {
                id: randomUUID(), run: input.run, label: input.label, stage: input.stage, items,
                numeric: input.numeric, policy: input.policy, status: "queued", ownerSession: "",
                createdAt: now, updatedAt: now,
                history: [{ status: "queued", time: now, note: "Approved for manual dispatcher handoff; not started.",
                    evidence: "", sessionId: "" }],
            };
            state.batches.push(batch);
            return batch;
        });
    }

    async queueAssessment(input) {
        fields(input, ["label", "policy"]);
        requireThat(text(input.label, 120) && ["stop", "degrade"].includes(input.policy),
            "Provide an assessment label and stop/degrade policy.");
        return this.store.change((state) => {
            requireThat(!state.batches.some((batch) => batch.workflow === "api_assessment" && active(batch)),
                "An unfinished API assessment already exists. Finish or cancel it before queuing another.");
            const batch = this.newWorkflow({
                label: input.label, policy: input.policy, numeric: "none", stage: "assessment",
                workflow: "api_assessment", run: null,
                items: [{ key: "run", name: "Configured Tableau site (API metadata only)", kind: "run", sourceLuid: null }],
            });
            state.batches.push(batch);
            return batch;
        });
    }

    newWorkflow(scope) {
        const now = new Date().toISOString();
        return { ...scope, id: randomUUID(), status: "queued", ownerSession: "", createdAt: now, updatedAt: now,
            history: [{ status: "queued", time: now, sessionId: "", evidence: "",
                note: "Approved manual stage handoff; no process started. Source scope and findings are not certified." }] };
    }

    async queueWave(input) {
        fields(input, ["run", "label", "stage", "keys", "numeric", "policy", "batchSize"]);
        requireThat(text(input.label, 120) && ["investigation", "conversion"].includes(input.stage)
            && ["none", "required"].includes(input.numeric) && ["stop", "degrade"].includes(input.policy)
            && Number.isSafeInteger(input.batchSize) && input.batchSize >= 1 && input.batchSize <= 100,
        "Provide a label, wave stage, explicit numeric scope, policy and conversion group size 1..100.");
        requireThat(Array.isArray(input.keys) && input.keys.length >= 1 && input.keys.length <= 100
            && input.keys.every((key) => text(key)) && new Set(input.keys).size === input.keys.length,
        "Select 1..100 distinct assessed workbook keys; selection is never truncated.");
        await this.selectedRun(input.run, await this.store.read());
        return this.store.change((state) => {
            const snapshot = state.snapshots[input.run];
            requireThat(snapshot, "Refresh the assessment run before selecting a wave.");
            const items = input.keys.map((key) => {
                const matches = snapshot.assessment.workbooks.filter((workbook) => `assessment:${workbook.luid}` === key);
                requireThat(matches.length === 1, "Wave selection must contain exact, unique existing assessed workbook LUIDs only.");
                return { key, kind: "workbook", name: matches[0].name, sourceLuid: matches[0].luid };
            });
            requireThat(!state.batches.some((batch) => active(batch) && assessmentRun(batch) === input.run
                && batch.stage === input.stage && (batch.source || batch.items.some((item) =>
                    items.some((candidate) => candidate.key === item.key
                        || (!batch.workflow && item.kind === "workbook" && item.name === candidate.name))))),
            "An unfinished batch already contains this work at this stage. Resolve it before redispatch.");
            const batches = [];
            if (input.stage === "investigation") {
                batches.push(this.newWorkflow({ label: input.label, stage: input.stage, numeric: input.numeric,
                    policy: input.policy, workflow: "artifact_investigation", run: input.run,
                    parentAssessmentRun: input.run, items }));
            } else {
                let groupId;
                items.forEach((item, index) => {
                    if (index % input.batchSize === 0) groupId = randomUUID();
                    batches.push(this.newWorkflow({ label: `${input.label.slice(0, 110)} ${index + 1}/${items.length}`,
                        stage: input.stage, numeric: input.numeric, policy: input.policy, workflow: "wave_conversion",
                        run: null, parentAssessmentRun: input.run, groupId, items: [item] }));
                });
            }
            state.batches.push(...batches);
            return { batches, groups: new Set(batches.map((batch) => batch.groupId ?? batch.id)).size };
        });
    }

    async dispatch(input) {
        fields(input, ["id"]);
        requireThat(text(input.id), "A batch ID is required.");
        const state = await this.store.read();
        const batch = state.batches.find((row) => row.id === input.id);
        requireThat(batch, "Batch not found.");
        requireThat(["queued", "running", "blocked"].includes(batch.status), "Batch is terminal; it cannot be dispatched.");
        const snapshot = state.snapshots[assessmentRun(batch)];
        if (currentBlock(batch) && batch.status === "blocked") {
            requireThat(currentApproval(batch)?.mode === "continue",
                "Record a fresh human continuation decision, or repair and recheck the protected operation.");
        }
        if (batch.fallback) {
            requireFallbackAuthority(batch, state.batches.find((row) => row.id === batch.fallback.parentId));
            const model = batch.modelPlan.models[0];
            await fallbackBinding(batch.run, batch.fallback.reportPath, model.modelPath);
            return { batch: publicBatch(batch), instructions: [
                "APPROVED REPORT-ONLY FALLBACK, manual handoff only. Claim with your real owning session.",
                "Dispatch pbi-report-builder directly for the exact private report/model paths in host tracking. No semantic-builder work, validator triage, acquisition/conversion rerun or replacement model.",
                "Recheck current byPath binding, model/schema/field validity and physical custody immediately before use. Keep the supplied model read-only; never rebind automatically.",
                "No warm cache is required for supported static/layout authoring. Respect actual tool support and refusals; no data render/fidelity claim.",
                "Keep the package/oracle blockers and evidence ceilings. This approval covers only this trigger, not later blockers.",
                "Retain independent validation and all unresolved findings. Finished is operator-reported report progress, never COMPLETE or data fidelity.",
            ] };
        }
        if (batch.modelPlan) {
            const model = batch.modelPlan.models.find((row) => row.id === batch.modelId);
            if (model.kind === "supplied") await this.suppliedModel(model.modelPath, batch.run);
            for (const required of batch.requires) {
                const provider = state.batches.find((row) => row.id === required);
                requireProviderProgress(provider);
            }
            const safePlan = publicBatch(batch).modelPlan;
            return {
                batch: publicBatch(batch), observedAt: snapshot?.asOf ?? null,
                instructions: [
                    "MANUAL HANDOFF ONLY; provider progress is operator-reported, never certified model readiness.",
                    `Explicit migration style: ${safePlan.style}; artifact format: ${safePlan.format}; model identity: ${model.id}.`,
                    "Claim this batch with the real dispatcher session. Recheck source identity, current working artifacts and field/security compatibility on the actual host.",
                    ...(batch.stage === "semantic" ? [
                        "Dispatch pbi-semantic-builder once for this generated model using this exact source and all mapped report contracts. Do not build another model per report.",
                    ] : [
                        "Dispatch pbi-report-builder for this report, bound to the exact mapped semantic model identity. Validate its supported local model binding before writing.",
                        ...(model.kind === "supplied" ? [
                            "No semantic-builder work. Resolve the supplied model locator from private host tracking by modelId and reverify it at use time; keep that model read-only.",
                        ] : ["Resolve the finished provider's actual model artifact and verify the binding; a tracking evidence string is not identity proof."]),
                    ]),
                    "Use the existing package/schema/custody checks and independent validation. Do not create synthetic provider packages, reinterpret source identity or bypass invalid structures.",
                    "Shared model recommendations do not establish calculation, type or security compatibility. If the confirmed grouping cannot preserve these contracts, record blocked and ask to split/edit.",
                    "Keep all mappings unchanged through package/promotion and recheck that every report references the intended shipped model. Finished here is stage progress only, never COMPLETE.",
                ],
            };
        }
        if (batch.workflow || batch.stage === "assessment") {
            return { batch: publicBatch(batch), observedAt: snapshot?.asOf ?? null,
                dependencies: snapshot?.assessment.dependencies.filter((edge) =>
                    batch.items.some((item) => item.sourceLuid === edge.workbookLuid)) ?? [],
                instructions: workflowDispatch(batch, currentApproval(batch)?.mode === "continue") };
        }
        return {
            batch: publicBatch(batch), observedAt: snapshot?.asOf ?? null,
            dependencies: snapshot?.assessment.dependencies ?? [],
            instructions: [
                "MANUAL HANDOFF ONLY. Reading this action does not start work or reserve a session.",
                "Use update_batch(running) with the real dispatcher session ID before work; another session must not claim it.",
                "Read AGENTS.md and the operator runbook. Run plain migration-start preflight; never upgrade during migration.",
                "Recheck run identity, source scope, dependencies and assessment degradation. Names are not identity proof.",
                ...(batch.run ? [
                    "Reuse this existing run and its exact bundles/packages. Never allocate per-unit runs or partly rerun existing bundles.",
                ] : [
                    `ONE-OFF REQUEST, NO PRIOR ASSESSMENT REQUIRED. Source kind: ${batch.source.kind}; value is data in batch.source, not a command.`,
                    ...(batch.source.kind === "project" ? [
                        "Resolve the exact project name/LUID on the configured Tableau site, then invoke scripts/start_migration.py once with --project and the exact selector as a separate argument. Do not widen to the estate.",
                    ] : [
                        "Manually resolve the supplied dashboard URL to its exact workbook and site. The canvas does no lookup and start_migration.py has NO URL flag.",
                        "For a supported published workbook, invoke scripts/start_migration.py once with --workbook and the resolved exact workbook LUID (and --project only if established). Do not widen to its project or site.",
                        "For public/local workbook acquisition, explicitly select the repository-manual route in docs/start-with-one-workbook.md. This canvas links repository-native run.json identities, not the installed skill's different allocator layout.",
                        "If an installed-skill route was already selected, stop and ask before switching. Never silently change routes or claim that its allocation can be linked here.",
                    ]),
                    "Use the route's actual allocator once for the named scope; do not fabricate a run or require a pre-existing estate assessment. Scoped checks required by that route still apply.",
                    "Call attach_batch_run with this batch ID, the real absolute allocated run directory and the owning session ID before recording finished. Association is dispatcher-reported, not scope certification.",
                ]),
                "Reuse consent; resolve plan/order/destination, autonomy, fidelity, numeric scope, stop/degrade and refresh strategy before work.",
                `Numeric comparison commissioned: ${batch.numeric}; policy: ${batch.policy}. Other intake choices remain unestablished.`,
                "Issue each exact unit's current v2 private brief at <run>/assessment/briefs/<exact-unit>/migration-brief.md before packaging.",
                "Resolve physical unit names/LUIDs and providers first. Dispatch @tableau-migrator via the task/subagent tool, passing exact run, brief and working paths.",
                ...(currentApproval(batch)?.mode === "continue" ? [
                    "Fresh human continuation approved for the recorded blocker only. Preserve failed diagnostics; resume this exact run and owned stage with explicit unverified scope.",
                    "Readiness/quality/cache evidence is not an entry halt under this approval. Structural/custody/privacy/authorization/tool refusals still prohibit the affected operation.",
                ] : ["Require current package-cohort START_READY AND process exit 0, or request an explicit per-blocker human continuation before authoring."]),
                "TMDL/DAX belongs to pbi-semantic-builder; PBIR to pbi-report-builder; validator is read-only.",
                "Credential/dialog refusal: stop and ask a human. Toolkit/engine gate defect: stop, route and ask; never patch silently.",
                "Independent @pbi-migration-validator comparison on shipped bytes with data and the final check are required for completion.",
                "Promotion only after sign-off; deployment requires separate explicit agreement. This queue never grants deployment consent.",
                "Record blocked/finished with evidence references via update_batch. Finished means operator-reported batch stage only, never certified COMPLETE.",
            ],
        };
    }

    async update(input) {
        fields(input, ["id", "status", "sessionId", "note", "evidence"]);
        requireThat(text(input.id) && text(input.sessionId, 200) && text(input.note)
            && typeof input.evidence === "string" && input.evidence.length <= 2048,
        "Batch ID, real session ID, note and an evidence reference field are required.");
        requireThat(["running", "blocked", "finished", "cancelled"].includes(input.status), "Invalid transition status.");
        if (input.status === "finished") requireThat(text(input.evidence), "Finished stages require an evidence reference.");
        return this.store.change(async (state) => {
            const batch = state.batches.find((row) => row.id === input.id);
            requireThat(batch, "Batch not found.");
            if (batch.fallback && ["running", "finished"].includes(input.status)) {
                requireFallbackAuthority(batch, state.batches.find((row) => row.id === batch.fallback.parentId));
                batch.fallbackEvidence = await fallbackBinding(batch.run, batch.fallback.reportPath, batch.modelPlan.models[0].modelPath);
            }
            if (batch.modelPlan && ["running", "finished"].includes(input.status)) {
                const model = batch.modelPlan.models.find((row) => row.id === batch.modelId);
                if (model.kind === "supplied") await this.suppliedModel(model.modelPath, batch.run);
            }
            requireThat(transitions[batch.status].includes(input.status), `Cannot move ${batch.status} to ${input.status}.`);
            requireThat(!batch.ownerSession || batch.ownerSession === input.sessionId,
                "Batch belongs to another session. Ask its dispatcher to update it.");
            requireThat(!needsAllocatedRun(batch) || input.status !== "finished" || batch.run,
                "Attach the actual allocated run before finishing a one-off batch or allocated-run workflow.");
            batch.ownerSession = input.sessionId;
            batch.status = input.status;
            batch.updatedAt = new Date().toISOString();
            batch.history.push({ status: input.status, time: batch.updatedAt, sessionId: input.sessionId,
                note: input.note, evidence: input.evidence });
            if (["cancelled", "blocked"].includes(input.status)) for (const child of state.batches.filter((row) =>
                row.fallback?.parentId === batch.id && row.status === "running")) {
                child.status = "blocked";
                child.updatedAt = batch.updatedAt;
                child.history.push({ status: "blocked", time: child.updatedAt, sessionId: child.ownerSession,
                    note: "Original batch changed; report-only approval is stale.", evidence: "" });
            }
            return publicBatch(batch);
        });
    }

    async suppliedModel(input, run) {
        try {
            const model = await localDirectory(input);
            const runPath = await localDirectory(run);
            const contains = (parent, child) => {
                const relative = path.relative(parent, child);
                return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
            };
            requireThat(!contains(runPath, model) && !contains(model, runPath), "Supplied model custody must be separate from the current run.");
            let found = false;
            for (const entry of ["model.bim", "definition"]) {
                try {
                    const stat = await fs.lstat(path.join(model, entry));
                    requireThat(!stat.isSymbolicLink(), "Supplied model content cannot be a symlink.");
                    found ||= entry === "model.bim" ? stat.isFile() : stat.isDirectory();
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }

            }
            requireThat(found, "Supply an existing semantic-model folder; host structural/binding validation is still required.");
        } catch (error) {
            if (typeof error.syscall === "string") requireThat(false,
                "Supplied model custody is unavailable; check the private locator and local access before retrying.",
                "supplied_model_unavailable");
            throw error;
        }
    }

    async requestContinuation(input) {
        fields(input, ["id", "sessionId", "category", "note", "evidence", "attempt"]);
        requireThat(text(input.id) && text(input.sessionId, 200) && categories.includes(input.category)
            && safeReason(input.note) && text(input.evidence) && typeof input.attempt === "boolean",
        "Record the exact blocker, non-secret note/evidence and explicit acquisition-attempt observation.");
        return this.store.change((state) => {
            const batch = state.batches.find((row) => row.id === input.id);
            requireThat(batch?.run && batch.ownerSession === input.sessionId && ["running", "blocked"].includes(batch.status),
                "The owning dispatcher must claim an existing-run batch before recording a blocker.");
            batch.status = "blocked";
            batch.updatedAt = new Date().toISOString();
            batch.history.push({ status: "blocked", time: batch.updatedAt, sessionId: input.sessionId,
                note: input.note, evidence: input.evidence, blocker: { category: input.category, attempt: input.attempt } });
            for (const child of state.batches.filter((row) => row.fallback?.parentId === batch.id && row.status === "running")) {
                child.status = "blocked";
                child.updatedAt = batch.updatedAt;
                child.history.push({ status: "blocked", time: child.updatedAt, sessionId: child.ownerSession,
                    note: "Original blocker changed; report-only approval is stale.", evidence: "" });
            }
            return { batch: publicBatch(batch), blockIndex: batch.history.length - 1,
                decisions: overridable.includes(input.category) ? ["continue", "report_only", "repair"] : ["repair"] };
        });
    }

    async approveContinuation(input) {
        fields(input, ["id", "sessionId", "blockIndex", "mode", "confirmed", "reason", "reportPath", "modelPath", "style", "format"],
            ["id", "sessionId", "blockIndex", "mode", "confirmed", "reason"]);
        requireThat(input.confirmed === true && safeReason(input.reason) && Number.isInteger(input.blockIndex)
            && ["continue", "report_only"].includes(input.mode), "Explicit fresh human approval and a bounded reason are required.");
        return this.store.change(async (state) => {
            const batch = state.batches.find((row) => row.id === input.id);
            const block = batch && currentBlock(batch);
            requireThat(batch?.status === "blocked" && batch.ownerSession === input.sessionId
                && block?.index === input.blockIndex && overridable.includes(block.category),
            "Approval must name this owning session's current overridable blocker.");
            requireThat(!currentApproval(batch), "This blocker already has a decision; record a new blocker for another decision.");
            const choice = { blockIndex: input.blockIndex, mode: input.mode, sessionId: input.sessionId,
                confirmed: true, reason: input.reason };
            if (input.mode === "continue") {
                requireThat(input.reportPath === undefined && input.modelPath === undefined,
                    "Continue reuses existing paths; fallback locators are not accepted.");
                batch.continuation = choice;
                return { batch: publicBatch(batch), next: "Resume the same batch; diagnostics remain unchanged." };
            }
            requireThat(["package", "oracle"].every((category) => batch.history.some((event) =>
                event.blocker?.category === category && event.blocker.attempt === true
                && event.sessionId === batch.ownerSession && text(event.evidence))),
            "Report-only requires prior recorded package AND oracle acquisition attempts with evidence; observations are operator-reported.");
            requireThat(batch.items.length === 1 && batch.items[0].kind === "workbook" && text(batch.items[0].sourceLuid)
                && text(input.reportPath) && path.isAbsolute(input.reportPath) && text(input.modelPath) && path.isAbsolute(input.modelPath),
            "Fallback requires one exact workbook LUID, existing working report and existing separate model.");
            requireThat(["faithful", "redesign"].includes(input.style) && ["pbip", "pbir"].includes(input.format),
                "Explicitly choose migration style and artifact format for the report-only fallback.");
            const evidence = await fallbackBinding(batch.run, input.reportPath, input.modelPath);
            const plan = { schema: "migration-plan/1", style: input.style,
                format: input.format, confirmed: true,
                models: [{ id: "fallback-model", kind: "supplied", modelPath: input.modelPath, confirmed: true }],
                reports: [{ luid: batch.items[0].sourceLuid, modelId: "fallback-model" }] };
            batch.continuation = choice;
            const child = this.newWorkflow({ run: batch.run, stage: "report", items: structuredClone(batch.items),
                label: batch.label, numeric: batch.numeric, policy: batch.policy, modelPlan: plan,
                modelId: "fallback-model", planIdentity: planIdentity(plan), requires: [],
                fallback: { parentId: batch.id, blockIndex: input.blockIndex, reportPath: input.reportPath },
                continuationOwner: batch.ownerSession, fallbackEvidence: evidence });
            state.batches.push(child);
            return { batch: publicBatch(batch), reportBatch: publicBatch(child),
                next: "Direct report-builder handoff only; no replacement model or fidelity authority." };
        });
    }
    async queueModelPlan(input) {
        fields(input, ["run", "label", "plan", "numeric", "policy"]);
        requireThat(text(input.label, 120) && ["none", "required"].includes(input.numeric)
            && ["stop", "degrade"].includes(input.policy), "Provide label, numeric scope and policy.");
        let plan = input.plan;
        if (typeof plan === "string") {
            requireThat(plan.length <= 48 * 1024, "Model plan exceeds 48 KB.");
            try { plan = JSON.parse(plan); } catch { requireThat(false, "Model plan must be valid JSON data."); }
        }
        return this.store.change(async (state) => {
            await this.selectedRun(input.run, state);
            const snapshot = state.snapshots[input.run];
            validateObservedPlan(plan, snapshot);
            const identity = planIdentity(plan);
            requireThat(!state.batches.some((row) => active(row) && row.run === input.run
                && row.modelPlan && row.modelPlan.reports.some((report) => plan.reports.some((candidate) => candidate.luid === report.luid))),
            "An unfinished model plan already owns selected reports.");
            for (const model of plan.models) if (model.kind === "supplied") await this.suppliedModel(model.modelPath, input.run);
            const batches = [];
            const providers = new Map();
            for (const model of plan.models.filter((row) => row.kind !== "supplied")) {
                const report = plan.reports.find((row) => row.modelId === model.id);
                const luid = model.kind === "shared" ? model.providerLuid : report.luid;
                const kind = model.kind === "shared" ? "datasource" : "workbook";
                const batch = this.newWorkflow({
                    run: input.run, label: input.label, stage: "semantic", numeric: input.numeric, policy: input.policy,
                    items: [{ key: `${kind}:${luid}`, kind, sourceLuid: luid, name: model.id }],
                    modelPlan: structuredClone(plan), modelId: model.id, planIdentity: identity, requires: [],
                });
                providers.set(model.id, batch.id);
                batches.push(batch);
            }
            for (const report of plan.reports) {
                const source = snapshot.assessment.workbooks.find((row) => row.luid === report.luid);
                batches.push(this.newWorkflow({
                    run: input.run, label: input.label, stage: "report", numeric: input.numeric, policy: input.policy,
                    items: [{ key: `assessment:${report.luid}`, kind: "workbook", sourceLuid: report.luid, name: source.name }],
                    modelPlan: structuredClone(plan), modelId: report.modelId, planIdentity: identity,
                    requires: providers.has(report.modelId) ? [providers.get(report.modelId)] : [],
                }));
            }
            state.batches.push(...batches);
            return { batches: batches.map(publicBatch), planIdentity: identity };
        });
    }

    async queueSource(input) {
        fields(input, ["label", "source", "numeric", "policy"]);
        requireThat(text(input.label, 120) && ["none", "required"].includes(input.numeric)
            && ["stop", "degrade"].includes(input.policy), "Provide a label, explicit numeric scope and stop/degrade policy.");
        const source = sourceScope(input.source);
        const item = sourceItem(source);
        return this.store.change((state) => {
            requireThat(!state.batches.some((batch) => batch.source
                && ["queued", "running", "blocked"].includes(batch.status)
                && batch.items[0].key === item.key), "An unfinished one-off batch already contains this source scope.");
            const now = new Date().toISOString();
            const batch = {
                id: randomUUID(), run: null, source, label: input.label, stage: "conversion", items: [item],
                numeric: input.numeric, policy: input.policy, status: "queued", ownerSession: "",
                createdAt: now, updatedAt: now,
                history: [{ status: "queued", time: now, note: "Approved one-off source handoff without prior assessment; no run allocated.",
                    evidence: "", sessionId: "" }],
            };
            state.batches.push(batch);
            return batch;
        });
    }

    async attach(input) {
        fields(input, ["id", "run", "sessionId"]);
        requireThat(text(input.id) && text(input.sessionId, 200), "Batch ID and real owner session ID are required.");
        const run = await localDirectory(input.run);
        const check = (state) => {
            const batch = state.batches.find((row) => row.id === input.id);
            requireThat(batch && needsAllocatedRun(batch) && ["running", "blocked"].includes(batch.status),
                "Claim an active one-off batch or allocated-run workflow before attaching its run.");
            requireThat(batch.ownerSession === input.sessionId, "Batch belongs to another session.");
            requireThat(batch.parentAssessmentRun !== run,
                "Conversion must attach a NEW execution run, not the parent assessment run.");
            requireThat(batch.run === null || batch.run === run, "The batch already has a different run. Never reallocate or rename it.");
            requireThat(!state.batches.some((other) => other.id !== batch.id && (batch.workflow || other.workflow)
                && needsAllocatedRun(other) && other.run === run),
            "This allocated run already belongs to another request. Never conflate run identities.");
            return batch;
        };
        const existing = check(await this.store.read());
        if (existing.run === run) return publicBatch(existing);
        const snapshot = await this.observe(this.workspace, run);
        validateSnapshot(snapshot, run);
        requireThat(snapshot.diagnostic.location === "intact", "Run identity is not intact; association was not saved.");
        return this.store.change((state) => {
            const batch = check(state);
            if (batch.run === run) return publicBatch(batch);
            requireThat(!state.batches.some((other) => other.id !== batch.id && other.run === run
                && other.stage === batch.stage && ["queued", "running", "blocked"].includes(other.status)),
            "The run already has unfinished conversion work. Resolve the overlap before linking this whole-scope batch.");
            batch.run = run;
            batch.updatedAt = new Date().toISOString();
            batch.history.push({ status: batch.status, time: batch.updatedAt, sessionId: input.sessionId,
                note: "Dispatcher associated the allocated run; source scope was not independently certified.",
                evidence: path.join(run, "run.json") });
            if (!state.runs.includes(run)) state.runs.push(run);
            state.snapshots[run] = snapshot;
            return publicBatch(batch);
        });
    }

    async export(input) {
        fields(input, ["run"], []);
        const state = await this.store.read();
        const runs = input.run === undefined ? await this.knownRuns(state) : [await this.selectedRun(input.run, state)];
        const exportedAt = new Date().toISOString();
        const rows = [];
        const appendEvents = (batch, base) => {
            batch = publicBatch(batch);
            for (const event of batch.history) {
                rows.push({ ...base, record_type: "batch_event", name: batch.label, batch_id: batch.id,
                    stage: batch.stage, batch_status: event.status, event_at: event.time, session_id: event.sessionId,
                    note: event.note, evidence: event.evidence, numeric_scope: batch.numeric, policy: batch.policy,
                    source_kind: batch.source?.kind ?? "", source_value: batch.source?.value ?? "",
                    workflow: batch.workflow ?? "", parent_assessment_run: batch.parentAssessmentRun ?? "",
                    execution_run: batch.workflow === "wave_conversion" ? batch.run ?? "" : "", group_id: batch.groupId ?? "",
                    key: batch.items.map((item) => item.key).join(" | "),
                });
            }
        };
        for (const run of runs) {
            const snapshot = state.snapshots[run];
            const base = {
                exported_at: exportedAt, run, observed_at: snapshot?.asOf ?? "",
                assessment_state: snapshot?.assessment.status ?? "not_observed",
                assessed_workbooks: snapshot?.assessment.workbooks.length ?? "",
                dependencies: snapshot?.assessment.dependencies.length ?? "",
                diagnostic_exit: snapshot?.diagnostic.exitCode ?? "",
                current_certification: "NOT_CHECKED",
                issues: snapshot ? [...snapshot.assessment.issues, ...snapshot.diagnostic.issues].join(" | ") : "Run not refreshed.",
            };
            rows.push({ ...base, record_type: "run_summary", name: path.basename(run),
                generated: snapshot?.diagnostic.units.filter((u) => u.working === "present").length ?? "",
                package: snapshot?.diagnostic.units.filter((u) => u.package).length ?? "",
            });
            for (const row of progressRows(snapshot, state.batches)) {
                rows.push({
                    ...base, record_type: "work_item", key: row.key, name: row.name, kind: row.kind,
                    source_luid: row.sourceLuid, project: row.project, tier: row.tier, complexity: row.complexity,
                    mapping: row.mapping, generated: row.working, package: row.package,
                    integrity: row.integrity, reference: row.reference,
                    ...Object.fromEntries(stages.map((stage) => [`${stage}_progress`, row.progress[stage]])),
                });
            }
            for (const batch of state.batches.filter((b) => b.run === run || (b.parentAssessmentRun === run
                && b.run !== run && (input.run !== undefined || b.run === null)))) {
                appendEvents(batch, { ...base, run: batch.run ?? "" });
            }
        }
        if (input.run === undefined) {
            for (const batch of state.batches.filter((b) => (b.source || b.workflow === "api_assessment") && b.run === null)) {
                const base = {
                    exported_at: exportedAt, run: "", observed_at: "", assessment_state: "not_observed",
                    current_certification: "NOT_CHECKED",                     issues: "Manual request; no run attached. No process or completion established.",
                };
                rows.push({ ...base, record_type: "source_request", name: batch.label, batch_id: batch.id,
                    stage: batch.stage, batch_status: batch.status, source_kind: batch.source?.kind ?? "",
                    source_value: batch.source?.value ?? "", workflow: batch.workflow ?? "",
                    numeric_scope: batch.numeric, policy: batch.policy });
                appendEvents(batch, base);
            }
        }
        const columns = ["record_type", "exported_at", "run", "observed_at", "assessment_state", "assessed_workbooks",
            "dependencies", "diagnostic_exit", "current_certification", "key", "name", "kind", "source_luid",
            "project", "tier", "complexity", "mapping", "generated", "package", "integrity", "reference",
            ...stages.map((stage) => `${stage}_progress`), "batch_id", "stage", "batch_status", "event_at",
            "session_id", "numeric_scope", "policy", "source_kind", "source_value", "workflow", "parent_assessment_run",
            "execution_run", "group_id", "note", "evidence", "issues"];
        return { filename: "migration-progress.csv", content: toCsv(rows, columns), exportedAt, records: rows.length };
    }
}
