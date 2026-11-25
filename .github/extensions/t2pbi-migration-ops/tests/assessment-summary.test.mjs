import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAssessment, assessmentSummaryCsv } from "../assessment-summary.mjs";

function snapshot() {
    const workbook = (luid, name, projectLuid, score, tier, extra = {}) => ({
        luid, name, project: "Same project", projectLuid, complexity: score, tier,
        structureAvailable: true, hasUserReference: false, understated: false,
        signals: { sheets: 1, dashboards: 0, calcs: 1, lods: 0, tableCalcs: 0, viewsLifetime: 10 },
        ...extra,
    });
    const edge = (datasourceLuid, datasourceName, workbookLuid, workbookName) =>
        ({ datasourceLuid, datasourceName, workbookLuid, workbookName });
    return {
        run: "synthetic-run", asOf: "2026-01-02T03:04:05.000Z",
        assessment: {
            status: "inventory_observed", issues: [], outputs: [], surveySupplied: true, collectionErrors: [],
            workbooks: [
                workbook("w1", "Book A", "p1", 0, "migrate"),
                workbook("w2", "Book B", "p1", 39, "migrate", { understated: true }),
                workbook("w3", "Book C", "p2", 40, "review", { understated: true, hasUserReference: true }),
                workbook("w4", "Same name", "", 100, "archive", { structureAvailable: false, hasUserReference: null, understated: null }),
                workbook("w5", "Same name", "", null, "retire-candidate", { project: "", hasUserReference: null, understated: null }),
            ],
            dependencies: [
                edge("da", "Same provider", "w1", "Book A"),
                edge("da", "Same provider", "w1", "Book A"),
                edge("da", "Same provider", "", "Book B"),
                edge("da", "Same provider", "w2", "Book B"),
                edge("db", "Same provider", "w3", "Book C"),
                edge("", "Same provider", "w1", "Book A"),
                edge("", "Unresolved provider", "", "Same name"),
                edge("da", "Same provider", "outside", "Book A"),
                edge("da", "Same provider", "", "Book C"),
            ],
        },
    };
}

test("project identities remain distinct and all aggregates reconcile with workbook scope", () => {
    const summary = summarizeAssessment(snapshot());
    assert.equal(summary.available, true);
    assert.equal(summary.totals.workbooks, 5);
    assert.equal(summary.projects.length, 4);
    assert.equal(summary.projects.filter((p) => p.name === "Same project").length, 3);
    assert.equal(summary.projects.find((p) => p.key === "luid:p1").stats.workbooks, 2);
    assert.equal(summary.projects.find((p) => p.key === "luid:p1").datasourceGroups, 2);
    assert.equal(summary.projects.find((p) => p.key === "luid:p2").datasourceGroups, 1);
    assert.equal(summary.projects.reduce((sum, p) => sum + p.stats.workbooks, 0), 5);
    assert.equal(summary.complexity.reduce((sum, band) => sum + band.stats.workbooks, 0), 5);
    assert.equal(Object.values(summary.totals.tiers).reduce((sum, count) => sum + count, 0), 5);
    assert.equal(summary.totals.scoreTotal, 79);
    assert.equal(summary.totals.scoreMax, 40);
    assert.equal(summary.totals.understated, 2);
    assert.equal(summary.totals.understatementUnknown, 2);
});

test("provider/consumer identities deduplicate exactly without confirming name-only joins", () => {
    const summary = summarizeAssessment(snapshot());
    assert.equal(summary.datasources.length, 4);
    assert.equal(summary.totals.confirmedEdges, 4);
    assert.equal(summary.totals.candidateEdges, 1);
    assert.equal(summary.totals.unresolvedEdges, 2);
    assert.equal(summary.totals.duplicateEdges, 2);
    const shared = summary.datasources.find((p) => p.key === "luid:da");
    assert.deepEqual(shared.workbookLuids.sort(), ["w1", "w2"]);
    assert.deepEqual(shared.candidateWorkbookLuids, ["w3"]);
    assert.equal(shared.projectGroups, 1);
    assert.equal(shared.stats.tiers.migrate, 2);
    assert.equal(shared.unresolvedReferences, 1);
    assert.equal(summary.datasources.find((p) => p.key === "name:Same provider").identity, "name-only group");
    assert.equal(summary.datasources.find((p) => p.key === "name:Unresolved provider").confirmedConsumers, 0);
});

test("complexity bins honor zero/39/40 boundaries and per-workbook structural gaps", () => {
    const summary = summarizeAssessment(snapshot());
    assert.deepEqual(summary.complexity.map((band) => [band.key, band.stats.workbooks]),
        [["zero", 1], ["lower", 1], ["higher", 1], ["unknown", 2]]);
    assert.equal(summary.workbooks.find((w) => w.luid === "w4").reportedScore, 100);
    assert.equal(summary.workbooks.find((w) => w.luid === "w4").score, null);
    assert.equal(summary.totals.userReferences, 1);
    assert.equal(summary.totals.userReferencesUnknown, 2);
});

test("only structure-primary voids all scores, not unrelated primary failures", () => {
    const input = snapshot();
    input.assessment.status = "incomplete";
    input.assessment.collectionErrors = [{ listing: "views", severity: "primary" }];
    assert.equal(summarizeAssessment(input).totals.scoreTotal, 79);
    input.assessment.collectionErrors = [{ listing: "structure", severity: "primary" }];
    const failed = summarizeAssessment(input);
    assert.equal(failed.totals.unknownScores, 5);
    assert.equal(failed.totals.scoreTotal, null);
    assert.equal(failed.totals.highScores, 0);
    assert.match(failed.notices.join(" "), /Structure listing failed/u);
    input.assessment.collectionErrors[0].severity = "secondary";
    assert.equal(summarizeAssessment(input).totals.scoreTotal, 79);
    assert.match(summarizeAssessment(input).notices.join(" "), /Structure listing is partial/u);
});

test("old snapshots and missing survey remain usable without fabricating coverage or flags", () => {
    const input = snapshot();
    delete input.assessment.surveySupplied;
    delete input.assessment.collectionErrors;
    for (const w of input.assessment.workbooks) {
        delete w.projectLuid;
        delete w.structureAvailable;
        delete w.hasUserReference;
        delete w.understated;
        delete w.signals;
    }
    const summary = summarizeAssessment(input);
    assert.equal(summary.available, true);
    assert.equal(summary.totals.understatementUnknown, 5);
    assert.equal(summary.totals.userReferencesUnknown, 5);
    assert.equal(summary.workbooks[0].signals.lods, null);
    assert.match(summary.notices.join(" "), /lacks planning metadata/u);
    assert.match(summary.notices.join(" "), /completeness are unknown/u);
    input.assessment.dependencies = [];
    assert.equal(summarizeAssessment(input).totals.referencedDatasourceGroups, 0);
    assert.match(summarizeAssessment(input).notices.join(" "), /even when no edges/u);
});

test("unassessable/no snapshot does not manufacture zero-sized estates", () => {
    const missing = summarizeAssessment(null);
    assert.equal(missing.totals, null);
    assert.deepEqual(missing.projects, []);
    const input = snapshot();
    input.assessment.status = "unassessable";
    const failed = summarizeAssessment(input);
    assert.equal(failed.available, false);
    assert.equal(failed.totals, null);
    assert.match(assessmentSummaryCsv(failed).content, /"unassessable"/u);
});

test("planning CSV uses the same identities, counts, timing, caveats and formula protection", () => {
    const input = snapshot();
    input.assessment.workbooks[0].project = "=project-formula";
    input.assessment.dependencies[0].datasourceName = "=provider-formula";
    const summary = summarizeAssessment(input);
    const output = assessmentSummaryCsv(summary);
    assert.equal(output.records, 13);
    assert.match(output.content, /"project_summary"/u);
    assert.match(output.content, /"datasource_summary"/u);
    assert.match(output.content, /"complexity_summary"/u);
    assert.match(output.content, /"'=project-formula"/u);
    assert.match(output.content, /"'=provider-formula"/u);
    assert.match(output.content, /"2026-01-02T03:04:05.000Z"/u);
    assert.match(output.content, /"NOT_CHECKED"/u);
    assert.match(output.content, /not a full inventory/u);
});
