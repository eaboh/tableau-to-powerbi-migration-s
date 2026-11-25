import test from "node:test";
import assert from "node:assert/strict";
import { filterWorkbooks, filterViews, sortRows, filteredPlanningCsv, filterError, providerBindings, filteredHeadlines } from "../planning-data.mjs";
import { attributes } from "../planning-attributes.mjs";
import { summarizeAssessment } from "../assessment-summary.mjs";

function summary() {
    const workbook = (luid, viewsLifetime, updatedAt, complexity, extra = {}) => ({
        luid, name: "Same name", project: "Project A", projectLuid: "pa", tier: "migrate",
        complexity, updatedAt, sizeMb: 3, structureAvailable: true, hasUserReference: false, understated: false,
        signals: { sheets: 2, dashboards: 1, calcs: 1, lods: 0, tableCalcs: 0, viewsLifetime },
        activity: { subscriptions: 0, alerts: 0, customViews: 0 }, ...extra,
    });
    return summarizeAssessment({
        run: "synthetic-run", asOf: "2026-06-01T00:00:00.000Z",
        assessment: { status: "degraded", issues: [], surveySupplied: true, collectionErrors: [],
            workbooks: [
                workbook("w1", 100, "2026-01-02T00:00:00.000Z", 39, {
                    understated: true, hasUserReference: true, activity: { subscriptions: 1, alerts: 0, customViews: 0 },
                }),
                workbook("w2", 0, "2026-01-01T23:59:59.000Z", 0),
                workbook("w3", null, null, 90, {
                    project: "Project B", projectLuid: "pb", structureAvailable: false,
                    activity: { subscriptions: null, alerts: null, customViews: null },
                }),
                workbook("w4", 20, "2026-01-02T23:59:59.000Z", 40, { projectLuid: "pb" }),
            ],
            dependencies: [
                { workbookLuid: "w1", workbookName: "Same name", datasourceLuid: "da", datasourceName: "Same provider" },
                { workbookLuid: "w4", workbookName: "Same name", datasourceLuid: "db", datasourceName: "Same provider" },
            ],
            views: { status: "available", rows: [
                { luid: "v1", name: "=Unsafe", workbookLuid: "w1", viewsLifetime: 30, updatedAt: null },
                { luid: "v2", name: "Same view", workbookLuid: "w2", viewsLifetime: 0, updatedAt: null },
                { luid: "v3", name: "Same view", workbookLuid: "missing-parent", viewsLifetime: 60, updatedAt: null },
            ] },
            datasourceInventory: { status: "available", rows: [
                { luid: "da", name: "Same provider", project: "P", projectLuid: "p", updatedAt: null, certified: true, hasExtracts: false, connectionType: "sql" },
                { luid: "dc", name: "Same provider", project: "P", projectLuid: "p", updatedAt: null, certified: null, hasExtracts: null, connectionType: "" },
            ] },
        },
    });
}

const ids = (rows) => rows.map((r) => r.luid);

test("headlines aggregate complete and partial candidate evidence without manufacturing zeros", () => {
    const s = summary();
    const all = filteredHeadlines(s, s.workbooks);
    assert.equal(all.count, 4);
    assert.equal(all.percent, 100);
    assert.deepEqual(all.usage, { total: 120, max: 100, known: 3, unknown: 1 });
    assert.equal(all.usageShare, 100);
    assert.deepEqual(all.score, { total: 79, max: 40, known: 3, unknown: 1 });
    assert.equal(all.projects, 2);
    assert.equal(all.providers, 2);
    assert.equal(all.noObservedProvider, 2);
    assert.equal(all.deliberate, 1);
    assert.equal(all.deliberateUnknown, 1);
    assert.equal(all.userReferences, 1);
    assert.equal(all.understated, 1);
    assert.equal(all.latestModified, "2026-01-02T23:59:59.000Z");
    assert.equal(all.datesUnknown, 1);
    const zero = filteredHeadlines(s, filterWorkbooks(s, { usage: "zero" }));
    assert.deepEqual(zero.usage, { total: 0, max: 0, known: 1, unknown: 0 });
    assert.equal(zero.usageShare, 0);
    assert.equal(zero.percent, 25);
    const unknown = filteredHeadlines(s, filterWorkbooks(s, { usage: "unknown" }));
    assert.deepEqual(unknown.usage, { total: null, max: null, known: 0, unknown: 1 });
    assert.equal(unknown.usageShare, null);
    assert.equal(unknown.latestModified, null);
    const empty = filteredHeadlines(s, []);
    assert.equal(empty.count, 0);
    assert.equal(empty.projects, 0);
    assert.equal(empty.providers, 0);
    assert.equal(empty.usage.total, null);
    assert.equal(filteredHeadlines({ available: false }, []), null);
});

test("headline project and provider groups distinguish provisional identities and candidate links", () => {
    const s = summary();
    s.workbooks[0].projectLuid = "";
    s.workbooks[0].projectKey = "name:Project A";
    s.datasources[0].candidateWorkbookLuids = ["w2"];
    s.datasources[1].candidateWorkbookLuids = ["w2"];
    const h = filteredHeadlines(s, s.workbooks.slice(0, 2));
    assert.equal(h.projects, 2);
    assert.equal(h.provisionalProjects, 1);
    assert.equal(h.providers, 1);
    assert.equal(h.candidateProviders, 2);
    assert.equal(h.noObservedProvider, 0);
});

test("attribute ranges, identities, flags and missing data intersect existing filters", () => {
    const s = summary();
    const select = (...attributes) => ids(filterWorkbooks(s, { attributes, sort: "name:asc" }));
    assert.deepEqual(select({ key: "luid", mode: "equals", value: "W1" }), ["w1"]);
    assert.deepEqual(select({ key: "name", mode: "contains", value: "SAME" }), ["w1", "w2", "w3", "w4"]);
    assert.deepEqual(select({ key: "lods", mode: "range", min: "0", max: "0" }), ["w1", "w2", "w4"]);
    assert.deepEqual(select({ key: "sheets", mode: "unknown" }), ["w3"]);
    assert.deepEqual(select({ key: "sizeMb", mode: "range", min: "2.5", max: "3" }), ["w1", "w2", "w3", "w4"]);
    assert.deepEqual(select({ key: "hasUserReference", mode: "yes" }, { key: "subscriptions", mode: "range", min: "1" }), ["w1"]);
    assert.deepEqual(select({ key: "understated", mode: "no" }), ["w2", "w3", "w4"]);
    assert.deepEqual(select({ key: "alerts", mode: "unknown" }), ["w3"]);
    assert.deepEqual(select({ key: "createdAt", mode: "unknown" }), ["w1", "w2", "w3", "w4"]);
    s.workbooks[0].createdAt = "2024-02-29T23:59:59.000Z";
    assert.deepEqual(select({ key: "createdAt", mode: "range", min: "2024-02-29", max: "2024-02-29" }), ["w1"]);
    assert.deepEqual(ids(filterWorkbooks(s, { usage: "zero", attributes: [{ key: "understated", mode: "yes" }] })), []);
    for (const attribute of attributes) {
        assert.equal(filterError({ attributes: [{ key: attribute.key, mode: "known" }] }), "");
        const known = filterWorkbooks(s, { attributes: [{ key: attribute.key, mode: "known" }] });
        const unknown = filterWorkbooks(s, { attributes: [{ key: attribute.key, mode: "unknown" }] });
        assert.equal(known.length + unknown.length, s.workbooks.length, attribute.key);
    }
});

test("attribute validation rejects invalid operators, bounds, dates and unknown fields", () => {
    for (const attribute of [
        { key: "sizeMb", mode: "range", min: "4", max: "3" },
        { key: "sheets", mode: "range", min: "1.5" },
        { key: "sheets", mode: "range", min: "-1" },
        { key: "sheets", mode: "range", min: "9007199254740992" },
        { key: "sizeMb", mode: "range", min: "Infinity" },
        { key: "createdAt", mode: "range", min: "2025-02-29" },
        { key: "createdAt", mode: "range", min: "2026-01-02", max: "2026-01-01" },
        { key: "sizeMb", mode: "range" },
        { key: "luid", mode: "contains", value: " " },
        { key: "understated", mode: "range", min: "0" },
        { key: "__proto__", mode: "known" },
    ]) {
        assert.ok(filterError({ attributes: [attribute] }), JSON.stringify(attribute));
        assert.deepEqual(filterWorkbooks(summary(), { attributes: [attribute] }), []);
    }
    assert.ok(filterError({ attributes: "not-an-array" }));
    assert.ok(filterError({ attributes: [{ key: "sizeMb", mode: "known" }, { key: "sizeMb", mode: "unknown" }] }));
});

test("attribute-filtered CSV preserves the exact predicate metadata and candidate IDs", () => {
    const s = summary();
    const f = { attributes: [{ key: "luid", mode: "equals", value: "w2" }] };
    const selected = filterWorkbooks(s, f);
    const views = filterViews(s, selected, { restrict: true });
    const csv = filteredPlanningCsv(s, selected, views, f, { type: "all", key: "" });
    assert.deepEqual(ids(selected), ["w2"]);
    assert.deepEqual(ids(views), ["v2"]);
    assert.equal(csv.records, 2);
    assert.match(csv.content, /attributes/u);
    assert.match(csv.content, /equals/u);
    assert.doesNotMatch(csv.content, /"w1"|"v3"/u);
});

test("workbook filters intersect on exact identities, date boundaries, tier and signal", () => {
    const s = summary();
    assert.deepEqual(ids(filterWorkbooks(s, { project: "luid:pa", provider: "luid:da", band: "lower",
        tier: "migrate", usage: "used", minViews: "100", after: "2026-01-02", before: "2026-01-02", signal: "deliberate" })), ["w1"]);
    assert.deepEqual(ids(filterWorkbooks(s, { after: "2026-01-02", before: "2026-01-02" })), ["w1", "w4"]);
    assert.deepEqual(ids(filterWorkbooks(s, { project: "luid:pa", provider: "luid:db" })), []);
    assert.deepEqual(ids(filterWorkbooks(s, { usage: "zero" })), ["w2"]);
    assert.deepEqual(ids(filterWorkbooks(s, { usage: "unknown", updated: "unknown", signal: "structure-unknown" })), ["w3"]);
    assert.deepEqual(ids(filterWorkbooks(s, { signal: "user-reference" })), ["w1"]);
    assert.deepEqual(ids(filterWorkbooks(s, { signal: "understated" })), ["w1"]);
    assert.deepEqual(ids(filterWorkbooks(s, { signal: "activity-unknown" })), ["w3"]);
    assert.deepEqual(ids(filterWorkbooks(s, {}, { type: "project", key: "luid:pb" })), ["w4", "w3"]);
    assert.deepEqual(ids(filterWorkbooks(s, { band: "higher" })), ["w4"]);
    assert.equal(s.workbooks.find((w) => w.luid === "w3").signals.sheets, null);
});

test("sort is deterministic, non-mutating and keeps nulls last in both directions", () => {
    const s = summary();
    const original = ids(s.workbooks);
    assert.deepEqual(ids(filterWorkbooks(s, { sort: "score:desc" })), ["w4", "w1", "w2", "w3"]);
    assert.deepEqual(ids(filterWorkbooks(s, { sort: "viewsLifetime:asc" })), ["w2", "w4", "w1", "w3"]);
    assert.deepEqual(ids(filterWorkbooks(s, { sort: "updatedAt:desc" })), ["w4", "w1", "w2", "w3"]);
    assert.deepEqual(ids(s.workbooks), original);
    assert.deepEqual(ids(sortRows(s.workbooks, "name", "asc")), ["w1", "w2", "w3", "w4"]);
});

test("views use exact parent IDs, retain unmatched parents only without workbook restrictions", () => {
    const s = summary();
    assert.deepEqual(ids(filterViews(s, s.workbooks)), ["v3", "v1", "v2"]);
    const selected = filterWorkbooks(s, { provider: "luid:da" });
    assert.deepEqual(ids(filterViews(s, selected, { restrict: true })), ["v1"]);
    assert.deepEqual(ids(filterViews(s, selected, { restrict: true, search: "Same view" })), []);
    assert.equal(s.views.find((v) => v.luid === "v3").workbook, null);
    assert.equal(s.datasourceInventory.find((d) => d.luid === "da").confirmedConsumers, 1);
    assert.equal(s.datasourceInventory.find((d) => d.luid === "dc").confirmedConsumers, 0);
    assert.match(s.notices.join(" "), /does not mean provider-free or unused/u);
});

test("filtered export matches the complete selected IDs, not a page or similarly named objects", () => {
    const s = summary();
    const filters = { provider: "luid:da", signal: "deliberate" };
    const workbooks = filterWorkbooks(s, filters);
    const views = filterViews(s, workbooks, { restrict: true });
    const csv = filteredPlanningCsv(s, workbooks, views, filters, { type: "all", key: "" });
    assert.equal(csv.records, 2);
    assert.match(csv.content, /"w1"/u);
    assert.doesNotMatch(csv.content, /"w2"|"w3"|"w4"/u);
    assert.match(csv.content, /"'=Unsafe"/u);
    assert.match(csv.content, /"NOT_CHECKED"/u);
    assert.match(csv.content, /"tableau_view_type_unknown"/u);
    assert.match(csv.content, /assessment\/raw\/views.json/u);
    assert.match(csv.content, /no usage history/u);
});

test("invalid ranges are explicit and cannot produce an exportable candidate selection", () => {
    const filters = { after: "2026-02-02", before: "2026-01-01" };
    assert.match(filterError(filters), /must not be later/u);
    assert.deepEqual(filterWorkbooks(summary(), filters), []);
    assert.match(filterError({ minViews: "-1" }), /whole number/u);
    assert.match(filterError({ minViews: "1.5" }), /whole number/u);
    assert.equal(filterError({ minViews: "0" }), "");
    assert.match(filterError({ maxViews: "-1" }), /whole number/u);
    assert.match(filterError({ minViews: "20", maxViews: "19" }), /must not exceed/u);
    assert.deepEqual(ids(filterWorkbooks(summary(), { maxViews: "0" })), ["w2"]);
    assert.deepEqual(ids(filterWorkbooks(summary(), { maxViews: 0 })), ["w2"]);
    assert.deepEqual(ids(filterWorkbooks(summary(), { minViews: "20", maxViews: "99" })), ["w4"]);
});

test("filtered export labels confirmed and name-only provider bindings per workbook", () => {
    const s = summary();
    s.datasources[0].candidateWorkbookLuids.push("w4");
    const workbooks = filterWorkbooks(s, { provider: "luid:da" });
    assert.deepEqual(ids(workbooks), ["w1", "w4"]);
    assert.equal(providerBindings(s, "w1")[0].binding, "LUID-linked consumer");
    const candidate = providerBindings(s, "w4").find((p) => p.luid === "da");
    assert.equal(candidate.binding, "Name-only consumer candidate - verify binding");
    assert.equal(candidate.key, "luid:da");
    const csv = filteredPlanningCsv(s, workbooks, [], { provider: "luid:da" }, { type: "all", key: "" });
    assert.match(csv.content, /"provider_bindings"/u);
    assert.match(csv.content, /LUID-linked consumer/u);
    assert.match(csv.content, /Name-only consumer candidate - verify binding/u);
    assert.match(csv.content, /luid:da/u);
});
