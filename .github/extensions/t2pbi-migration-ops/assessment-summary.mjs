import { toCsv } from "./common.mjs";

const tierNames = ["migrate", "archive", "review", "retire-candidate"];
const bandNames = {
    zero: "Zero score / verify structure",
    lower: "Reported score 1-39",
    higher: "Reported score 40+",
    unknown: "Score unavailable",
};
const scoreBand = (score) => score === null ? "unknown" : score === 0 ? "zero" : score < 40 ? "lower" : "higher";
const projectKey = (row) => row.projectLuid ? `luid:${row.projectLuid}` : row.project ? `name:${row.project}` : "unknown:";

function statistics(workbooks) {
    const scores = workbooks.map((w) => w.score).filter((score) => score !== null);
    const tiers = Object.fromEntries([...tierNames, "unknown"].map((tier) =>
        [tier, workbooks.filter((w) => (tierNames.includes(w.tier) ? w.tier : "unknown") === tier).length]));
    return {
        workbooks: workbooks.length, tiers, scored: scores.length, unknownScores: workbooks.length - scores.length,
        scoreTotal: scores.length ? scores.reduce((sum, score) => sum + score, 0) : null,
        scoreMax: scores.length ? scores.reduce((maximum, score) => Math.max(maximum, score), 0) : null,
        highScores: scores.filter((score) => score >= 40).length,
        zeroScores: scores.filter((score) => score === 0).length,
        understated: workbooks.filter((w) => w.understated === true).length,
        understatementUnknown: workbooks.filter((w) => w.understated === null).length,
        userReferences: workbooks.filter((w) => w.hasUserReference === true).length,
        userReferencesUnknown: workbooks.filter((w) => w.hasUserReference === null).length,
    };
}

export function summarizeAssessment(snapshot) {
    const a = snapshot?.assessment;
    const result = {
        available: Boolean(a && ["inventory_observed", "degraded", "incomplete"].includes(a.status)),
        run: snapshot?.run ?? null, asOf: snapshot?.asOf ?? null, status: a?.status ?? "not_observed",
        source: "assessment/assessment.json", notices: [], totals: null, projects: [], datasources: [], complexity: [], workbooks: [],
        views: [], datasourceInventory: [], viewsStatus: a?.views?.status ?? "not_observed",
        datasourceStatus: a?.datasourceInventory?.status ?? "not_observed",
    };
    if (!result.available) {
        result.notices.push("Refresh an assessable run to build the planning picture. Missing evidence is not an empty estate.");
        return result;
    }
    if (a.status !== "inventory_observed") result.notices.push(`Assessment is ${a.status}; counts describe observed records, not a complete estate.`);
    const errors = a.collectionErrors;
    const structureUnavailable = errors?.some((error) => error.listing === "structure" && error.severity === "primary");
    if (structureUnavailable) result.notices.push("Structure listing failed at primary severity: complexity scores are unavailable, not zero effort.");
    else if (errors?.some((error) => error.listing === "structure")) result.notices.push("Structure listing is partial; per-workbook structural gaps remain unknown.");
    if (errors === undefined || a.workbooks.some((w) => w.structureAvailable === undefined || w.understated === undefined)) {
        result.notices.push("This saved snapshot lacks planning metadata. Refresh evidence for structural coverage and published-datasource sizing caveats.");
    }
    if (a.surveySupplied !== true) result.notices.push("Dependency survey is absent or not recorded. Migration order and dependency completeness are unknown, even when no edges are listed.");
    result.notices.push("Usage is lifetime only: no usage history or last-viewed date was collected. Last modified is not last used or last refreshed. Tableau view type (dashboard versus worksheet) is unknown.");
    result.notices.push("Dependency edges cover the supplied survey, which may be narrower than the assessment. No observed provider edge does not mean provider-free or unused.");
    if (result.viewsStatus !== "available" || result.datasourceStatus !== "available") {
        result.notices.push(`Optional inventories: views ${result.viewsStatus}; published datasources ${result.datasourceStatus}. Refresh evidence for saved raw inventories; no source collection is started.`);
    }
    result.notices.push("Datasource groups cover referenced published providers only, not a full inventory of embedded or unreferenced datasources.");
    result.notices.push("Scores are structural signals, not effort days. Zero scores require confirmation; published-datasource calculations can understate sizing. Tier recommendations require owner decisions.");
    const projects = new Map();
    result.workbooks = a.workbooks.map((w) => {
        const score = structureUnavailable || w.structureAvailable === false || !Number.isFinite(w.complexity) || w.complexity < 0
            ? null : w.complexity;
        return {
            luid: w.luid, name: w.name, projectKey: projectKey(w), project: w.project || "(Project not recorded)",
            projectLuid: w.projectLuid || "", tier: tierNames.includes(w.tier) ? w.tier : "unknown",
            score, reportedScore: w.complexity, band: scoreBand(score),
            understated: w.understated ?? null, hasUserReference: w.hasUserReference ?? null,
            signals: {
                ...Object.fromEntries(["sheets", "dashboards", "calcs", "lods", "tableCalcs"].map((key) =>
                    [key, structureUnavailable || w.structureAvailable === false ? null : w.signals?.[key] ?? null])),
                viewsLifetime: w.signals?.viewsLifetime ?? null,
            },
            updatedAt: w.updatedAt ?? null, createdAt: w.createdAt ?? null, sizeMb: w.sizeMb ?? null,
            activity: w.activity ?? { subscriptions: null, alerts: null, customViews: null },
        };
    });
    const byId = new Map(result.workbooks.map((w) => [w.luid, w]));
    const byName = new Map();
    for (const w of result.workbooks) {
        if (!byName.has(w.name)) byName.set(w.name, []);
        byName.get(w.name).push(w);
        if (!projects.has(w.projectKey)) projects.set(w.projectKey, {
            key: w.projectKey, name: w.project, luid: w.projectLuid, identity: w.projectLuid ? "LUID" : w.projectKey === "unknown:" ? "unknown" : "name-only group",
            workbookLuids: [], datasourceKeys: new Set(),
        });
        projects.get(w.projectKey).workbookLuids.push(w.luid);
    }
    const providers = new Map();
    const confirmed = new Map(), candidates = new Map(), unresolved = new Map();
    for (const dependency of a.dependencies) {
        const key = dependency.datasourceLuid ? `luid:${dependency.datasourceLuid}` : `name:${dependency.datasourceName}`;
        if (!providers.has(key)) providers.set(key, {
            key, name: dependency.datasourceName, luid: dependency.datasourceLuid,
            identity: dependency.datasourceLuid ? "LUID" : "name-only group",
            workbookLuids: [], candidateWorkbookLuids: [], unresolvedReferences: 0,
        });
        const exact = dependency.workbookLuid ? byId.get(dependency.workbookLuid) : null;
        const nameMatches = byName.get(dependency.workbookName) ?? [];
        const candidate = !dependency.workbookLuid && nameMatches.length === 1 ? nameMatches[0] : null;
        if (exact) confirmed.set(JSON.stringify([key, exact.luid]), { provider: key, workbook: exact.luid });
        else if (candidate) candidates.set(JSON.stringify([key, candidate.luid]), { provider: key, workbook: candidate.luid });
        else unresolved.set(JSON.stringify([key, dependency.workbookLuid || dependency.workbookName]),
            { provider: key });
    }
    for (const key of confirmed.keys()) candidates.delete(key);
    for (const { provider, workbook } of confirmed.values()) {
        providers.get(provider).workbookLuids.push(workbook);
        projects.get(byId.get(workbook).projectKey).datasourceKeys.add(provider);
    }
    for (const { provider, workbook } of candidates.values()) providers.get(provider).candidateWorkbookLuids.push(workbook);
    for (const { provider } of unresolved.values()) providers.get(provider).unresolvedReferences++;
    result.projects = [...projects.values()].map(({ datasourceKeys, ...project }) => ({
        ...project, datasourceGroups: datasourceKeys.size, stats: statistics(project.workbookLuids.map((id) => byId.get(id))),
    })).sort((left, right) => right.stats.tiers.migrate - left.stats.tiers.migrate || right.stats.workbooks - left.stats.workbooks || left.name.localeCompare(right.name));
    result.datasources = [...providers.values()].map((provider) => ({
        ...provider, confirmedConsumers: provider.workbookLuids.length, candidateConsumers: provider.candidateWorkbookLuids.length,
        projectGroups: new Set(provider.workbookLuids.map((id) => byId.get(id).projectKey)).size,
        stats: statistics(provider.workbookLuids.map((id) => byId.get(id))),
    })).sort((left, right) => right.confirmedConsumers - left.confirmedConsumers || right.candidateConsumers - left.candidateConsumers || left.name.localeCompare(right.name));
    result.views = (a.views?.rows ?? []).map((view) => ({
        ...view, workbook: byId.get(view.workbookLuid)?.name ?? null,
        project: byId.get(view.workbookLuid)?.project ?? null,
        linked: byId.has(view.workbookLuid),
    }));
    result.datasourceInventory = (a.datasourceInventory?.rows ?? []).map((provider) => {
        const references = result.datasources.find((group) => group.luid === provider.luid);
        return { ...provider, confirmedConsumers: references?.confirmedConsumers ?? 0,
            candidateConsumers: references?.candidateConsumers ?? 0,
            projectGroups: references?.projectGroups ?? 0 };
    });
    result.complexity = Object.entries(bandNames).map(([key, name]) => {
        const workbooks = result.workbooks.filter((w) => w.band === key);
        return { key, name, workbookLuids: workbooks.map((w) => w.luid), stats: statistics(workbooks) };
    });
    result.totals = {
        ...statistics(result.workbooks), projectGroups: projects.size, referencedDatasourceGroups: providers.size,
        confirmedEdges: confirmed.size, candidateEdges: candidates.size, unresolvedEdges: unresolved.size,
        duplicateEdges: a.dependencies.length - confirmed.size - candidates.size - unresolved.size,
    };
    if (candidates.size || unresolved.size) result.notices.push(`${candidates.size} name-only consumer candidate(s), ${unresolved.size} unresolved dependency reference(s): resolve identities before provider sequencing.`);
    result.exportNotices = [...result.notices];
    result.notices.push(...a.issues);
    return result;
}

export function assessmentSummaryCsv(summary) {
    const base = {
        run: summary.run ?? "", observed_at: summary.asOf ?? "", assessment_state: summary.status,
        source: summary.source, current_certification: "NOT_CHECKED", limitations: summary.notices.join(" | "),
    };
    const statsRow = (stats) => ({
        workbooks: stats.workbooks, migrate: stats.tiers.migrate, archive: stats.tiers.archive,
        review: stats.tiers.review, retire_candidate: stats.tiers["retire-candidate"], unknown_tier: stats.tiers.unknown,
        scored_workbooks: stats.scored, unknown_scores: stats.unknownScores, reported_score_total: stats.scoreTotal,
        reported_score_max: stats.scoreMax, score_40_plus: stats.highScores, zero_scores: stats.zeroScores,
        understated: stats.understated, understatement_unknown: stats.understatementUnknown,
        user_references: stats.userReferences, user_reference_unknown: stats.userReferencesUnknown,
    });
    const rows = [{ ...base, record_type: "assessment_summary", ...(summary.totals ? {
        ...statsRow(summary.totals), project_groups: summary.totals.projectGroups,
        referenced_datasource_groups: summary.totals.referencedDatasourceGroups,
        confirmed_edges: summary.totals.confirmedEdges, candidate_edges: summary.totals.candidateEdges,
        unresolved_edges: summary.totals.unresolvedEdges, duplicate_edges: summary.totals.duplicateEdges,
    } : {}) }];
    for (const project of summary.projects) rows.push({
        ...base, record_type: "project_summary", name: project.name, luid: project.luid, identity: project.identity,
        ...statsRow(project.stats), referenced_datasource_groups: project.datasourceGroups,
    });
    for (const provider of summary.datasources) rows.push({
        ...base, record_type: "datasource_summary", name: provider.name, luid: provider.luid, identity: provider.identity,
        ...statsRow(provider.stats), confirmed_consumers: provider.confirmedConsumers, candidate_consumers: provider.candidateConsumers,
        unresolved_edges: provider.unresolvedReferences, project_groups: provider.projectGroups,
    });
    for (const band of summary.complexity) rows.push({
        ...base, record_type: "complexity_summary", name: band.name, ...statsRow(band.stats),
    });
    const columns = ["record_type", "run", "observed_at", "assessment_state", "source", "name", "luid", "identity",
        "workbooks", "migrate", "archive", "review", "retire_candidate", "unknown_tier", "scored_workbooks", "unknown_scores",
        "reported_score_total", "reported_score_max", "score_40_plus", "zero_scores", "understated", "understatement_unknown",
        "user_references", "user_reference_unknown", "project_groups", "referenced_datasource_groups",
        "confirmed_consumers", "candidate_consumers", "confirmed_edges", "candidate_edges", "unresolved_edges", "duplicate_edges",
        "current_certification", "limitations"];
    return { filename: "assessment-planning-summary.csv", content: toCsv(rows, columns), records: rows.length };
}
