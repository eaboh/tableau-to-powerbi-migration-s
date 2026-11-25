/* global document, window */
export function createAgentView({ node, api, download }) {
    const $ = (id) => document.getElementById(id);
    let run = "", observation = null, busy = false, active = false;
    const date = (value) => value ? new Date(value).toLocaleString() : "Unknown";
    function availability() {
        $("agents-refresh").disabled = busy || !run;
        $("agents-export").disabled = !observation || observation.run !== run;
    }
    function render() {
        $("agent-sessions").replaceChildren();
        $("agents-status").textContent = observation
            ? `Observed ${date(observation.asOf)} / ${observation.status}. Recorded events only; live activity not verified.`
            : "Select a run and refresh agent activity. No activity is inferred from run status.";
        $("agents-notices").replaceChildren(...(observation?.notices ?? []).map((text) => node("p", text, "issue")));
        for (const session of observation?.sessions ?? []) {
            const section = node("details", undefined, "planning-section panel");
            section.open = true;
            section.append(node("summary", `Session ${session.id} - ${session.status}`),
                node("p", `${session.reason} Last session event: ${date(session.lastEvent)}`, "muted"));
            if (session.warning) section.append(node("p", session.warning, "issue"));
            if (!session.agents.length) section.append(node("p", "Agent activity unknown for this session.", "issue"));
            else {
                const table = node("table");
                const caption = node("caption", "Session agent lifecycle records (not live-process proof)");
                const head = node("thead"), headings = node("tr");
                for (const title of ["Agent / identity", "Parent / relationship", "Recorded status", "State event", "Last event / freshness"]) {
                    const th = node("th", title);
                    th.scope = "col";
                    headings.append(th);
                }
                head.append(headings);
                const body = node("tbody");
                for (const agent of session.agents) {
                    const row = node("tr");
                    const name = node("td");
                    name.append(node("strong", agent.name), node("small", agent.id));
                    const parent = node("td");
                    const parentAgent = session.agents.find((candidate) => candidate.id === agent.parentId);
                    parent.append(node("span", parentAgent?.name ?? (agent.parentId || "Not recorded")),
                        node("small", agent.relationship), node("small", agent.parentId ?? ""));
                    row.append(name, parent, node("td", `${agent.status} (recorded)`), node("td", date(agent.stateAt)),
                        node("td", `${date(agent.lastEvent)} / ${agent.stale ? "Stale (>2 minutes)" : "Recent event; liveness unverified"}`));
                    body.append(row);
                }
                table.append(caption, head, body);
                const wrap = node("div", undefined, "table-wrap");
                wrap.append(table);
                section.append(wrap);
            }
            $("agent-sessions").append(section);
        }
        for (const anchor of observation?.unknownAnchors ?? []) {
            $("agent-sessions").append(node("p", `Agent ${anchor.id}: unknown. ${anchor.reason}`, "issue"));
        }
        availability();
    }
    async function refresh() {
        if (busy || !run) return;
        const requested = run;
        busy = true;
        availability();
        $("agents-status").textContent = "Reading linked session events...";
        $("agent-activity").setAttribute("aria-busy", "true");
        try {
            const next = await api("get_agent_activity", { run: requested });
            if (run !== requested) return;
            observation = next;
            render();
        } catch (error) {
            if (run !== requested) return;
            observation = null;
            render();
            $("agents-status").textContent = `Agent observation failed: ${error.message}. Current activity is unknown; retry refresh.`;
        } finally {
            busy = false;
            $("agent-activity").removeAttribute("aria-busy");
            availability();
            if (run !== requested && active && run) void refresh();
        }
    }
    $("agents-refresh").addEventListener("click", refresh);
    $("agents-export").addEventListener("click", () => { if (observation?.run === run) download(observation.csv); });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && active && $("agents-auto").checked) void refresh();
    });
    window.setInterval(() => {
        if (active && !document.hidden && $("agents-auto").checked) void refresh();
    }, 30_000);
    return {
        selectRun(next) {
            if (next === run) return;
            run = next;
            observation = null;
            render();
            if (active) void refresh();
        },
        activate(value) {
            active = value;
            if (active && !document.hidden) void refresh();
        },
        applyAvailability: availability,
    };
}
