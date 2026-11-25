import test from "node:test";
import assert from "node:assert/strict";
import { dateDomain, dayLabel, periodBounds, chartData, intersectChartFilters } from "../planning-charts.mjs";
import { filterWorkbooks } from "../planning-data.mjs";

function workbooks() {
    return [
        ["a", 0, "zero", 0, "2024-02-29T23:59:59.000Z"],
        ["b", 9, "lower", 39, "2024-03-01T00:00:00.000Z"],
        ["c", 10, "higher", 40, "2024-02-01T00:00:00.000Z"],
        ["d", 99, "unknown", null, null],
        ["e", 100, "higher", 60, null],
        ["f", 999, "lower", 1, null],
        ["g", 1000, "higher", 80, null],
        ["h", null, "unknown", null, null],
    ].map(([luid, viewsLifetime, band, score, updatedAt], index) => ({
        luid, name: "Workbook", project: "Same project", projectLuid: index % 2 ? "p1" : "p2",
        projectKey: index % 2 ? "luid:p1" : "luid:p2", band, score, updatedAt,
        tier: "migrate", signals: { viewsLifetime }, activity: {},
    }));
}

test("chart partitions reconcile zero, unknown and usage/complexity boundaries without sampling", () => {
    const rows = workbooks();
    const chart = chartData(rows, dateDomain(rows));
    assert.deepEqual(chart.usage.map((b) => b.count), [1, 1, 2, 2, 1, 1]);
    assert.deepEqual(chart.complexity.map((b) => b.count), [1, 2, 3, 2]);
    assert.equal(chart.usage.reduce((n, b) => n + b.count, 0), 8);
    assert.equal(chart.dates.reduce((n, b) => n + b.count, 0), 8);
    assert.equal(chart.points.length, 6);
    assert.equal(chart.omittedPoints, 2);
    assert.equal(chart.points.find((p) => p.luid === "a").views, 0);
    assert.equal(chart.projects.length, 2);
    assert.notEqual(chart.projects[0].key, chart.projects[1].key);
    assert.equal(chart.projects[0].count, 4);
});

test("UTC date domains and inclusive periods handle midnight, leap day, same-day and missing dates", () => {
    const domain = dateDomain(workbooks());
    assert.equal(dayLabel(domain.min), "2024-02-01");
    assert.equal(dayLabel(domain.max), "2024-03-01");
    assert.equal(domain.unknown, 5);
    assert.deepEqual(periodBounds("2024-02"), { after: "2024-02-01", before: "2024-02-29" });
    assert.deepEqual(periodBounds("2023-02"), { after: "2023-02-01", before: "2023-02-28" });
    assert.deepEqual(periodBounds("2024-12"), { after: "2024-12-01", before: "2024-12-31" });
    assert.deepEqual(periodBounds("2024"), { after: "2024-01-01", before: "2024-12-31" });
    const sameDay = dateDomain(workbooks().slice(0, 1));
    assert.equal(sameDay.min, sameDay.max);
    assert.equal(dayLabel(sameDay.max), "2024-02-29");
    assert.deepEqual(dateDomain([{ updatedAt: null }]), { min: null, max: null, known: 0, unknown: 1 });
    assert.deepEqual(dateDomain([]), { min: null, max: null, known: 0, unknown: 0 });
});

test("each clickable bucket selects exactly its represented candidate IDs via existing filters", () => {
    const rows = workbooks();
    const chart = chartData(rows, dateDomain(rows));
    const summary = { available: true, workbooks: rows, datasources: [] };
    for (const bin of [...chart.usage, ...chart.complexity, ...chart.dates, ...chart.projects]) {
        assert.equal(filterWorkbooks(summary, bin.filters).length, bin.count, bin.label);
    }
    const current = { minViews: "15", maxViews: "20", after: "2024-02-10", before: "2024-02-20" };
    assert.deepEqual(intersectChartFilters(current, { usage: "", minViews: "10", maxViews: "99" }),
        { usage: "", minViews: "15", maxViews: "20" });
    assert.deepEqual(intersectChartFilters(current, periodBounds("2024-02")),
        { after: "2024-02-10", before: "2024-02-20" });
});

test("project top10 preserves identity and discloses every other workbook without a fake group", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
        ...workbooks()[0], luid: `w${i}`, projectKey: `luid:p${i}`, projectLuid: `p${i}`,
    }));
    const chart = chartData(rows, dateDomain(rows));
    assert.equal(chart.projects.length, 10);
    assert.equal(chart.otherProjects, 5);
    assert.equal(chart.projects.reduce((n, b) => n + b.count, 0) + chart.otherProjects, 15);
});

test("long modification spans use yearly periods while empty evidence remains empty", () => {
    const rows = [{ ...workbooks()[0], updatedAt: "2019-12-31T23:59:59.000Z" }, workbooks()[0]];
    const chart = chartData(rows, dateDomain(rows));
    assert.equal(chart.period, "year");
    assert.deepEqual(chart.dates.map((b) => b.key), ["2019", "2024", "unknown"]);
    assert.equal(chartData([], dateDomain([])).points.length, 0);
    assert.equal(chartData([], dateDomain([])).usage.reduce((n, b) => n + b.count, 0), 0);
});
