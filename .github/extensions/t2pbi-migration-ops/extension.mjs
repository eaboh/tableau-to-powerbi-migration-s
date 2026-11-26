import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { Operations } from "./operations.mjs";
import { localDirectory } from "./evidence.mjs";
import { CANVAS_ID } from "./store.mjs";
import { stages } from "./common.mjs";
import { startServer } from "./server.mjs";

const workspace = await localDirectory(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
const operations = new Operations(workspace);
const instances = new Map();
const string = { type: "string", minLength: 1 };
const schema = (properties, required = Object.keys(properties)) => ({
    type: "object", properties, required, additionalProperties: false,
});
const definitions = [
    ["get_model_suggestions", "Read candidate published-provider overlap for exact selected reports. Compatibility is unknown; never confirms or edits a mapping.",
        schema({ run: string, luids: { type: "array", items: string, minItems: 1, maxItems: 100, uniqueItems: true } })],
    ["queue_model_plan", "Queue explicitly confirmed migration style/format and standalone/shared/supplied model mapping. Generated models get one semantic handoff each; report handoffs wait for operator-reported provider progress. No build, rebinding or validation is performed here.",
        schema({ run: string, label: { ...string, maxLength: 120 }, plan: { oneOf: [{ type: "object" }, { type: "string", maxLength: 49152 }] },
            numeric: { enum: ["none", "required"] }, policy: { enum: ["stop", "degrade"] } })],
    ["get_state", "List run history and batches; optionally show one saved evidence snapshot. Observations never certify readiness or completion.",
        schema({ run: string }, [])],
    ["get_agent_activity", "Read run.json session anchors and optional local Copilot event logs, including subagents. Recorded lifecycle only, not verified process liveness or run completion.",
        schema({ run: string })],
    ["register_run", "Register an explicitly selected external local run directory, without modifying its files.", schema({ run: string })],
    ["refresh_run", "Read one run through the canonical run_status.py diagnostic and assessment artifacts; save a timestamped private snapshot.",
        schema({ run: string })],
    ["queue_batch", "Approve a manual dispatcher handoff, not automatic execution. Use exact work-item keys from get_state; clear keys for run-level assessment.",
        schema({ run: string, label: { ...string, maxLength: 120 }, stage: { enum: stages.filter((stage) => stage !== "investigation") },
            keys: { type: "array", items: string, maxItems: 100, uniqueItems: true },
            numeric: { enum: ["none", "required"] }, policy: { enum: ["stop", "degrade"] } })],
    ["queue_source_batch", "Queue a one-off dashboard URL or project conversion without an assessment or existing run. Manual dispatcher handoff only; no source lookup or execution.",
        schema({ label: { ...string, maxLength: 120 },
            source: schema({ kind: { enum: ["dashboard_url", "project"] }, value: { ...string, maxLength: 2048 } }),
            numeric: { enum: ["none", "required"] }, policy: { enum: ["stop", "degrade"] } })],
    ["queue_assessment", "Approve a site-wide API metadata assessment before any run exists. Manual root-dispatcher handoff; no workbook/datasource downloads or automatic launch.",
        schema({ label: { ...string, maxLength: 120 }, policy: { enum: ["stop", "degrade"] } })],
    ["queue_wave", "Queue exact 1..100 assessed workbook keys for scoped artifact investigation or NEW conversions. Conversion tracks are one workbook/new run each, grouped by batchSize; collection/downloads repeat, not checkpoint reuse. Manual handoff only.",
        schema({ run: string, label: { ...string, maxLength: 120 }, stage: { enum: ["investigation", "conversion"] },
            keys: { type: "array", items: string, minItems: 1, maxItems: 100, uniqueItems: true },
            numeric: { enum: ["none", "required"] }, policy: { enum: ["stop", "degrade"] },
            batchSize: { type: "integer", minimum: 1, maximum: 100 } })],
    ["attach_batch_run", "Associate the actual allocated run with a claimed one-off, API assessment or conversion track. Parent assessment identity remains separate; association does not certify source scope.",
        schema({ id: string, run: string, sessionId: string })],
    ["get_dispatch", "Read a queued batch and its mandatory agent handoff contract. Does not launch work. Dispatcher must claim via update_batch using its real session ID.",
        schema({ id: string })],
    ["update_batch", "Record a batch transition with the real owning dispatcher session ID. Finished requires evidence and is operator-reported, not certified COMPLETE.",
        schema({ id: string, status: { enum: ["running", "blocked", "finished", "cancelled"] }, sessionId: string,
            note: string, evidence: { type: "string" } })],
    ["export_csv", "Export assessment versus recorded progress and batch event history from saved snapshots. Omit run for all known runs; unrefreshed runs remain unknown.",
        schema({ run: string }, [])],
    ["export_assessment_csv", "Export selected-run planning rollups by project, referenced datasource and complexity, preserving caveats and provisional identity groups.",
        schema({ run: string })],
    ["export_assessment_html", "Download a private self-contained offline HTML planning report from the available selected saved assessment; not certification. No fresh collection or external assets.",
        schema({ run: string })],
];

async function checked(action) {
    try {
        return await action();
    } catch (error) {
        throw new CanvasError(error.code ?? "operation_failed", error.message);
    }
}

await joinSession({
    canvases: [createCanvas({
        id: CANVAS_ID,
        displayName: "Tableau Migration Operations",
        description: "Track assessments, stage approved migration batches for manual agent handoff, inspect run history, and export progress to CSV.",
        actions: definitions.map(([name, description, inputSchema]) => ({
            name, description, inputSchema,
            handler: async (context) => checked(() => operations.call(name, context.input ?? {})),
        })),
        open: async (context) => checked(async () => {
            await operations.store.read();
            let instance = instances.get(context.instanceId);
            if (!instance) {
                instance = await startServer(operations);
                instances.set(context.instanceId, instance);
            }
            return { title: "Tableau Migration Operations", url: instance.url, status: workspace };
        }),
        onClose: async (context) => {
            const instance = instances.get(context.instanceId);
            if (instance) {
                await instance.close();
                instances.delete(context.instanceId);
            }
        },
    })],
});
