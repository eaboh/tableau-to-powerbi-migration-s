import path from "node:path";
import { createHash } from "node:crypto";
import { fields, requireThat, text } from "./common.mjs";
import { publicContinuation } from "./continuation.mjs";

const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value);
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function validatePlan(plan) {
    fields(plan, ["schema", "style", "format", "confirmed", "models", "reports"]);
    requireThat(JSON.stringify(plan).length <= 48 * 1024, "Model plan exceeds 48 KB.");
    requireThat(plan.schema === "migration-plan/1" && ["faithful", "redesign"].includes(plan.style)
        && ["pbip", "pbir"].includes(plan.format) && plan.confirmed === true,
    "Explicitly confirm migration style, supported format (pbip|pbir), and model mapping.");
    requireThat(Array.isArray(plan.models) && plan.models.length >= 1 && plan.models.length <= 100
        && Array.isArray(plan.reports) && plan.reports.length >= 1 && plan.reports.length <= 100,
    "Map 1..100 reports to 1..100 models.");
    const models = new Map();
    for (const model of plan.models) {
        fields(model, ["id", "kind", "confirmed", "providerLuid", "modelPath"], ["id", "kind", "confirmed"]);
        requireThat(id(model.id) && !models.has(model.id) && model.confirmed === true
            && ["standalone", "shared", "supplied"].includes(model.kind), "Model identities and approval must be explicit and unique.");
        requireThat(model.kind === "shared" ? id(model.providerLuid) && model.modelPath === undefined
            : model.kind === "supplied" ? text(model.modelPath) && path.isAbsolute(model.modelPath) && model.providerLuid === undefined
                : model.providerLuid === undefined && model.modelPath === undefined,
        "Shared models require an exact published provider; supplied models require an absolute local model folder.");
        models.set(model.id, model);
    }
    const reports = new Set();
    for (const report of plan.reports) {
        fields(report, ["luid", "modelId"]);
        requireThat(id(report.luid) && !reports.has(report.luid) && models.has(report.modelId),
            "Every selected report needs one unique assignment to a declared model.");
        reports.add(report.luid);
    }
    for (const model of models.values()) {
        const consumers = plan.reports.filter((report) => report.modelId === model.id);
        requireThat(consumers.length > 0 && (model.kind !== "standalone" || consumers.length === 1)
            && (model.kind !== "shared" || consumers.length >= 2),
        "Standalone models serve one report; shared models serve at least two; unused models are invalid.");
    }
    return plan;
}

export function planIdentity(plan) {
    validatePlan(plan);
    const canonical = {
        schema: plan.schema, style: plan.style, format: plan.format, confirmed: true,
        models: [...plan.models].sort((a, b) => compare(a.id, b.id)).map((model) => ({
            id: model.id, kind: model.kind, confirmed: true,
            ...(model.providerLuid === undefined ? {} : { providerLuid: model.providerLuid }),
            ...(model.modelPath === undefined ? {} : { modelPath: model.modelPath }),
        })),
        reports: [...plan.reports].sort((a, b) => compare(a.luid, b.luid)).map(({ luid, modelId }) => ({ luid, modelId })),
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function validateObservedPlan(plan, snapshot) {
    validatePlan(plan);
    requireThat(snapshot, "Refresh the selected run before mapping reports.");
    for (const report of plan.reports) {
        requireThat(snapshot.assessment.workbooks.filter((row) => row.luid === report.luid).length === 1,
            "Report mapping contains an unknown or ambiguous source LUID.");
        const model = plan.models.find((row) => row.id === report.modelId);
        if (model.kind === "shared") requireThat(snapshot.assessment.dependencies.some((edge) =>
            edge.workbookLuid === report.luid && edge.datasourceLuid === model.providerLuid),
        "Every shared consumer must reference the exact observed published provider; compatibility still requires host review.");
    }
}

export function suggestions(snapshot, luids) {
    requireThat(Array.isArray(luids) && luids.length > 0 && luids.length <= 100
        && luids.every(id) && new Set(luids).size === luids.length, "Select distinct exact workbook LUIDs.");
    requireThat(snapshot && luids.every((luid) => snapshot.assessment.workbooks.filter((row) => row.luid === luid).length === 1),
        "Refresh and select known workbook identities.");
    const providers = new Map();
    for (const edge of snapshot.assessment.dependencies) {
        if (luids.includes(edge.workbookLuid) && id(edge.datasourceLuid)) {
            if (!providers.has(edge.datasourceLuid)) providers.set(edge.datasourceLuid, new Set());
            providers.get(edge.datasourceLuid).add(edge.workbookLuid);
        }
    }
    return [...providers].filter(([, consumers]) => consumers.size > 1).map(([providerLuid, consumers]) => ({
        providerLuid, reports: [...consumers].sort(), evidence: "published-provider-luid-overlap",
        compatibility: "unknown; compare fields, calculations and security", confirmed: false,
    }));
}

export function validateModelBatch(batch) {
    if (batch.modelPlan === undefined) {
        requireThat(batch.modelId === undefined && batch.planIdentity === undefined && batch.requires === undefined,
            "Model metadata requires an explicit plan.");
        return;
    }
    validatePlan(batch.modelPlan);
    requireThat(batch.planIdentity === planIdentity(batch.modelPlan) && id(batch.modelId)
        && ["semantic", "report"].includes(batch.stage) && Array.isArray(batch.requires)
        && batch.requires.every((value) => text(value)) && new Set(batch.requires).size === batch.requires.length,
    "Invalid frozen model batch identity.");
    const model = batch.modelPlan.models.find((row) => row.id === batch.modelId);
    requireThat(model && batch.items.length === 1, "Model batches carry one exact source identity.");
    const consumers = batch.modelPlan.reports.filter((row) => row.modelId === model.id);
    const item = batch.items[0];
    requireThat(batch.stage === "semantic"
        ? model.kind !== "supplied" && batch.requires.length === 0
            && item.kind === (model.kind === "shared" ? "datasource" : "workbook")
            && item.sourceLuid === (model.kind === "shared" ? model.providerLuid : consumers[0].luid)
        : item.kind === "workbook" && consumers.some((row) => row.luid === item.sourceLuid)
            && batch.requires.length === (model.kind === "supplied" ? 0 : 1),
    "Model build/report source or provider ordering contradicts the mapping.");
}

export function validatePlanDependencies(batches) {
    for (const batch of batches.filter((row) => row.modelPlan)) {
        validateModelBatch(batch);
        for (const required of batch.requires) {
            const provider = batches.find((row) => row.id === required);
            requireThat(provider && provider.stage === "semantic" && provider.run === batch.run
                && provider.modelId === batch.modelId && provider.planIdentity === batch.planIdentity,
            "Report dependencies must reference the same run, plan and semantic model.");
            if (["running", "finished"].includes(batch.status)) requireProviderProgress(provider);
        }
    }
}

export function requireProviderProgress(provider) {
    requireThat(provider?.status === "finished" && text(provider.ownerSession)
        && text(provider.history.at(-1).evidence),
    "Provider stage must have operator-reported completion and evidence before report work; this is not validation.");
}

export function publicBatch(batch) {
    batch = publicContinuation(batch);
    if (!batch.modelPlan) return batch;
    return { ...batch, modelPlan: {
        ...batch.modelPlan, models: batch.modelPlan.models.map(({ modelPath, ...model }) => model),
    } };
}
