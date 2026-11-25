const DAY = 86_400_000;
const dayNumber = (date) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY;
export const dayLabel = (day) => new Date(day * DAY).toISOString().slice(0, 10);

export function dateDomain(workbooks) {
    const days = workbooks.filter((w) => w.updatedAt).map((w) => dayNumber(w.updatedAt)).filter(Number.isFinite);
    return {
        min: days.length ? Math.min(...days) : null, max: days.length ? Math.max(...days) : null,
        known: days.length, unknown: workbooks.length - days.length,
    };
}

export function periodBounds(key) {
    if (key.length === 4) return { after: `${key}-01-01`, before: `${key}-12-31` };
    const [year, month] = key.split("-").map(Number);
    return { after: `${key}-01`, before: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) };
}

export function intersectChartFilters(current, changes) {
    const next = { ...changes };
    if (next.after && current.after) next.after = next.after > current.after ? next.after : current.after;
    if (next.before && current.before) next.before = next.before < current.before ? next.before : current.before;
    if (next.usage !== "unknown" && Object.hasOwn(next, "minViews")) {
        if (current.minViews !== "" && current.minViews !== undefined) {
            next.minViews = String(Math.max(Number(next.minViews || 0), Number(current.minViews)));
        }
        if (current.maxViews !== "" && current.maxViews !== undefined) {
            next.maxViews = String(Math.min(next.maxViews === "" ? Infinity : Number(next.maxViews), Number(current.maxViews)));
        }
    }
    return next;
}

export function chartData(workbooks, domain) {
    const complexity = [
        { key: "zero", label: "Zero / verify structure" }, { key: "lower", label: "Score 1-39" },
        { key: "higher", label: "Score 40+" }, { key: "unknown", label: "Unavailable score" },
    ].map((bin) => ({ ...bin, count: workbooks.filter((w) => w.band === bin.key).length, filters: { band: bin.key } }));
    const usage = [
        { key: "zero", label: "0 lifetime views", min: 0, max: 0 },
        { key: "small", label: "1-9 lifetime views", min: 1, max: 9 },
        { key: "medium", label: "10-99 lifetime views", min: 10, max: 99 },
        { key: "large", label: "100-999 lifetime views", min: 100, max: 999 },
        { key: "highest", label: "1,000+ lifetime views", min: 1000, max: Infinity },
        { key: "unknown", label: "Unknown usage" },
    ].map((bin) => ({
        key: bin.key, label: bin.label,
        count: workbooks.filter((w) => bin.key === "unknown" ? w.signals.viewsLifetime === null
            : w.signals.viewsLifetime !== null && w.signals.viewsLifetime >= bin.min && w.signals.viewsLifetime <= bin.max).length,
        filters: bin.key === "unknown" ? { usage: "unknown", minViews: "", maxViews: "" }
            : { usage: "", minViews: String(bin.min), maxViews: bin.max === Infinity ? "" : String(bin.max) },
    }));
    const projects = new Map();
    const periods = new Map();
    const yearly = domain.min !== null && (new Date(domain.max * DAY).getUTCFullYear() * 12
        + new Date(domain.max * DAY).getUTCMonth()
        - new Date(domain.min * DAY).getUTCFullYear() * 12 - new Date(domain.min * DAY).getUTCMonth()) > 24;
    for (const w of workbooks) {
        if (!projects.has(w.projectKey)) projects.set(w.projectKey, {
            key: w.projectKey, label: `${w.project} (${w.projectLuid ? w.projectLuid : "provisional / unknown identity"})`,
            count: 0, filters: { project: w.projectKey },
        });
        projects.get(w.projectKey).count++;
        if (w.updatedAt) {
            const key = w.updatedAt.slice(0, yearly ? 4 : 7);
            periods.set(key, (periods.get(key) ?? 0) + 1);
        }
    }
    const ranked = [...projects.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const dates = [...periods.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({
        key, label: key, count, filters: { ...periodBounds(key), updated: "known" },
    }));
    dates.push({ key: "unknown", label: "Unknown modification date",
        count: workbooks.filter((w) => !w.updatedAt).length, filters: { updated: "unknown", after: "", before: "" } });
    const points = workbooks.filter((w) => w.score !== null && w.signals.viewsLifetime !== null)
        .map((w) => ({ luid: w.luid, name: w.name, score: w.score, views: w.signals.viewsLifetime }));
    return { complexity, usage, projects: ranked.slice(0, 10),
        otherProjects: ranked.slice(10).reduce((sum, p) => sum + p.count, 0),
        dates, period: yearly ? "year" : "month", points, omittedPoints: workbooks.length - points.length };
}

export function createPlanningCharts({ node, getSummary, getFilters, onFilter, readOnly = false }) {
    const document = node("div").ownerDocument;
    const $ = (id) => document.getElementById(id);
    let syncingDates = false;
    const sliderIds = ["planning-date-from", "planning-date-through"];

    function syncDates(domain) {
        syncingDates = true;
        try {
            const filters = getFilters();
            for (const [index, id] of sliderIds.entries()) {
                const slider = $(id);
                slider.min = domain.min ?? 0;
                slider.max = domain.max ?? 0;
                const value = index === 0 ? filters.after : filters.before;
                const fallback = index === 0 ? domain.min : domain.max;
                const selected = value ? dayNumber(value) : fallback;
                slider.value = domain.min === null ? 0 : Math.max(domain.min, Math.min(domain.max, selected));
                slider.disabled = domain.min === null || domain.min === domain.max;
                const label = domain.min === null ? "No known dates" : value || dayLabel(fallback);
                slider.setAttribute("aria-valuetext", label);
                $(`${id}-value`).textContent = label;
            }
            const selection = filters.after || filters.before ? "Date bounds exclude unknown dates."
                : filters.updated === "known" ? "Only workbooks with known dates are selected."
                    : filters.updated === "unknown" ? "Only workbooks with unknown dates are selected."
                        : "No date bounds: unknown dates included.";
            $("planning-date-coverage").textContent = domain.min === null
                ? `No known modification dates; ${domain.unknown} unknown. Date sliders are unavailable.`
                : `${dayLabel(domain.min)} to ${dayLabel(domain.max)} / ${domain.known} known, ${domain.unknown} unknown dates in the whole assessment. ${selection}`;
        } finally {
            syncingDates = false;
        }
    }

    for (const [index, id] of sliderIds.entries()) $(id).addEventListener("input", () => {
        if (syncingDates) return;
        const domain = dateDomain(getSummary()?.workbooks ?? []);
        if (domain.min === null) return;
        const from = Number($(sliderIds[0]).value);
        const through = Number($(sliderIds[1]).value);
        onFilter({
            after: dayLabel(index === 1 ? Math.min(from, through) : from),
            before: dayLabel(index === 0 ? Math.max(from, through) : through), updated: "known",
        });
    });
    $("planning-clear-dates").addEventListener("click", () => onFilter({ after: "", before: "", updated: "" }));
    $("planning-chart-reset").addEventListener("click", () => $("planning-reset").click());

    function bars(id, bins) {
        const container = $(id);
        const active = container.ownerDocument.activeElement;
        const activeKey = container.contains(active) ? active.dataset.chartKey : null;
        const max = Math.max(1, ...bins.map((b) => b.count));
        container.replaceChildren();
        for (const bin of bins) {
            const button = node("button", undefined, "chart-bar");
            button.type = "button";
            button.dataset.chartKey = `${id}:${bin.key}`;
            button.setAttribute("aria-label", `${bin.label}: ${bin.count} workbooks. Filter candidates.`);
            button.disabled = bin.count === 0;
            const label = node("span", bin.label, "chart-label");
            const meter = node("meter");
            meter.min = 0;
            meter.max = max;
            meter.value = bin.count;
            meter.setAttribute("aria-hidden", "true");
            button.append(label, meter, node("strong", String(bin.count)));
            button.addEventListener("click", () => onFilter(intersectChartFilters(getFilters(), bin.filters)));
            container.append(button);
        }
        if (activeKey) {
            const target = [...container.children].find((item) => item.dataset.chartKey === activeKey && !item.disabled);
            (target ?? $("planning-charts-heading")).focus({ preventScroll: true });
        }
    }

    function scatter(points, omitted) {
        const container = $("planning-scatter");
        container.replaceChildren();
        $("planning-scatter-note").textContent = `${points.length} workbooks plotted; ${omitted} omitted because usage or complexity is unknown. Both axes use log(1 + value); points may overlap. Raw values are in tooltips and the workbook table.`;
        if (!points.length) {
            container.append(node("p", "No workbooks with both usage and complexity available.", "muted"));
            return;
        }
        const doc = container.ownerDocument;
        const svgNode = (tag, attributes, text) => {
            const item = doc.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
            if (text !== undefined) item.textContent = text;
            return item;
        };
        const svg = svgNode("svg", { viewBox: "0 0 560 280", role: "img", "aria-labelledby": "planning-scatter-title planning-scatter-description" });
        svg.append(svgNode("title", { id: "planning-scatter-title" }, "Workbook lifetime usage versus structural complexity"),
            svgNode("desc", { id: "planning-scatter-description" }, $("planning-scatter-note").textContent));
        const maxScore = points.reduce((m, p) => Math.max(m, p.score), 1);
        const maxViews = points.reduce((m, p) => Math.max(m, p.views), 1);
        const x = (n) => 70 + Math.log1p(n) / Math.log1p(maxScore) * 465;
        const y = (n) => 220 - Math.log1p(n) / Math.log1p(maxViews) * 195;
        svg.append(svgNode("path", { d: "M70 25V220H535", class: "chart-axis" }));
        for (const [max, position, axis] of [[maxScore, x, "x"], [maxViews, y, "y"]]) {
            const ticks = [...new Set([0, Math.round(Math.expm1(Math.log1p(max) / 2)), max])];
            for (const value of ticks) {
                svg.append(svgNode("text", axis === "x"
                    ? { x: position(value), y: 242, "text-anchor": "middle", class: "chart-tick" }
                    : { x: 60, y: position(value) + 4, "text-anchor": "end", class: "chart-tick" }, value.toLocaleString()));
            }
        }
        svg.append(svgNode("text", { x: 300, y: 270, "text-anchor": "middle", class: "chart-tick" }, "Structural complexity (log scale)"),
            svgNode("text", { x: 70, y: 14, class: "chart-tick" }, "Lifetime views (log scale)"));
        for (const p of points) {
            const circle = svgNode("circle", { cx: x(p.score), cy: y(p.views), r: 4, class: "scatter-point" });
            circle.append(svgNode("title", {}, `${p.name} / ${p.luid}: complexity ${p.score}, lifetime views ${p.views}`));
            svg.append(circle);
        }
        container.append(svg);
    }

    function render(workbooks) {
        const summary = getSummary();
        const domain = dateDomain(summary?.workbooks ?? []);
        syncDates(domain);
        const data = chartData(workbooks, domain);
        $("planning-chart-status").textContent = summary?.available
            ? `${workbooks.length} filtered candidate workbooks. Click a bar to intersect the existing filters; charts, table, export${readOnly ? "" : " and batch selection"} use the same candidates. Reset to widen the scope.`
            : "No assessable workbook evidence. Charts do not imply an empty estate.";
        bars("planning-chart-complexity", data.complexity);
        bars("planning-chart-usage", data.usage);
        bars("planning-chart-projects", data.projects);
        bars("planning-chart-dates", data.dates);
        $("planning-chart-projects-note").textContent = `Top 10 groups by filtered workbook count; ${data.otherProjects} workbooks in other groups (not selectable as a single project). Name-only groups remain provisional.`;
        $("planning-chart-dates-title").textContent = `Last modified by ${data.period}`;
        $("planning-chart-dates-note").textContent = "Count of workbooks by their last modification date, not usage over time. Click a period to filter inclusive UTC dates.";
        scatter(data.points, data.omittedPoints);
    }
    return { render, applyAvailability: () => syncDates(dateDomain(getSummary()?.workbooks ?? [])) };
}
