/* global document */
const palette = ["#129d97", "#edab28", "#697b96", "#f2787d", "#a9b5c5"];
const number = (value) => value.toLocaleString();
export const knownUsageWorkbooks = (summary) => (summary?.available ? summary.workbooks : [])
    .filter((w) => Number.isFinite(w.signals.viewsLifetime) && w.signals.viewsLifetime >= 0);
function svgNode(tag, attributes = {}, text) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
}

export function renderPlanningOverview(summary, node, topN = 20) {
    const $ = (id) => document.getElementById(id);
    const workbooks = summary.available ? summary.workbooks : [];
    const known = knownUsageWorkbooks(summary);
    const totalUsage = known.reduce((sum, w) => sum + w.signals.viewsLifetime, 0);
    const limit = Math.min(Math.max(1, Math.trunc(topN)), Math.max(1, known.length));
    const slider = $("planning-usage-top");
    slider.max = Math.max(1, known.length);
    slider.value = limit;
    slider.disabled = known.length < 2 || totalUsage === 0;
    $("planning-usage-top-value").textContent = known.length
        ? `${limit} of ${number(known.length)} known` : "No known usage";
    $("planning-lifetime-count").textContent = summary.available && known.length ? number(totalUsage) : "Unknown";
    $("planning-lifetime-coverage").textContent = `${known.length} known / ${workbooks.length - known.length} unknown workbooks`;
    $("planning-published-count").textContent = summary.datasourceStatus === "available"
        ? number(summary.datasourceInventory.length) : "Unknown";
    $("planning-quality-state").textContent = summary.status.replaceAll("_", " ");
    $("planning-quality-coverage").textContent = summary.available
        ? `${number(workbooks.length)} observed workbooks; scope may be partial` : "Assessment evidence unavailable";
    $("planning-quality-gaps").textContent = summary.totals
        ? `${summary.totals.unknownScores} unknown scores / ${summary.totals.unresolvedEdges} unresolved dependencies`
        : "Unknown is not zero";

    function chart(id, label) {
        const container = $(id);
        container.replaceChildren();
        if (!summary.available || !workbooks.length) {
            container.append(node("p", summary.available ? "No observed workbooks." : "Assessment unavailable.", "muted"));
            return null;
        }
        const svg = svgNode("svg", { viewBox: "0 0 360 180", role: "img", "aria-label": label });
        svg.append(svgNode("title", {}, label));
        container.append(svg);
        return { container, svg };
    }
    function legend(container, groups) {
        const list = node("ul", undefined, "overview-legend");
        groups.forEach((group, index) => {
            const item = node("li");
            const dot = svgNode("svg", { viewBox: "0 0 12 12", "aria-hidden": "true" });
            dot.append(svgNode("circle", { cx: 6, cy: 6, r: 5, fill: palette[index] }));
            item.append(dot, node("span", `${group.name}: ${number(group.count)} (${(group.count / workbooks.length * 100).toFixed(1)}%)`));
            list.append(item);
        });
        container.append(list);
    }
    const tiers = [
        ["migrate", "Migrate"], ["review", "Review"], ["archive", "Archive"],
        ["retire-candidate", "Retire candidate"], ["unknown", "Unknown"],
    ].map(([key, name]) => ({ name, count: summary.totals?.tiers[key] ?? 0 }));
    const recommendations = chart("planning-overview-recommendations", "Recommendation shares of all observed workbooks");
    if (recommendations) {
        let x = 0;
        tiers.forEach((group, index) => {
            const width = group.count / workbooks.length * 340;
            const rect = svgNode("rect", { x: 10 + x, y: 42, width, height: 66, fill: palette[index] });
            rect.append(svgNode("title", {}, `${group.name}: ${group.count}`));
            recommendations.svg.append(rect);
            if (width > 46) recommendations.svg.append(svgNode("text",
                { x: 10 + x + width / 2, y: 80, "text-anchor": "middle", class: "overview-percent" },
                `${Math.round(group.count / workbooks.length * 100)}%`));
            x += width;
        });
        legend(recommendations.container, tiers);
    }
    const complexity = chart("planning-overview-complexity", "Structural complexity bands of all observed workbooks");
    if (complexity) {
        let offset = 0;
        const bands = summary.complexity.map((band) => ({ name: band.name, count: band.stats.workbooks }));
        const circumference = 2 * Math.PI * 62;
        bands.forEach((group, index) => {
            const length = group.count / workbooks.length * circumference;
            complexity.svg.append(svgNode("circle", { cx: 180, cy: 88, r: 62, fill: "none",
                stroke: palette[index], "stroke-width": 27, "stroke-dasharray": `${length} ${circumference}`,
                "stroke-dashoffset": -offset, transform: "rotate(-90 180 88)" }));
            offset += length;
        });
        complexity.svg.append(svgNode("text", { x: 180, y: 89, "text-anchor": "middle", class: "overview-total" }, number(workbooks.length)),
            svgNode("text", { x: 180, y: 109, "text-anchor": "middle", class: "chart-tick" }, "workbooks"));
        legend(complexity.container, bands);
    }
    const usage = chart("planning-overview-usage", `Top ${limit} workbooks by lifetime views, with cumulative share of all known lifetime views`);
    if (usage) {
        if (!known.length || totalUsage === 0) {
            usage.svg.remove();
            usage.container.append(node("p", known.length ? "Known lifetime views total zero; no usage share can be calculated." : "Lifetime usage unavailable.", "muted"));
        } else {
            const ranked = [...known].sort((a, b) => b.signals.viewsLifetime - a.signals.viewsLifetime);
            const top = ranked.slice(0, limit);
            const maximum = top[0].signals.viewsLifetime;
            let cumulative = 0;
            const points = [];
            usage.svg.append(svgNode("path", { d: "M32 20V150H326", class: "chart-axis" }),
                svgNode("text", { x: 32, y: 13, class: "chart-tick" }, number(maximum)),
                svgNode("text", { x: 326, y: 13, "text-anchor": "end", class: "chart-tick" }, "100%"));
            top.forEach((w, index) => {
                const width = 288 / top.length;
                const x = 36 + index * width;
                const height = w.signals.viewsLifetime / maximum * 122;
                cumulative += w.signals.viewsLifetime;
                const rect = svgNode("rect", { x, y: 150 - height, width: width * .8, height, fill: palette[0] });
                rect.append(svgNode("title", {}, `${w.name}: ${number(w.signals.viewsLifetime)} lifetime views; ${(cumulative / totalUsage * 100).toFixed(1)}% cumulative known usage`));
                usage.svg.append(rect);
                points.push(`${x + width / 2},${150 - cumulative / totalUsage * 122}`);
            });
            usage.svg.append(svgNode("polyline", { points: points.join(" "), fill: "none", stroke: "#315f95", "stroke-width": 2 }),
                svgNode("text", { x: 32, y: 170, class: "chart-tick" }, `Rank 1-${top.length} of ${known.length} known workbooks`));
            const [endX, endY] = points.at(-1).split(",").map(Number);
            const coverage = (cumulative / totalUsage * 100).toFixed(1);
            const calloutX = Math.max(8, Math.min(240, endX - 56));
            const calloutY = endY < 70 ? endY + 14 : endY - 48;
            const description = `Top ${top.length} workbooks cover ${coverage}% of known lifetime views: ${number(cumulative)} of ${number(totalUsage)} views. ${workbooks.length - known.length} workbooks have unknown usage.`;
            const marker = svgNode("g", { class: "usage-coverage-marker", tabindex: 0, role: "img", "aria-label": description });
            marker.append(svgNode("title", {}, description),
                svgNode("line", { x1: endX, y1: endY, x2: endX, y2: endY < 70 ? calloutY : calloutY + 36, class: "usage-coverage-leader" }),
                svgNode("circle", { cx: endX, cy: endY, r: 4, class: "usage-coverage-dot" }),
                svgNode("rect", { x: calloutX, y: calloutY, width: 112, height: 36, rx: 6, class: "usage-coverage-badge" }),
                svgNode("text", { x: calloutX + 56, y: calloutY + 15, "text-anchor": "middle", class: "usage-coverage-percent" }, `${coverage}% coverage`),
                svgNode("text", { x: calloutX + 56, y: calloutY + 29, "text-anchor": "middle", class: "usage-coverage-count" }, `Top ${number(top.length)} workbooks`));
            usage.svg.append(marker);
            usage.container.append(node("p", `Bars: lifetime views (left scale). Line: cumulative share (right scale, 0-100%) of all ${number(totalUsage)} known views. Top ${top.length} account for ${(cumulative / totalUsage * 100).toFixed(1)}%.`, "muted"));
            const details = node("details");
            details.append(node("summary", "Usage chart values"));
            const list = node("ol");
            top.forEach((w) => list.append(node("li", `${w.name}: ${number(w.signals.viewsLifetime)} lifetime views`)));
            details.append(list);
            usage.container.append(details);
        }
        usage.container.append(node("p", `${known.length} known / ${workbooks.length - known.length} unknown workbooks. Lifetime totals, not usage over time.`, "muted"));
    }
}
