import { toCsv } from "./csv.mjs";
import { attributeError, matchesAttributes } from "./planning-attributes.mjs";

export function filteredHeadlines(summary, workbooks) {
    if (!summary?.available) return null;
    const aggregate = (get) => {
        const values = workbooks.map(get).filter((value) => value !== null && value !== undefined);
        return { total: values.length ? values.reduce((a, b) => a + b, 0) : null,
            max: values.length ? Math.max(...values) : null, known: values.length, unknown: workbooks.length - values.length };
    };
    const ids = new Set(workbooks.map((w) => w.luid));
    const linked = summary.datasources.filter((p) => p.workbookLuids.some((id) => ids.has(id)));
    const candidates = summary.datasources.filter((p) => p.candidateWorkbookLuids.some((id) => ids.has(id)));
    const referenced = new Set([...linked, ...candidates].flatMap((p) => [...p.workbookLuids, ...p.candidateWorkbookLuids]));
    const projects = new Set(workbooks.map((w) => w.projectKey));
    const knownEstateUsage = summary.workbooks.filter((w) => w.signals.viewsLifetime !== null)
        .reduce((n, w) => n + w.signals.viewsLifetime, 0);
    const usage = aggregate((w) => w.signals.viewsLifetime);
    const dates = workbooks.map((w) => w.updatedAt).filter(Boolean).sort();
    return {
        count: workbooks.length, percent: summary.workbooks.length ? workbooks.length / summary.workbooks.length * 100 : null,
        usage, usageShare: knownEstateUsage > 0 && usage.total !== null ? usage.total / knownEstateUsage * 100 : null,
        projects: projects.size, provisionalProjects: new Set(workbooks.filter((w) => !w.projectLuid).map((w) => w.projectKey)).size,
        providers: linked.length, candidateProviders: candidates.length,
        noObservedProvider: workbooks.filter((w) => !referenced.has(w.luid)).length,
        score: aggregate((w) => w.score), size: aggregate((w) => w.sizeMb),
        dashboards: aggregate((w) => w.signals.dashboards), sheets: aggregate((w) => w.signals.sheets),
        calculations: aggregate((w) => w.signals.calcs),
        deliberate: workbooks.filter((w) => Object.values(w.activity).some((n) => n !== null && n > 0)).length,
        deliberateUnknown: workbooks.filter((w) => !Object.values(w.activity).some((n) => n !== null && n > 0)
            && Object.values(w.activity).includes(null)).length,
        userReferences: workbooks.filter((w) => w.hasUserReference === true).length,
        userReferencesUnknown: workbooks.filter((w) => w.hasUserReference === null).length,
        understated: workbooks.filter((w) => w.understated === true).length,
        understatedUnknown: workbooks.filter((w) => w.understated === null).length,
        latestModified: dates.at(-1) ?? null, datesKnown: dates.length, datesUnknown: workbooks.length - dates.length,
    };
}

export function filterError(filters) {
    const error = attributeError(filters.attributes);
    if (error) return error;
    if (filters.minViews && (!/^\d+$/u.test(String(filters.minViews))
        || !Number.isSafeInteger(Number(filters.minViews)))) return "Minimum lifetime views must be a non-negative whole number.";
    if (filters.maxViews && (!/^\d+$/u.test(String(filters.maxViews))
        || !Number.isSafeInteger(Number(filters.maxViews)))) return "Maximum lifetime views must be a non-negative whole number.";
    if (filters.minViews !== "" && filters.minViews !== undefined && filters.maxViews !== "" && filters.maxViews !== undefined
        && Number(filters.minViews) > Number(filters.maxViews)) return "Minimum lifetime views must not exceed maximum lifetime views.";
    if (filters.after && filters.before && filters.after > filters.before) return "Modified on/after must not be later than modified on/before.";
    return "";
}

export function sortRows(rows, key, direction = "desc") {
    return [...rows].sort((a, b) => {
        const left = key === "viewsLifetime" ? a.signals?.viewsLifetime ?? a.viewsLifetime : a[key];
        const right = key === "viewsLifetime" ? b.signals?.viewsLifetime ?? b.viewsLifetime : b[key];
        if (left === null || left === undefined) return right === null || right === undefined ? a.luid.localeCompare(b.luid) : 1;
        if (right === null || right === undefined) return -1;
        const compared = typeof left === "number" ? left - right : String(left).localeCompare(String(right));
        return (direction === "asc" ? compared : -compared) || a.luid.localeCompare(b.luid);
    });
}

export function filterWorkbooks(summary, filters = {}, scope = { type: "all", key: "" }) {
    if (!summary?.available) return [];
    if (filterError(filters)) return [];
    let members = null;
    if (scope.type === "project") members = summary.projects.find((g) => g.key === scope.key)?.workbookLuids ?? [];
    if (scope.type === "datasource") {
        const group = summary.datasources.find((g) => g.key === scope.key);
        members = group ? [...group.workbookLuids, ...group.candidateWorkbookLuids] : [];
    }
    if (scope.type === "complexity") members = summary.complexity.find((g) => g.key === scope.key)?.workbookLuids ?? [];
    const ids = members === null ? null : new Set(members);
    const provider = filters.provider ? summary.datasources.find((g) => g.key === filters.provider) : null;
    const consumers = provider ? new Set([...provider.workbookLuids, ...provider.candidateWorkbookLuids]) : new Set();
    const search = (filters.search ?? "").trim().toLowerCase();
    const selected = summary.workbooks.filter((w) => {
        const views = w.signals.viewsLifetime;
        const counts = Object.values(w.activity);
        const signal = filters.signal || "";
        return matchesAttributes(w, filters.attributes) && (!ids || ids.has(w.luid)) && (!filters.project || w.projectKey === filters.project)
            && (!filters.provider || consumers.has(w.luid)) && (!filters.band || w.band === filters.band)
            && (!filters.tier || w.tier === filters.tier)
            && `${w.name} ${w.project} ${w.luid}`.toLowerCase().includes(search)
            && (!filters.usage || (filters.usage === "used" && views !== null && views > 0)
                || (filters.usage === "zero" && views === 0) || (filters.usage === "unknown" && views === null))
            && (filters.minViews === "" || filters.minViews === undefined || (views !== null && views >= Number(filters.minViews)))
            && (filters.maxViews === "" || filters.maxViews === undefined || (views !== null && views <= Number(filters.maxViews)))
            && (!filters.updated || (filters.updated === "known" ? w.updatedAt !== null : w.updatedAt === null))
            && (!filters.after || (w.updatedAt !== null && w.updatedAt.slice(0, 10) >= filters.after))
            && (!filters.before || (w.updatedAt !== null && w.updatedAt.slice(0, 10) <= filters.before))
            && (!signal || (signal === "deliberate" && counts.some((n) => n !== null && n > 0))
                || (signal === "activity-unknown" && counts.includes(null))
                || (signal === "user-reference" && w.hasUserReference === true)
                || (signal === "understated" && w.understated === true)
                || (signal === "structure-unknown" && w.score === null));
    });
    const [key, direction] = (filters.sort || "viewsLifetime:desc").split(":");
    return sortRows(selected, key, direction);
}

export function filterViews(summary, workbooks, { search = "", sort = "viewsLifetime:desc", restrict = false } = {}) {
    const ids = new Set(workbooks.map((w) => w.luid));
    const query = search.trim().toLowerCase();
    const [key, direction] = sort.split(":");
    return sortRows((summary?.views ?? []).filter((v) => (ids.has(v.workbookLuid) || (!restrict && !v.linked))
        && `${v.name} ${v.luid} ${v.workbook ?? ""} ${v.project ?? ""}`.toLowerCase().includes(query)), key, direction);
}

export function providerBindings(summary, luid) {
    return summary.datasources.flatMap((provider) => {
        const linked = provider.workbookLuids.includes(luid);
        const candidate = provider.candidateWorkbookLuids.includes(luid);
        return linked || candidate ? [{
            key: provider.key, luid: provider.luid, name: provider.name, identity: provider.identity,
            binding: linked ? "LUID-linked consumer" : "Name-only consumer candidate - verify binding",
        }] : [];
    });
}

export function filteredPlanningCsv(summary, workbooks, views, filters, scope) {
    const base = {
        run: summary.run, observed_at: summary.asOf, assessment_state: summary.status,
        current_certification: "NOT_CHECKED", limitations: summary.notices.join(" | "),
        filters: JSON.stringify({ ...filters, scope }),
    };
    const rows = workbooks.map((w) => ({
        ...base, record_type: "workbook", source: "assessment/assessment.json", luid: w.luid, name: w.name,
        workbook_luid: w.luid, project: w.project, project_luid: w.projectLuid, lifetime_views: w.signals.viewsLifetime,
        updated_at: w.updatedAt, size_mb: w.sizeMb, complexity: w.score, tier: w.tier,
        sheets: w.signals.sheets, dashboards: w.signals.dashboards, lods: w.signals.lods,
        table_calcs: w.signals.tableCalcs, calculations: w.signals.calcs,
        subscriptions: w.activity.subscriptions, alerts: w.activity.alerts, custom_views: w.activity.customViews,
        user_reference: w.hasUserReference, understated: w.understated,
        provider_bindings: JSON.stringify(providerBindings(summary, w.luid)),
    }));
    rows.push(...views.map((v) => ({
        ...base, record_type: "tableau_view_type_unknown", source: "assessment/raw/views.json", luid: v.luid, name: v.name,
        workbook_luid: v.workbookLuid, project: v.project, lifetime_views: v.viewsLifetime,
        updated_at: v.updatedAt, parent_link: v.linked ? "LUID-linked" : "not in assessed workbook inventory",
    })));
    const columns = ["record_type", "run", "observed_at", "assessment_state", "source", "luid", "name",
        "workbook_luid", "project", "project_luid", "parent_link", "lifetime_views", "updated_at", "size_mb",
        "complexity", "tier", "sheets", "dashboards", "lods", "table_calcs", "calculations",
        "subscriptions", "alerts", "custom_views", "user_reference", "understated", "provider_bindings",
        "filters", "current_certification", "limitations"];
    return { filename: "assessment-filtered-workbooks-and-views.csv", content: toCsv(rows, columns), records: rows.length };
}
