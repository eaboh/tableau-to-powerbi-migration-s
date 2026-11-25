import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { requireThat } from "./common.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const modules = ["csv.mjs", "planning-attributes.mjs", "planning-data.mjs",
    "planning-charts.mjs", "planning-overview.mjs", "planning.js"];
const json = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

// This deliberately supports only our fixed, named-import browser graph, not arbitrary JS.
export function bundlePlanning(readAsset = read) {
    const loaded = new Set();
    const result = modules.map((file) => {
        const exports = [];
        let source = readAsset(file).replace(/^import \{ ([\w,\s]+) \} from "(\.\/[\w.-]+)";$/gmu,
            (_line, names, dependency) => {
                requireThat(loaded.has(dependency), `Unsupported offline dependency in ${file}.`);
                return `const { ${names} } = offlineModules[${JSON.stringify(dependency)}];`;
            }).replace(/^export (function|const) (\w+)/gmu, (_declaration, kind, name) => {
                exports.push(name);
                return `${kind} ${name}`;
            });
        requireThat(exports.length && !/^\s*(?:import|export)\b|import\s*\(/mu.test(source),
            `Unsupported offline module syntax in ${file}.`);
        loaded.add(`./${file}`);
        return `offlineModules[${JSON.stringify(`./${file}`)}] = (() => {\n${source}\nreturn { ${exports.join(", ")} };\n})();`;
    });
    return `const offlineModules = Object.create(null);\n${result.join("\n")}`;
}

function planningMarkup() {
    const html = read("index.html");
    const start = "<!-- BEGIN OFFLINE PLANNING -->", end = "<!-- END OFFLINE PLANNING -->";
    requireThat(html.split(start).length === 2 && html.split(end).length === 2
        && html.indexOf(start) < html.indexOf(end), "Offline planning markup boundary is unavailable.");
    return html.slice(html.indexOf(start) + start.length, html.indexOf(end))
        .replace('id="assessment-planning" class="assessment-page" hidden', 'id="assessment-planning" class="assessment-page"');
}

function safeText(value) {
    if (typeof value !== "string") return typeof value === "number" || typeof value === "boolean" ? value : null;
    // Redact the complete field: paths and header values can contain spaces or quoted secrets.
    if (/\b[\w-]*(?:token|password|secret|authorization|credential|api[_-]?key)[\w-]*[\s"'`\\]*[:=]/iu.test(value)) {
        return "[credential metadata omitted]";
    }
    if (/\bfile:|(?<!\w)(?:[a-z]:[\\/]|\\\\)|(?<![\w:/<])\/(?:\/)?[^\s<>"']+/iu.test(value)) {
        return "[private location omitted]";
    }
    for (const [address] of value.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu)) {
        try {
            const url = new URL(address);
            const host = url.hostname.toLowerCase().replace(/\.$/u, "");
            if (url.protocol === "file:" || host === "localhost" || host.endsWith(".localhost")
                || /^(?:127\.|0\.0\.0\.0$|\[::1\]$|\[::ffff:7f)/u.test(host)
                || url.username || url.password
                || [...url.searchParams.keys()].some((key) => /token|password|secret|credential|api.?key|authorization/iu.test(key))) {
                return "[private location omitted]";
            }
        } catch { return "[invalid address omitted]"; }
    }
    return value;
}
const pick = (row, keys) => Object.fromEntries(keys.split(" ").map((key) => [key, safeText(row?.[key])]));
const stats = (row) => ({ ...pick(row, "workbooks scored unknownScores scoreTotal scoreMax highScores zeroScores understated understatementUnknown userReferences userReferencesUnknown"),
    tiers: pick(row?.tiers, "migrate archive review retire-candidate unknown") });
const ids = (rows) => (rows ?? []).map(safeText);
const group = (row) => ({ ...pick(row, "key name luid identity datasourceGroups projectGroups confirmedConsumers candidateConsumers unresolvedReferences"),
    workbookLuids: ids(row.workbookLuids), candidateWorkbookLuids: ids(row.candidateWorkbookLuids), stats: stats(row.stats) });

function exportData(summary, issueCount) {
    // Never serialize the snapshot, run identity, arbitrary inventory extras or raw producer issues.
    return {
        ...pick(summary, "available asOf status viewsStatus datasourceStatus"),
        source: "selected saved assessment",
        notices: [...(summary.exportNotices ?? []).map(safeText),
            `${issueCount} producer evidence issue(s). Raw diagnostics are omitted for privacy; inspect them in the original local canvas.`,
            "Evidence, not certification — NOT_CHECKED. Operator planning only; not migration readiness, parser success, fidelity, completion or deployment approval.",
            "Entire selected saved assessment; original UI filters are not included. Scope may overlap other runs and may be incomplete. Offline interactions do not collect fresh or live evidence."],
        totals: { ...stats(summary.totals), ...pick(summary.totals,
            "projectGroups referencedDatasourceGroups confirmedEdges candidateEdges unresolvedEdges duplicateEdges") },
        projects: summary.projects.map(group), datasources: summary.datasources.map(group), complexity: summary.complexity.map(group),
        workbooks: summary.workbooks.map((row) => ({
            ...pick(row, "luid name projectKey project projectLuid tier score reportedScore band understated hasUserReference updatedAt createdAt sizeMb"),
            signals: pick(row.signals, "sheets dashboards calcs lods tableCalcs viewsLifetime"),
            activity: pick(row.activity, "subscriptions alerts customViews"),
        })),
        views: (summary.views ?? []).map((row) => pick(row, "luid name workbookLuid workbook project linked viewsLifetime updatedAt")),
        datasourceInventory: (summary.datasourceInventory ?? []).map((row) => pick(row,
            "luid name project projectLuid connectionType updatedAt certified hasExtracts confirmedConsumers candidateConsumers projectGroups")),
    };
}

export function assessmentHtml(summary, { issueCount = 0 } = {}) {
    requireThat(summary?.available && summary.totals, "An available saved assessment is required for HTML export.");
    const nonce = randomBytes(24).toString("base64");
    const data = json(exportData(summary, issueCount));
    const script = `${bundlePlanning()}
const summary = ${data};
const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
};
const download = ({ filename, content }) => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = node("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const view = offlineModules["./planning.js"].createPlanningView({ node, download, readOnly: true });
view.render(summary);
document.documentElement.dataset.offlineReady = "true";
`;
    requireThat(!/<\/script|<!--/iu.test(script), "Unsafe offline script boundary.");
    const css = read("style.css");
    requireThat(!/@import|url\s*\(|<\/style/iu.test(css), "Offline stylesheet must be self-contained.");
    return { filename: "assessment-planning-report.html", content: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<title>Private assessment planning report</title>
<style>${css}
body { display: block; } main { margin: 0 auto; width: 100%; }
</style></head><body><main>
<header><div><p class="eyebrow">PRIVATE OFFLINE ASSESSMENT</p><h1>Assessment planning canvas</h1>
<p class="subtitle">Entire selected saved assessment · NOT_CHECKED · no live collection</p></div></header>
<p class="notice">Original canvas filters are not exported. Explore this saved snapshot locally; no refresh, migration, queue, handoff or agent controls are available. No fresh evidence is collected.</p>
<noscript>This interactive offline canvas requires JavaScript. No evidence is refreshed.</noscript>
${planningMarkup()}</main><script type="module" nonce="${nonce}">${script}</script></body></html>`,
        records: summary.workbooks.length };
}
