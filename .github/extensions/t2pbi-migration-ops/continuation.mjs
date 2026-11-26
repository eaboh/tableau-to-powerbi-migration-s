import path from "node:path";
import { promises as fs, constants } from "node:fs";
import { createHash } from "node:crypto";
import { fields, requireThat, text } from "./common.mjs";
import { localDirectory } from "./evidence.mjs";

export const overridable = ["readiness", "quality", "cache", "package", "oracle"];
export const protectedCategories = ["authorization", "privacy", "structure", "tool", "filesystem"];
export const categories = [...overridable, ...protectedCategories];
export const safeReason = (value) => text(value, 500)
    && !/(?:password|token|secret|credential|api[_-]?key)\s*[:=]|https?:\/\/|[A-Za-z]:[\\/]|\//iu.test(value);

export function currentBlock(batch) {
    if (!batch.history.some((event) => event.blocker)) return null;
    const index = batch.history.findLastIndex((event) => event.status === "blocked");
    return index < 0 ? null : { index, ...batch.history[index].blocker };
}

export function currentApproval(batch) {
    const block = currentBlock(batch);
    return block && batch.continuation?.blockIndex === block.index ? batch.continuation : null;
}

export function validateContinuations(batches) {
    for (const batch of batches) {
        for (const event of batch.history) {
            if (!event.blocker) continue;
            fields(event.blocker, ["category", "attempt"]);
            requireThat(event.status === "blocked" && categories.includes(event.blocker.category)
                && typeof event.blocker.attempt === "boolean", "Invalid structured blocker.");
        }
        const block = currentBlock(batch);
        if (batch.continuation) {
            fields(batch.continuation, ["blockIndex", "mode", "sessionId", "reason", "confirmed"]);
            const choice = batch.continuation;
            requireThat(Number.isInteger(choice.blockIndex) && choice.blockIndex >= 0
                && batch.history[choice.blockIndex]?.blocker
                && overridable.includes(batch.history[choice.blockIndex].blocker.category)
                && ["continue", "report_only"].includes(choice.mode) && choice.confirmed === true
                && choice.sessionId === batch.ownerSession && safeReason(choice.reason),
            "Invalid continuation authority.");
        }
        if (block && ["running", "finished"].includes(batch.status)) {
            requireThat(currentApproval(batch)?.mode === "continue", "Fresh per-blocker approval is required before resuming.");
        }
        if (!batch.fallback) continue;
        fields(batch.fallback, ["parentId", "blockIndex", "reportPath"]);
        const parent = batches.find((row) => row.id === batch.fallback.parentId);
        requireThat(parent && parent.run === batch.run && parent.ownerSession === batch.continuationOwner
            && (!batch.ownerSession || batch.ownerSession === batch.continuationOwner)
            && batch.stage === "report" && batch.modelPlan?.models.length === 1
            && batch.modelPlan.models[0].kind === "supplied" && batch.items.length === 1
            && parent.items.length === 1 && batch.items[0].sourceLuid === parent.items[0].sourceLuid
            && text(batch.fallback.reportPath) && path.isAbsolute(batch.fallback.reportPath),
        "Invalid report-only fallback identity.");
        // Stale children remain inspectable/cancellable, but cannot start or finish.
        if (batch.status === "running") requireFallbackAuthority(batch, parent);
    }
}

export function requireFallbackAuthority(batch, parent) {
    const choice = parent && currentApproval(parent);
    requireThat(parent?.status === "blocked" && choice?.mode === "report_only"
        && choice.blockIndex === batch.fallback.blockIndex && choice.sessionId === batch.continuationOwner,
    "Report-only approval is stale; return to the original blocker for a fresh decision.");
}

async function independentFile(file, limit = 1024 * 1024) {
    await localDirectory(path.dirname(file));
    const before = await fs.lstat(file);
    requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit,
        "Fallback evidence requires bounded independent regular files.");
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        requireThat(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1,
            "Fallback evidence changed during custody checks.");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        requireThat(after.size === opened.size && after.mtimeMs === opened.mtimeMs
            && after.ctimeMs === opened.ctimeMs && bytes.length <= limit,
        "Fallback evidence changed while reading.");
        return bytes;
    } finally {
        await handle.close();
    }
}

export async function fallbackBinding(run, reportPath, modelPath) {
    try {
        const root = await localDirectory(run);
        const report = await localDirectory(reportPath);
        const model = await localDirectory(modelPath);
        requireThat(root !== model, "Fallback model must be outside the run.");
        const relative = path.relative(root, model);
        requireThat(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
            "Fallback model must be outside the run and remain read-only.");
        requireThat(!root.startsWith(model + path.sep), "Fallback model cannot contain the run.");
        const pieces = path.relative(root, report).split(path.sep);
        requireThat(!pieces.includes("..") && ((pieces[0] === "bundle" && pieces[1] === "pbip")
            || pieces[0] === "pbip" || (pieces[0] === "packages" && pieces.includes("fabric")))
            && report.endsWith(".Report"), "Fallback report must be an existing working report in this run.");
        const bindingBytes = await independentFile(path.join(report, "definition.pbir"));
        const binding = JSON.parse(bindingBytes.toString("utf8"));
        fields(binding, ["version", "datasetReference", "$schema"], ["version", "datasetReference"]);
        requireThat(binding.version === "4.0", "Unsupported report binding version.");
        fields(binding.datasetReference, ["byPath"]);
        fields(binding.datasetReference.byPath, ["path"]);
        const locator = binding.datasetReference.byPath.path;
        requireThat(text(locator) && !path.isAbsolute(locator), "Fallback requires a supported relative byPath model binding.");
        requireThat(await localDirectory(path.resolve(report, locator)) === model,
            "Report binding does not resolve to the intended existing model.");
        let marker;
        try {
            marker = await independentFile(path.join(model, "definition", "model.tmdl"));
            requireThat(/^\s*model\s+/mu.test(marker.toString("utf8")), "Existing model definition is unavailable.");
            const tableRoot = await localDirectory(path.join(model, "definition", "tables"));
            const tables = (await fs.readdir(tableRoot)).filter((name) => name.endsWith(".tmdl"));
            requireThat(tables.length > 0 && tables.length <= 1000, "Existing model requires declared table definitions.");
            for (const name of tables) {
                const table = await independentFile(path.join(tableRoot, name));
                requireThat(/^table\s+/mu.test(table.toString("utf8")), "Existing model table declaration is unavailable.");
            }
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            marker = await independentFile(path.join(model, "model.bim"));
            const bim = JSON.parse(marker.toString("utf8"));
            requireThat(bim.model && Array.isArray(bim.model.tables) && bim.model.tables.length > 0,
                "Existing model must contain declared tables, not an empty placeholder.");
        }
        return { bindingHash: createHash("sha256").update(bindingBytes).digest("hex"),
            modelMarkerHash: createHash("sha256").update(marker).digest("hex") };
    } catch (error) {
        if (typeof error.syscall === "string" || error instanceof SyntaxError) requireThat(false,
            "Private fallback report/model evidence is unavailable or malformed.", "fallback_unavailable");
        throw error;
    }
}

export function publicContinuation(batch) {
    if (batch.fallback || batch.history.some((event) => event.blocker)) batch = { ...batch,
        history: batch.history.map((event) => ({ ...event, evidence: event.evidence ? "[private evidence recorded]" : "" })) };
    if (!batch.fallback) return batch;
    const { reportPath, ...fallback } = batch.fallback;
    return { ...batch, fallback };
}
