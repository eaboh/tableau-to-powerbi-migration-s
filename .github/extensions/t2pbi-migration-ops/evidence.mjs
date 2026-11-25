import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireThat, object, text, OpsError } from "./common.mjs";

const execute = promisify(execFile);
const MAX_FILE = 16 * 1024 * 1024;
const outputNames = ["assessment.json", "report.md", "estate.db", "estate_survey.json"];
const errorCategories = new Set(["structure", "workbooks", "views", "datasources", "projects", "groups", "flows",
    "group members", "project grants", "workbook grants", "view grants"]);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value) => typeof value === "boolean" ? value : value === 0 ? false : value === 1 ? true : null;
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/u.test(value)
    && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const size = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const restCount = (value) => count(typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value);

async function optionalInventory(run, result, name, project) {
    const relative = `raw/${name}.json`;
    const inventory = { status: "missing", rows: [] };
    const output = { name: relative, path: path.join(run, "assessment", "raw", `${name}.json`), status: "missing" };
    result.outputs.push(output);
    try {
        const file = await fixedFile(run, `assessment/${relative}`);
        if (!file) {
            result.issues.push(`${relative}: optional inventory missing; refresh cannot recover evidence not collected.`);
            return inventory;
        }
        const rows = await readJson(file);
        requireThat(Array.isArray(rows), `Unrecognized ${relative} inventory.`);
        const ids = new Set();
        const projected = rows.map((row) => {
            requireThat(object(row) && text(row.id) && text(row.name) && !ids.has(row.id),
                `Invalid or duplicate ${name} identity.`);
            ids.add(row.id);
            return project(row);
        });
        inventory.status = "available";
        inventory.rows = projected;
        output.status = "present";
        if (projected.some((row) => Object.values(row).some((value) => value === null || value === ""))) {
            result.issues.push(`${relative}: some metadata is missing or invalid; shown as unknown.`);
        }
    } catch (error) {
        inventory.status = "unreadable";
        output.status = "unreadable";
        result.issues.push(`${relative}: ${error.message}; this optional inventory is unavailable.`);
    }
    return inventory;
}

export async function localDirectory(value) {
    requireThat(text(value) && path.isAbsolute(value) && !value.startsWith("\\\\"),
        "An absolute local directory is required.");
    const resolved = path.resolve(value);
    const parents = [];
    for (let current = resolved;; current = path.dirname(current)) {
        parents.unshift(current);
        if (path.dirname(current) === current) break;
    }
    for (const current of parents) {
        const info = await fs.lstat(current);
        requireThat(info.isDirectory() && !info.isSymbolicLink(), "Linked or non-directory paths are not supported.");
    }
    return fs.realpath(resolved);
}

async function fixedFile(run, relative) {
    const pieces = relative.split("/");
    let current = run;
    for (const piece of pieces.slice(0, -1)) {
        current = path.join(current, piece);
        try {
            const info = await fs.lstat(current);
            requireThat(info.isDirectory() && !info.isSymbolicLink(), `Unsafe evidence directory: ${relative}.`);
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
    }
    current = path.join(current, pieces.at(-1));
    try {
        const info = await fs.lstat(current);
        requireThat(info.isFile() && !info.isSymbolicLink(), `Unsafe evidence file: ${relative}.`);
        return { path: current, size: info.size };
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function readJson(file) {
    requireThat(file.size <= MAX_FILE, "Evidence JSON exceeds the 16 MB limit.");
    return JSON.parse(await fs.readFile(file.path, "utf8"));
}

export async function discoverRuns(workspace) {
    const root = path.join(workspace, "_runs");
    try {
        await localDirectory(root);
    } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
        .map((entry) => path.join(root, entry.name)).sort().reverse();
}

async function assessment(run, trusted) {
    const result = { status: "not_observed", issues: [], outputs: [], workbooks: [], dependencies: [] };
    if (!trusted) {
        result.issues.push("Run identity is not intact; assessment child evidence was not read.");
        return result;
    }
    let document;
    for (const name of outputNames) {
        try {
            const file = await fixedFile(run, `assessment/${name}`);
            if (name === "assessment.json" && file) document = await readJson(file);
            result.outputs.push({ name, path: path.join(run, "assessment", name), status: file ? "present" : "missing" });
        } catch (error) {
            result.outputs.push({ name, path: path.join(run, "assessment", name), status: "unreadable" });
            result.issues.push(`${name}: ${error.message}`);
            if (name === "assessment.json") result.status = "unassessable";
        }
    }
    if (result.status === "unassessable") return result;
    if (document === undefined) {
        result.status = "missing";
        return result;
    }
    try {
        requireThat(object(document) && Array.isArray(document.workbooks) && Array.isArray(document.dependencies)
            && typeof document.degraded === "boolean" && typeof document.degraded_primary === "boolean"
            && Array.isArray(document.listing_errors), "Unrecognized assessment schema.");
        requireThat(!document.degraded_primary || document.degraded, "Contradictory assessment degradation flags.");
        result.surveySupplied = typeof document.survey_supplied === "boolean" ? document.survey_supplied : null;
        result.collectionErrors = document.listing_errors.map((error) => {
            requireThat(object(error) && ["primary", "secondary"].includes(error.severity), "Invalid listing-error severity.");
            const category = typeof error.listing === "string" ? error.listing.split(":")[0] : "other";
            return { listing: errorCategories.has(category) ? category : "other", severity: error.severity };
        });
        const identities = new Set();
        result.workbooks = document.workbooks.map((row) => {
            requireThat(object(row) && text(row.name) && text(row.luid), "Invalid assessed workbook identity.");
            requireThat(!identities.has(row.luid), "Duplicate assessed workbook LUID.");
            identities.add(row.luid);
            return {
                name: row.name, luid: row.luid, project: typeof row.project === "string" ? row.project : "",
                tier: typeof row.tier === "string" ? row.tier : "",
                complexity: Number.isFinite(row.complexity) ? row.complexity : null,
                projectLuid: typeof row.project_luid === "string" ? row.project_luid : "",
                hasUserReference: flag(row.has_user_reference),
                structureAvailable: flag(row.has_user_reference) !== null,
                understated: flag(row.complexity_understated),
                updatedAt: timestamp(row.updated_at), createdAt: timestamp(row.created_at), sizeMb: size(row.size_mb),
                activity: {
                    subscriptions: count(row.subscriptions), alerts: count(row.alerts), customViews: count(row.custom_views),
                },
                signals: {
                    sheets: count(row.sheets), dashboards: count(row.dashboards), calcs: count(row.calcs),
                    lods: count(row.lods), tableCalcs: count(row.table_calcs), viewsLifetime: count(row.views_lifetime),
                },
            };
        });
        result.dependencies = document.dependencies.map((row) => {
            requireThat(object(row) && text(row.workbook_name) && text(row.datasource_name),
                "Invalid assessment dependency.");
            return {
                workbookName: row.workbook_name, datasourceName: row.datasource_name,
                workbookLuid: typeof row.workbook_luid === "string" ? row.workbook_luid : "",
                datasourceLuid: typeof row.datasource_luid === "string" ? row.datasource_luid : "",
            };
        });
        result.status = document.degraded_primary ? "incomplete" : document.degraded ? "degraded" : "inventory_observed";
        if (document.listing_errors.length) result.issues.push(`${document.listing_errors.length} listing error(s) recorded.`);
    } catch (error) {
        result.status = "unassessable";
        result.workbooks = [];
        result.dependencies = [];
        result.issues.push(error.message);
    }
    if (["inventory_observed", "degraded", "incomplete"].includes(result.status)) {
        if (result.workbooks.some((w) => w.updatedAt === null || w.sizeMb === null
            || Object.values(w.activity).includes(null))) {
            result.issues.push("Some workbook dates, sizes or deliberate-use counts are missing/invalid; shown as unknown.");
        }
        result.views = await optionalInventory(run, result, "views", (row) => ({
            luid: row.id, name: row.name, workbookLuid: text(row.workbook?.id) ? row.workbook.id : "",
            viewsLifetime: restCount(row.usage?.totalViewCount), updatedAt: timestamp(row.updatedAt),
        }));
        result.datasourceInventory = await optionalInventory(run, result, "datasources", (row) => ({
            luid: row.id, name: row.name, project: text(row.project?.name) ? row.project.name : "",
            projectLuid: text(row.project?.id) ? row.project.id : "", updatedAt: timestamp(row.updatedAt),
            certified: flag(row.isCertified), hasExtracts: flag(row.hasExtracts),
            connectionType: text(row.type) ? row.type : "",
        }));
    }
    return result;
}

export async function observeRun(workspace, run) {
    const selected = await localDirectory(run);
    let stdout, exitCode = 0;
    try {
        ({ stdout } = await execute("python", ["-B", path.join(workspace, "scripts", "run_status.py"),
            "--run", selected, "--json"], { cwd: workspace, windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }));
    } catch (error) {
        if ([1, 2].includes(error.code) && error.stdout) {
            stdout = error.stdout;
            exitCode = error.code;
        } else {
            throw new OpsError("observation_failed", `run_status.py failed: ${error.message}`);
        }
    }
    const raw = JSON.parse(stdout);
    requireThat(raw.schema_version === 2 && raw.current_certification === "NOT_CHECKED"
        && Array.isArray(raw.findings), "Unrecognized run_status.py response.", "observation_failed");
    const diagnostic = {
        exitCode, location: raw.run_location?.state ?? "unestablished",
        inventory: raw.inventory_scope ?? "unestablished", certification: "NOT_CHECKED",
        issues: raw.findings.map((row) => `${row.source}: ${row.code}: ${row.reason}`),
        nextAction: raw.next_action?.headline ?? "Inspect run evidence.",
        units: (raw.units ?? []).map((row) => ({
            name: row.unit, kind: row.kind, scope: row.scope, working: row.generated_working_copy,
            package: row.package?.relative_path ?? "", integrity: row.package?.integrity_status ?? "not_observed",
            reference: row.package?.reference?.status ?? "not_observed",
            storedReadiness: row.package?.stored_readiness ?? [],
        })),
        phases: (raw.recorded_phases ?? []).map((row) => ({
            name: row.phase ?? row.source, status: row.last_observed?.status ?? "unknown",
        })),
    };
    return {
        run: selected, asOf: new Date().toISOString(), diagnostic,
        assessment: await assessment(selected, diagnostic.location === "intact"),
    };
}
