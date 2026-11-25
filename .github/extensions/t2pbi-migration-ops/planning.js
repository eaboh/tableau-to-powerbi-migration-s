/* global document */
import { filterWorkbooks, filterViews, sortRows, filteredPlanningCsv, filterError, providerBindings, filteredHeadlines } from "./planning-data.mjs";
import { createPlanningCharts } from "./planning-charts.mjs";
import { createAttributeMenu } from "./planning-attributes.mjs";
import { renderPlanningOverview, knownUsageWorkbooks } from "./planning-overview.mjs";

const $ = (id) => document.getElementById(id);
const display = (value) => value === null || value === undefined ? "Unknown" : String(value);
const filterKeys = ["search", "tier", "project", "provider", "band", "usage", "minViews", "maxViews", "updated", "after", "before", "signal", "sort"];

export function createPlanningView({ node, api, work, download, onSelect, readOnly = false }) {
    if (readOnly) {
        for (const id of ["planning-use-selection", "planning-export", "planning-export-html"]) $(id).remove();
    }
    let summary = null;
    let scope = { type: "all", key: "" };
    let page = 0;
    let viewPage = 0;
    let catalogPage = 0;
    let usageTopN = 20;
    const pageSize = 50;
    const menu = createAttributeMenu({ node, root: $("planning-attribute-grid"), quickControls: $("planning-quick-controls"),
        search: $("planning-attribute-search"), status: $("planning-attribute-status"),
        onChange: () => { page = 0; viewPage = 0; catalogPage = 0; renderDetails(); } });
    const filters = () => ({ ...Object.fromEntries(filterKeys.map((key) => [key, $(`planning-${key}`).value])), attributes: menu.read() });
    const charts = createPlanningCharts({ node, readOnly, getSummary: () => summary, getFilters: filters, onFilter: (changes) => {
        for (const [key, value] of Object.entries(changes)) $(`planning-${key}`).value = value;
        page = 0;
        viewPage = 0;
        catalogPage = 0;
        renderDetails();
    } });

    function selectScope(type, key) {
        scope = { type, key };
        page = 0;
        viewPage = 0;
        catalogPage = 0;
        renderDetails();
        $("planning-detail").open = true;
        $("planning-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function scopedWorkbooks() {
        return filterWorkbooks(summary, filters(), scope);
    }

    function scopedViews(workbooks) {
        return filterViews(summary, workbooks, {
            search: $("planning-view-search").value, sort: $("planning-view-sort").value,
            restrict: scope.type !== "all" || menu.read().length > 0
                || filterKeys.some((key) => key !== "sort" && $(`planning-${key}`).value !== ""),
        });
    }

    function catalogRows() {
        const f = filters();
        const query = $("planning-catalog-search").value.trim().toLowerCase();
        const [key, direction] = $("planning-catalog-sort").value.split(":");
        return sortRows((summary?.datasourceInventory ?? []).filter((p) =>
            (!f.project || (p.projectLuid ? `luid:${p.projectLuid}` : `name:${p.project}`) === f.project)
            && (!f.provider || `luid:${p.luid}` === f.provider)
            && `${p.name} ${p.project} ${p.connectionType} ${p.luid}`.toLowerCase().includes(query)), key, direction);
    }

    function renderInventories(workbooks) {
        const views = scopedViews(workbooks);
        viewPage = Math.max(0, Math.min(viewPage, Math.ceil(views.length / pageSize) - 1));
        const start = viewPage * pageSize;
        $("planning-view-status").textContent = `Inventory ${summary?.viewsStatus ?? "not_observed"}: ${views.length} matching views; ${views.filter((v) => !v.linked).length} unmatched parent identities; showing ${views.length ? start + 1 : 0}-${Math.min(start + pageSize, views.length)}.`;
        $("planning-views").replaceChildren();
        for (const v of views.slice(start, start + pageSize)) {
            const row = node("tr");
            const name = node("td");
            name.append(node("strong", v.name), node("small", v.luid));
            const parent = node("td");
            parent.append(node("span", v.workbook ?? "Parent not in assessed inventory"),
                node("small", `${v.project ?? "Unknown project"} / ${v.workbookLuid || "Unknown parent LUID"}`));
            row.append(name, parent, node("td", display(v.viewsLifetime)), node("td", display(v.updatedAt)));
            $("planning-views").append(row);
        }
        $("planning-view-prev").disabled = viewPage === 0;
        $("planning-view-next").disabled = (viewPage + 1) * pageSize >= views.length;
        const catalog = catalogRows();
        catalogPage = Math.max(0, Math.min(catalogPage, Math.ceil(catalog.length / pageSize) - 1));
        const offset = catalogPage * pageSize;
        $("planning-catalog-status").textContent = `Inventory ${summary?.datasourceStatus ?? "not_observed"}: ${catalog.length} matching published datasources; showing ${catalog.length ? offset + 1 : 0}-${Math.min(offset + pageSize, catalog.length)}.`;
        $("planning-catalog").replaceChildren();
        for (const p of catalog.slice(offset, offset + pageSize)) {
            const row = node("tr");
            const name = node("td");
            name.append(node("strong", p.name), node("small", p.luid));
            row.append(name, node("td", `${p.project || "Unknown project"} / ${p.connectionType || "Unknown type"}`),
                node("td", display(p.updatedAt)), node("td", `${display(p.certified)} / ${display(p.hasExtracts)}`),
                node("td", `${p.confirmedConsumers} linked / ${p.candidateConsumers} candidate (observed only)`));
            $("planning-catalog").append(row);
        }
        $("planning-catalog-prev").disabled = catalogPage === 0;
        $("planning-catalog-next").disabled = (catalogPage + 1) * pageSize >= catalog.length;
    }

    function groupButton(type, key, label) {
        const button = node("button", label, "button secondary");
        button.type = "button";
        button.addEventListener("click", () => selectScope(type, key));
        return button;
    }

    function identityCell(group) {
        const cell = node("td");
        cell.append(node("strong", group.name), node("small", `${group.identity}${group.luid ? ` / ${group.luid}` : ""}`));
        return cell;
    }

    function statsCell(stats) {
        const cell = node("td");
        cell.append(node("span", `${stats.tiers.migrate} migrate / ${stats.tiers.review} review`),
            node("small", `${stats.tiers.archive} archive / ${stats.tiers["retire-candidate"]} retire candidates / ${stats.tiers.unknown} unknown`));
        return cell;
    }

    function scoreCell(stats) {
        const cell = node("td");
        cell.append(node("span", `Total ${display(stats.scoreTotal)} / max ${display(stats.scoreMax)}`),
            node("small", `${stats.highScores} at 40+ / ${stats.zeroScores} zero / ${stats.unknownScores} unavailable`),
            node("small", `${stats.understated} understated / ${stats.understatementUnknown} sizing flags unknown`));
        return cell;
    }

    function applyAvailability() {
        const workbooks = scopedWorkbooks();
        const usage = knownUsageWorkbooks(summary);
        $("planning-usage-top").disabled = usage.length < 2 || !usage.some((w) => w.signals.viewsLifetime > 0);
        if (!readOnly) $("planning-use-selection").disabled = workbooks.length === 0 || workbooks.length > 100;
        $("planning-prev").disabled = page === 0;
        $("planning-next").disabled = (page + 1) * pageSize >= workbooks.length;
        if (!readOnly) {
            $("planning-export").disabled = !summary?.run;
            $("planning-export-html").disabled = !summary?.run || !summary.available;
        }
        $("planning-filtered-export").disabled = !summary?.available || workbooks.length + scopedViews(workbooks).length === 0;
        $("planning-view-prev").disabled = viewPage === 0;
        $("planning-view-next").disabled = (viewPage + 1) * pageSize >= scopedViews(workbooks).length;
        $("planning-catalog-prev").disabled = catalogPage === 0;
        $("planning-catalog-next").disabled = (catalogPage + 1) * pageSize >= catalogRows().length;
        charts.applyAvailability();
        menu.update();
    }

    function renderDetails() {
        const workbooks = scopedWorkbooks();
        renderHeadlines(workbooks);
        page = Math.max(0, Math.min(page, Math.ceil(workbooks.length / pageSize) - 1));
        const start = page * pageSize;
        $("planning-detail-title").textContent = scope.type === "all" ? "All assessed workbooks"
            : `${scope.type[0].toUpperCase() + scope.type.slice(1)} drill-down`;
        $("planning-filter-context").textContent = scope.type === "all"
            ? "Whole selected assessment. Choose a project, provider or complexity group above to narrow the view."
            : `${scope.type} group: ${scope.key}. Datasource drill-downs include separately labelled name-only consumer candidates; verify their binding.`;
        $("planning-page-label").textContent = workbooks.length
            ? `Showing ${start + 1}-${Math.min(start + pageSize, workbooks.length)} of ${workbooks.length} filtered workbooks.`
            : "No workbooks match this filter.";
        $("planning-selection-label").textContent = readOnly
            ? `Local exploration of saved evidence only. CSV includes all ${workbooks.length} filtered workbooks, not only this page. No workflow actions are available offline.`
            : workbooks.length > 100
            ? `${workbooks.length} workbooks exceed the 100-item batch limit. Narrow the group, tier or search; nothing is silently truncated.`
            : `Batch transfer uses all ${workbooks.length} filtered workbooks, not only the current page. No batch is queued automatically.`;
        const knownViews = workbooks.filter((w) => w.signals.viewsLifetime !== null);
        const knownScores = workbooks.filter((w) => w.score !== null);
        $("planning-filter-error").textContent = filterError(filters());
        const active = filterKeys.filter((key) => key !== "sort" && $(`planning-${key}`).value !== "").length + menu.read().length;
        $("planning-active-filters").textContent = `${active} active attribute filters${scope.type !== "all" ? " + group drill-down" : ""}`;
        $("planning-filtered-metrics").textContent = `${workbooks.length} candidate workbooks / observed lifetime views sum ${knownViews.length ? knownViews.reduce((n, w) => n + w.signals.viewsLifetime, 0) : "Unknown"} (${workbooks.length - knownViews.length} unknown) / structural score sum ${knownScores.length ? knownScores.reduce((n, w) => n + w.score, 0) : "Unknown"} (${workbooks.length - knownScores.length} unknown). These are not effort estimates.`;
        applyAvailability();
        $("planning-workbooks").replaceChildren();
        for (const w of workbooks.slice(start, start + pageSize)) {
            const row = node("tr");
            const name = node("td");
            name.append(node("strong", w.name), node("small", `${w.project} / ${w.luid}`));
            const providerKeys = new Set([scope.type === "datasource" ? scope.key : "", filters().provider]);
            for (const binding of providerBindings(summary, w.luid).filter((p) => providerKeys.has(p.key))) {
                name.append(node("small", `${binding.name} / ${binding.luid || binding.key}: ${binding.binding}`));
            }
            const risk = node("td");
            risk.append(node("span", w.understated === true ? "Understated score" : w.understated === null ? "Sizing flag unknown" : "No understatement flag"),
                node("small", `User reference: ${w.hasUserReference === null ? "unknown" : w.hasUserReference ? "yes" : "no"}`));
            row.append(name, node("td", w.tier), node("td", display(w.score)),
                node("td", `${display(w.signals.lods)} / ${display(w.signals.tableCalcs)} / ${display(w.signals.calcs)}`),
                node("td", display(w.signals.viewsLifetime)), node("td", display(w.updatedAt)),
                node("td", `${display(w.sizeMb)} / ${display(w.signals.sheets)} / ${display(w.signals.dashboards)}`),
                node("td", `${display(w.activity.subscriptions)} / ${display(w.activity.alerts)} / ${display(w.activity.customViews)}`), risk);
            $("planning-workbooks").append(row);
        }
        renderInventories(workbooks);
        charts.render(workbooks);
    }

    function renderHeadlines(workbooks) {
        const h = filteredHeadlines(summary, workbooks);
        const number = (value) => value === null ? "Unknown" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
        const coverage = (metric) => `${metric.known} known / ${metric.unknown} unknown workbooks`;
        const cards = h ? [
            ["candidates", "Candidate workbooks", h.count, `${number(h.percent)}% of this assessment`],
            ["usage", "Observed lifetime views", h.usage.total, `${coverage(h.usage)} / ${number(h.usageShare)}% of known assessment usage`],
            ["projects", "Project groups", h.projects, `${h.provisionalProjects} provisional / unknown-identity groups`],
            ["providers", "Observed provider groups", h.providers, `${h.candidateProviders} groups with candidate links (may overlap). ${h.noObservedProvider} workbooks without an observed edge; not provider-free.`],
            ["score", "Structural score total", h.score.total, `Max ${number(h.score.max)} / ${coverage(h.score)}. Not effort days.`],
            ["dashboards", "Reported dashboards", h.dashboards.total, `${coverage(h.dashboards)} / ${number(h.sheets.total)} sheets / ${number(h.calculations.total)} calculations (known values only)`],
            ["size", "Observed size (MB)", h.size.total, coverage(h.size)],
            ["activity", "Deliberate-use workbooks", h.deliberate, `${h.deliberateUnknown} usage-signal unknown / ${h.userReferences} user-dependent (${h.userReferencesUnknown} unknown) / ${h.understated} understated (${h.understatedUnknown} unknown)`],
        ] : [];
        $("planning-headlines").replaceChildren(...cards.map(([key, label, value, detail]) => {
            const card = node("article");
            card.dataset.metric = key;
            card.append(node("span", label, "eyebrow"), node("strong", number(value)), node("span", detail));
            return card;
        }));
        $("planning-headline-context").textContent = h
            ? `All ${h.count} filtered candidates, not just this page. Latest modification: ${h.latestModified ?? "Unknown"} (${h.datesKnown} known / ${h.datesUnknown} unknown dates). Provider counts cover observed survey links only.`
            : "No assessable workbook evidence. Headline figures are unavailable, not zero.";
    }

    function render(next) {
        if (summary?.run !== next.run) {
            usageTopN = 20;
            scope = { type: "all", key: "" };
            page = 0;
            resetFilters();
        }
        summary = next;
        for (const [id, groups] of [["planning-project", summary.projects], ["planning-provider", summary.datasources]]) {
            const select = $(id);
            const previous = select.value;
            const first = select.options[0];
            select.replaceChildren(first);
            for (const group of groups) {
                const option = node("option", `${group.name} / ${group.luid || group.key}`);
                option.value = group.key;
                select.append(option);
            }
            select.value = [...select.options].some((option) => option.value === previous) ? previous : "";
        }
        const totals = summary.totals;
        renderPlanningOverview(summary, node, usageTopN);
        $("planning-status").textContent = `${summary.status.replaceAll("_", " ")} / ${summary.asOf ? new Date(summary.asOf).toLocaleString() : "not observed"}`;
        $("planning-workbook-count").textContent = totals ? totals.workbooks : "\u2014";
        $("planning-project-count").textContent = totals ? totals.projectGroups : "\u2014";
        $("planning-datasource-count").textContent = totals ? totals.referencedDatasourceGroups : "\u2014";
        $("planning-high-count").textContent = totals ? totals.highScores : "\u2014";
        $("planning-source").textContent = readOnly
            ? "Source: selected saved assessment. This offline copy contains the entire assessment, without the original canvas filters. Local filters change only this copy; evidence is not refreshed."
            : `Source: ${summary.source} in the selected run. Rollups cover this assessment only; they are not added across runs or a readiness verdict.`;
        $("planning-notices").replaceChildren(...summary.notices.map((notice) => node("p", notice, "issue")));
        if (!readOnly) $("planning-export").disabled = !summary.run;
        $("planning-coverage").textContent = totals
            ? `${totals.confirmedEdges} distinct LUID-linked consumer edges / ${totals.candidateEdges} name-only candidates / ${totals.unresolvedEdges} unresolved / ${totals.duplicateEdges} duplicate rows collapsed.`
            : "No assessable dependency evidence.";
        $("planning-projects").replaceChildren();
        for (const project of summary.projects) {
            const row = node("tr");
            const action = node("td");
            action.append(groupButton("project", project.key, "Review workbooks"));
            row.append(identityCell(project), node("td", project.stats.workbooks), statsCell(project.stats), scoreCell(project.stats),
                node("td", project.datasourceGroups), action);
            $("planning-projects").append(row);
        }
        $("planning-datasources").replaceChildren();
        for (const provider of summary.datasources) {
            const row = node("tr");
            const consumers = node("td");
            consumers.append(node("span", `${provider.confirmedConsumers} LUID-linked / ${provider.candidateConsumers} candidate`),
                node("small", `${provider.unresolvedReferences} unresolved references`));
            const action = node("td");
            action.append(groupButton("datasource", provider.key, "Review consumers"));
            row.append(identityCell(provider), consumers, node("td", provider.projectGroups),
                statsCell(provider.stats), scoreCell(provider.stats), action);
            $("planning-datasources").append(row);
        }
        $("planning-complexity").replaceChildren();
        for (const band of summary.complexity) {
            const row = node("tr");
            const distribution = node("td");
            const meter = node("meter");
            meter.min = 0;
            meter.max = Math.max(1, totals.workbooks);
            meter.value = band.stats.workbooks;
            meter.setAttribute("aria-label", `${band.name}: ${band.stats.workbooks} of ${totals.workbooks} workbooks`);
            distribution.append(meter);
            const action = node("td");
            action.append(groupButton("complexity", band.key, "Review workbooks"));
            row.append(node("td", band.name), node("td", band.stats.workbooks), distribution, statsCell(band.stats),
                node("td", `${band.stats.understated} flagged / ${band.stats.understatementUnknown} unknown`), action);
            $("planning-complexity").append(row);
        }
        renderDetails();
    }

    function resetFilters() {
        menu.reset();
        for (const key of filterKeys) $(`planning-${key}`).value = key === "sort" ? "viewsLifetime:desc" : "";
        $("planning-view-search").value = "";
        $("planning-view-sort").value = "viewsLifetime:desc";
        $("planning-catalog-search").value = "";
        $("planning-catalog-sort").value = "confirmedConsumers:desc";
        viewPage = 0;
        catalogPage = 0;
    }
    for (const key of filterKeys) $(`planning-${key}`).addEventListener(
        ["search", "minViews", "maxViews", "after", "before"].includes(key) ? "input" : "change",
        () => { page = 0; viewPage = 0; catalogPage = 0; renderDetails(); });
    $("planning-usage-top").addEventListener("input", () => {
        usageTopN = Number($("planning-usage-top").value);
        renderPlanningOverview(summary, node, usageTopN);
    });
    $("planning-reset").addEventListener("click", () => {
        resetFilters();
        selectScope("all", "");
    });
    document.querySelectorAll(".planning-shortcuts a").forEach((link) => link.addEventListener("click", () => {
        const section = document.getElementById(link.hash.slice(1));
        section.open = true;
        section.querySelector("summary").focus();
    }));
    for (const type of ["view", "catalog"]) {
        for (const control of ["search", "sort"]) $(`planning-${type}-${control}`).addEventListener(
            control === "search" ? "input" : "change", () => {
                if (type === "view") viewPage = 0;
                else catalogPage = 0;
                renderInventories(scopedWorkbooks());
            });
        for (const direction of ["prev", "next"]) $(`planning-${type}-${direction}`).addEventListener("click", () => {
            const step = direction === "prev" ? -1 : 1;
            if (type === "view") viewPage += step;
            else catalogPage += step;
            renderInventories(scopedWorkbooks());
        });
    }
    $("planning-prev").addEventListener("click", () => { page--; renderDetails(); });
    $("planning-next").addEventListener("click", () => { page++; renderDetails(); });
    if (!readOnly) {
        $("planning-use-selection").addEventListener("click", () => {
            const workbooks = scopedWorkbooks();
            if (workbooks.length > 0 && workbooks.length <= 100) onSelect(workbooks.map((w) => w.luid));
        });
        $("planning-export").addEventListener("click", () => work(async () => {
            download(await api("export_assessment_csv", { run: summary.run }));
        }));
        $("planning-export-html").addEventListener("click", () => work(async () => {
            download(await api("export_assessment_html", { run: summary.run }));
        }));
    }
    $("planning-filtered-export").addEventListener("click", () => {
        const workbooks = scopedWorkbooks();
        download(filteredPlanningCsv(summary, workbooks, scopedViews(workbooks), {
            ...filters(), viewSearch: $("planning-view-search").value, viewSort: $("planning-view-sort").value,
        }, scope));
    });
    document.querySelectorAll("[data-assessment-page]").forEach((button) => button.addEventListener("click", () => {
        document.querySelectorAll("[data-assessment-page]").forEach((control) =>
            control.setAttribute("aria-pressed", String(control === button)));
        document.querySelectorAll(".assessment-page").forEach((panel) => { panel.hidden = panel.id !== button.dataset.assessmentPage; });
    }));
    return { render, applyAvailability };
}
