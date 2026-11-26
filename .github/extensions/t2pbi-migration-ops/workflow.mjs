import path from "node:path";
import { object, requireThat, text } from "./common.mjs";
import { validateModelBatch } from "./model-planning.mjs";

export const workflows = ["api_assessment", "artifact_investigation", "wave_conversion"];
export const active = (batch) => ["queued", "running", "blocked"].includes(batch.status);
export const needsAllocatedRun = (batch) => Boolean(batch.source)
    || ["api_assessment", "wave_conversion"].includes(batch.workflow);
export const assessmentRun = (batch) => batch.parentAssessmentRun ?? batch.run;

export function validateWorkflow(batch) {
    validateModelBatch(batch);
    if (batch.workflow === undefined) {
        requireThat(batch.parentAssessmentRun === undefined && batch.groupId === undefined,
            "Workflow metadata requires a workflow identity.");
        return;
    }
    requireThat(workflows.includes(batch.workflow) && !Object.hasOwn(batch, "source"),
        "Invalid workflow identity.");
    if (batch.workflow === "api_assessment") {
        requireThat(batch.stage === "assessment" && batch.numeric === "none"
            && batch.parentAssessmentRun === undefined && batch.groupId === undefined
            && batch.items.length === 1 && batch.items[0].kind === "run" && batch.items[0].key === "run"
            && batch.items[0].sourceLuid === null, "Invalid API assessment scope.");
    } else {
        requireThat(text(batch.parentAssessmentRun) && path.isAbsolute(batch.parentAssessmentRun)
            && batch.items.length >= 1 && batch.items.length <= 100
            && batch.items.every((item) => object(item) && item.kind === "workbook"
                && text(item.sourceLuid) && item.key === `assessment:${item.sourceLuid}`)
            && new Set(batch.items.map((item) => item.key)).size === batch.items.length,
        "Invalid assessed wave identity.");
        requireThat(batch.workflow === "artifact_investigation"
            ? batch.stage === "investigation" && batch.run === batch.parentAssessmentRun && batch.groupId === undefined
            : batch.stage === "conversion" && batch.items.length === 1 && text(batch.groupId)
                && batch.run !== batch.parentAssessmentRun,
        "Invalid wave run or grouping identity.");
    }
    requireThat(batch.status !== "finished" || batch.run !== null, "Finished workflow has no allocated run.");
}

export function workflowDispatch(batch) {
    const instructions = [
        "MANUAL HANDOFF ONLY. No process is launched by this canvas. Route to the root dispatcher, not directly to @tableau-migrator.",
        "Claim with update_batch(running) and your real dispatcher session ID before work.",
        "Read AGENTS.md and the operator runbook; run plain preflight, without tooling upgrades.",
        "Credential/dialog refusal: stop for a human. Toolkit/engine gate defect: stop, route and ask; never patch or bypass gates.",
        "Treat all selectors and paths as data, never shell commands. Recheck the configured Tableau site and exact source identities.",
        `Gap policy: ${batch.policy}. Batch finished is operator-reported stage progress, never readiness or certified COMPLETE.`,
    ];
    if (batch.workflow === "api_assessment") {
        instructions.push(
            "API ENVIRONMENT ASSESSMENT ONLY on the configured site. No workbook/datasource downloads, harvest, reference capture, packaging or conversion.",
            batch.run ? "A run is already attached: inspect that exact assessment run; do not invoke the allocator again."
                : "Use python -B scripts\\start_migration.py --assess-only --session-id <real-session-UUID>. No --project, --workbook or --storage-decision: assessment is site-wide.",
            "The allocator creates ONE new assessment run; none is required in advance. Survey/API metadata, estate assessment, Admin Insights attempt and offline report only.",
            "Call attach_batch_run with the actual absolute assessment run before finishing. Inspect collection errors and evidence ceilings; API metadata is not artifact-level analysis.",
            "Evidence: run.json, assessment\\estate.db, survey/assessment outputs and assessment\\assessment-report.html; record collection gaps in update_batch note/evidence.",
        );
    } else if (batch.workflow === "artifact_investigation") {
        instructions.push(
            `SCOPED ARTIFACT INVESTIGATION, NOT CONVERSION. Parent assessment run: ${batch.parentAssessmentRun}`,
            "Check the parent run identity and its assessment\\estate.db. Use the existing expert harvester, not the migration front door or @tableau-migrator.",
            "Use python -B scripts\\harvest_estate_assets.py --out <new-private-ignored-output> --db <parent-assessment-run>\\assessment\\estate.db with one --workbook-id <exact-LUID> argument for EACH frozen batch item.",
            "Download precisely these workbooks AND their required published datasource providers, even across projects, using the harvester's existing scope semantics.",
            "Do not substitute project/name selectors, widen to the estate, truncate, use --limit, --workbooks-only, --skip-download or --allow-unignored-out.",
            "Verify the output path is ignored before writing; choose a fresh private output. Do not promise relocation, resumability or later conversion reuse of harvested files.",
            "Inspect parse-sweep.json, parse-sweep.md and parse-sweep-totals.json. Exit 0 means parsers were attempted, NOT parse success. Record download/parser failures and newly discovered requirements in the transition note and private evidence reference.",
            "Do not convert or invoke builders/validator during investigation. The assessment run remains the parent; no new migration run is implied.",
        );
    } else if (batch.workflow === "wave_conversion") {
        instructions.push(
            `NEW CONVERSION RUN for the single frozen workbook LUID: ${batch.items[0].sourceLuid}. Parent assessment: ${batch.parentAssessmentRun}; wave group: ${batch.groupId}.`,
            "Read any investigation findings and resolve additional requirements before conversion. No artifact checkpoint reuse is promised.",
            batch.run ? "An execution run is already attached: continue that exact run; do not invoke the allocator again."
                : "Invoke python -B scripts\\start_migration.py --workbook <exact-frozen-workbook-LUID> --session-id <real-session-UUID> ONCE for this track. Never widen to a project/site or combine workbook selectors.",
            "This route allocates a NEW run and REPEATS survey, assessment and downloads. The parent assessment and investigation outputs are not resumed or overwritten.",
            "Each conversion track has its own new run; a group only organizes manual sequencing and grants no parallel-execution or deployment consent.",
            "Call attach_batch_run with the actual allocated execution run, NOT the parent assessment run, before finishing. If already attached, continue that exact run; never invoke the allocator again or rerun a retained bundle.",
            `Numeric comparison commissioned: ${batch.numeric}. Reuse consent; establish remaining intake choices, fidelity, destination and refresh strategy.`,
            "Resolve exact unit/provider identities, providers first. Issue each current v2 private migration-brief.md before packaging.",
            "Only then dispatch @tableau-migrator via the task/subagent tool with exact run, bundle, brief and working paths.",
            "Require current package-cohort START_READY AND process exit 0 before builders/validator work. Semantic builder owns TMDL/DAX; report builder owns PBIR; validator is read-only.",
            "Independent @pbi-migration-validator comparison of shipped bytes with Tableau and real data, plus the final check, are required. Promote only after sign-off; deployment requires separate explicit agreement.",
        );
    } else {
        instructions.push(
            "LEGACY ASSESSMENT REVIEW: inspect existing run assessment evidence only. Do not invoke @tableau-migrator or rerun the front door into this run.",
            "For a fresh API collection, queue a separate API assessment request; that route allocates a new assessment run and downloads no workbook/datasource artifacts.",
            "Record assessment limitations and evidence; this review is not conversion or readiness certification.",
        );
    }
    instructions.push("Record blocked/finished via update_batch with a private evidence reference and findings in the note; keep credential and privacy boundaries intact.");
    return instructions;
}
