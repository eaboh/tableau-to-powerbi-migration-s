import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { requireThat, object, text, stages, statuses, isoDate, OpsError, sourceScope, sourceItem } from "./common.mjs";
import { needsAllocatedRun, validateWorkflow } from "./workflow.mjs";
import { validatePlanDependencies } from "./model-planning.mjs";

export const CANVAS_ID = "t2pbi-migration-ops";

export function validateSnapshot(snapshot, run) {
    requireThat(object(snapshot) && snapshot.run === run && isoDate(snapshot.asOf), "Invalid snapshot identity.");
    const { assessment: a, diagnostic: d } = snapshot;
    requireThat(object(a) && ["not_observed", "missing", "unassessable", "incomplete", "degraded", "inventory_observed"].includes(a.status)
        && Array.isArray(a.issues) && a.issues.every((v) => typeof v === "string")
        && Array.isArray(a.workbooks) && Array.isArray(a.dependencies) && Array.isArray(a.outputs),
    "Invalid assessment snapshot.");
    requireThat(a.workbooks.every((w) => object(w) && text(w.name) && text(w.luid)
        && typeof w.project === "string" && typeof w.tier === "string" && (w.complexity === null || Number.isFinite(w.complexity)))
        && a.dependencies.every((r) => object(r) && text(r.workbookName) && text(r.datasourceName)
            && typeof r.workbookLuid === "string" && typeof r.datasourceLuid === "string")
        && a.outputs.every((r) => object(r) && text(r.name) && text(r.path) && ["present", "missing", "unreadable"].includes(r.status)),
    "Invalid assessment snapshot rows.");
    requireThat((a.surveySupplied === undefined || a.surveySupplied === null || typeof a.surveySupplied === "boolean")
        && (a.collectionErrors === undefined || (Array.isArray(a.collectionErrors) && a.collectionErrors.every((error) =>
            object(error) && ["structure", "workbooks", "views", "datasources", "projects", "groups", "flows",
                "group members", "project grants", "workbook grants", "view grants", "other"].includes(error.listing)
            && ["primary", "secondary"].includes(error.severity))))
        && a.workbooks.every((w) => (w.projectLuid === undefined || typeof w.projectLuid === "string")
            && (w.structureAvailable === undefined || typeof w.structureAvailable === "boolean")
            && [w.understated, w.hasUserReference].every((value) => value === undefined || value === null || typeof value === "boolean")
            && (w.signals === undefined || (object(w.signals)
                && ["sheets", "dashboards", "calcs", "lods", "tableCalcs", "viewsLifetime"].every((key) =>
                    w.signals[key] === null || (Number.isSafeInteger(w.signals[key]) && w.signals[key] >= 0))))),
    "Invalid optional assessment planning metadata.");
    const optionalDate = (value) => value === undefined || value === null || isoDate(value);
    const optionalCount = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
    requireThat(a.workbooks.every((w) => optionalDate(w.updatedAt) && optionalDate(w.createdAt)
        && (w.sizeMb === undefined || w.sizeMb === null || (Number.isFinite(w.sizeMb) && w.sizeMb >= 0))
        && (w.activity === undefined || (object(w.activity)
            && ["subscriptions", "alerts", "customViews"].every((key) => optionalCount(w.activity[key]))))),
    "Invalid workbook explorer metadata.");
    for (const [key, valid] of [
        ["views", (row) => typeof row.workbookLuid === "string" && optionalCount(row.viewsLifetime)],
        ["datasourceInventory", (row) => typeof row.project === "string" && typeof row.projectLuid === "string"
            && typeof row.connectionType === "string"
            && [row.certified, row.hasExtracts].every((v) => v === null || typeof v === "boolean")],
    ]) {
        const inventory = a[key];
        if (inventory === undefined) continue;
        const ids = new Set();
        requireThat(object(inventory) && ["available", "missing", "unreadable"].includes(inventory.status)
            && Array.isArray(inventory.rows) && (inventory.status === "available" || inventory.rows.length === 0)
            && inventory.rows.every((row) => {
                if (!object(row) || !text(row.luid) || !text(row.name) || ids.has(row.luid)
                    || !optionalDate(row.updatedAt) || !valid(row)) return false;
                ids.add(row.luid);
                return true;
            }), `Invalid ${key} explorer inventory.`);
    }
    requireThat(object(d) && [0, 1, 2].includes(d.exitCode) && text(d.location) && text(d.inventory)
        && d.certification === "NOT_CHECKED" && text(d.nextAction)
        && Array.isArray(d.issues) && d.issues.every((v) => typeof v === "string")
        && Array.isArray(d.units) && d.units.every((u) => object(u) && text(u.name)
            && ["workbook", "datasource", "unknown"].includes(u.kind) && text(u.scope) && text(u.working)
            && typeof u.package === "string" && text(u.integrity) && text(u.reference)
            && Array.isArray(u.storedReadiness))
        && Array.isArray(d.phases) && d.phases.every((p) => object(p) && text(p.name) && text(p.status)),
    "Invalid diagnostic snapshot.");
}

function validate(state, workspace) {
    requireThat(object(state) && state.format === CANVAS_ID && state.version === 1
        && state.workspace === workspace && Array.isArray(state.runs) && state.runs.every((run) => text(run) && path.isAbsolute(run))
        && object(state.snapshots) && Array.isArray(state.batches), "Unknown or corrupt tracking format.");
    for (const [run, snapshot] of Object.entries(state.snapshots)) validateSnapshot(snapshot, run);
    const ids = new Set();
    for (const batch of state.batches) {
        requireThat(object(batch), "Invalid batch record.");
        const hasSource = Object.hasOwn(batch, "source");
        if (hasSource) {
            const source = sourceScope(batch.source);
            requireThat(source.value === batch.source.value && batch.stage === "conversion",
                "Invalid one-off source scope.");
            const expected = sourceItem(source);
            requireThat(Array.isArray(batch.items) && batch.items.length === 1
                && object(batch.items[0]) && Object.keys(expected).every((key) => batch.items[0][key] === expected[key]),
            "Invalid one-off source item.");
        }
        requireThat(object(batch) && text(batch.id) && !ids.has(batch.id) && text(batch.label, 120)
            && ((needsAllocatedRun(batch) && batch.run === null) || (text(batch.run) && path.isAbsolute(batch.run))) && stages.includes(batch.stage)
            && ["none", "required"].includes(batch.numeric) && ["stop", "degrade"].includes(batch.policy)
            && statuses.includes(batch.status) && isoDate(batch.createdAt) && isoDate(batch.updatedAt)
            && typeof batch.ownerSession === "string" && Array.isArray(batch.items) && batch.items.length > 0
            && batch.items.every((item) => object(item) && text(item.key) && text(item.name)
                && (hasSource ? item.kind === "source" : ["workbook", "datasource", "run"].includes(item.kind))
                && (item.sourceLuid === null || text(item.sourceLuid)))
            && Array.isArray(batch.history) && batch.history.length > 0
            && batch.history.every((event) => object(event) && statuses.includes(event.status)
                && isoDate(event.time) && typeof event.sessionId === "string" && text(event.note)
                && typeof event.evidence === "string"), "Invalid batch history.");
        requireThat(batch.history.at(-1).status === batch.status, "Batch status contradicts history.");
        requireThat(!hasSource || batch.status !== "finished" || batch.run !== null, "Finished one-off batch has no run.");
        validateWorkflow(batch);
        ids.add(batch.id);
    }
    validatePlanDependencies(state.batches);
}

export class Store {
    constructor(workspace, home = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot")) {
        this.workspace = workspace;
        const identity = process.platform === "win32" ? workspace.toLowerCase() : workspace;
        const key = createHash("sha256").update(identity).digest("hex");
        this.directory = path.join(home, "extension-data", CANVAS_ID, key);
        this.file = path.join(this.directory, "tracking.json");
        this.lock = path.join(this.directory, "write.lock");
    }

    async read() {
        try {
            const state = JSON.parse(await fs.readFile(this.file, "utf8"));
            validate(state, this.workspace);
            return state;
        } catch (error) {
            if (error.code === "ENOENT") {
                return { format: CANVAS_ID, version: 1, workspace: this.workspace, runs: [], snapshots: {}, batches: [] };
            }
            throw new OpsError("storage_error", `Tracking data could not be read; it was not overwritten: ${error.message}`);
        }
    }

    async change(update) {
        await fs.mkdir(this.directory, { recursive: true });
        let locked = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                await fs.mkdir(this.lock);
                locked = true;
                break;
            } catch (error) {
                if (error.code !== "EEXIST") throw new OpsError("storage_error", error.message);
                await sleep(100);
            }
        }
        requireThat(locked, "Tracking store is busy. Retry; if a host crashed, inspect write.lock before removing it.", "storage_busy");
        const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
        try {
            const state = await this.read();
            const result = await update(state);
            validate(state, this.workspace);
            await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
            await fs.rename(temporary, this.file);
            return result;
        } finally {
            await fs.rm(temporary, { force: true });
            await fs.rmdir(this.lock);
        }
    }
}
