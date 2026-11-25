export const attributes = [
    { key: "name", label: "Workbook name", type: "text", get: (w) => w.name },
    { key: "luid", label: "Workbook LUID", type: "text", get: (w) => w.luid },
    { key: "createdAt", label: "Created date (UTC)", type: "date", get: (w) => w.createdAt?.slice(0, 10) ?? null },
    { key: "sizeMb", label: "Size (MB)", type: "number", get: (w) => w.sizeMb },
    ...["sheets", "dashboards", "calcs", "lods", "tableCalcs"].map((key, index) => ({
        key, label: ["Sheet count", "Dashboard count", "Calculation count", "LOD count", "Table calculation count"][index],
        type: "count", get: (w) => w.signals[key],
    })),
    ...["subscriptions", "alerts", "customViews"].map((key, index) => ({
        key, label: ["Subscription count", "Alert count", "Custom view count"][index],
        type: "count", get: (w) => w.activity[key],
    })),
    { key: "hasUserReference", label: "User-dependent calculations", type: "boolean", get: (w) => w.hasUserReference },
    { key: "understated", label: "Understated complexity", type: "boolean", get: (w) => w.understated },
];

const modesFor = (type) => ["known", "unknown", ...(type === "text" ? ["contains", "equals"]
    : type === "boolean" ? ["yes", "no"] : ["range"])];
const provided = (value) => value !== "" && value !== undefined;
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function attributeError(filters = []) {
    if (!Array.isArray(filters)) return "Attribute filters must be a list.";
    const seen = new Set();
    for (const filter of filters) {
        const attribute = attributes.find((a) => a.key === filter?.key);
        if (!attribute || seen.has(filter.key)) return "Unknown or duplicate attribute filter.";
        seen.add(filter.key);
        if (!modesFor(attribute.type).includes(filter.mode)) return `${attribute.label}: choose a supported filter mode.`;
        if (["contains", "equals"].includes(filter.mode) && (typeof filter.value !== "string" || !filter.value.trim())) {
            return `${attribute.label}: enter text to match.`;
        }
        if (filter.mode !== "range") continue;
        if (!provided(filter.min) && !provided(filter.max)) return `${attribute.label}: enter at least one bound.`;
        for (const value of [filter.min, filter.max].filter(provided)) {
            const numeric = typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)
                && Number.isFinite(Number(value)) && Number(value) >= 0
                && (attribute.type !== "count" || Number.isSafeInteger(Number(value)));
            if (attribute.type === "date" ? !validDate(value) : !numeric) {
                return `${attribute.label}: enter valid ${attribute.type === "date" ? "UTC dates" : attribute.type === "count" ? "non-negative whole numbers" : "non-negative numbers"}.`;
            }
        }
        if (provided(filter.min) && provided(filter.max)
            && (attribute.type === "date" ? filter.min > filter.max : Number(filter.min) > Number(filter.max))) {
            return `${attribute.label}: minimum must not exceed maximum.`;
        }
    }
    return "";
}

export function matchesAttributes(workbook, filters = []) {
    return filters.every((filter) => {
        const attribute = attributes.find((a) => a.key === filter.key);
        const value = attribute.get(workbook);
        const known = value !== null && value !== undefined && value !== "";
        if (filter.mode === "unknown") return !known;
        if (!known) return false;
        if (filter.mode === "known") return true;
        if (filter.mode === "yes" || filter.mode === "no") return value === (filter.mode === "yes");
        if (filter.mode === "equals") return String(value).toLowerCase() === filter.value.trim().toLowerCase();
        if (filter.mode === "contains") return String(value).toLowerCase().includes(filter.value.trim().toLowerCase());
        const compare = (bound) => attribute.type === "date" ? bound : Number(bound);
        return (!provided(filter.min) || value >= compare(filter.min)) && (!provided(filter.max) || value <= compare(filter.max));
    });
}

export function createAttributeMenu({ node, root, quickControls, search, status, onChange }) {
    const cards = [];
    const controls = [];
    const card = (label, open) => {
        const details = node("details", "", "attribute-filter");
        details.open = open;
        details.append(node("summary", label));
        root.append(details);
        cards.push({ details, label });
        return details;
    };
    for (const label of [...quickControls.children]) {
        card(label.firstChild.textContent.trim(), true).append(label);
    }
    quickControls.remove();
    const modeNames = { known: "Known", unknown: "Unknown", contains: "Contains text", equals: "Equals text",
        yes: "Yes", no: "No", range: "Inclusive range" };
    const input = (attribute, suffix, title) => {
        const label = node("label", title);
        const field = node("input");
        field.id = `planning-attr-${attribute.key}-${suffix}`;
        field.type = attribute.type === "date" ? "date" : ["number", "count"].includes(attribute.type) ? "number" : "text";
        if (field.type === "number") { field.min = "0"; field.step = attribute.type === "count" ? "1" : "any"; }
        label.append(field);
        return { label, field };
    };
    for (const attribute of attributes) {
        const details = card(attribute.label, false);
        const label = node("label", `${attribute.label} filter`);
        const mode = node("select");
        mode.id = `planning-attr-${attribute.key}-mode`;
        for (const [value, text] of [["", "All (include unknown)"], ...modesFor(attribute.type).map((m) => [m, modeNames[m]])]) {
            const option = node("option", text); option.value = value; mode.append(option);
        }
        label.append(mode); details.append(label);
        const min = input(attribute, "min", "Minimum / from");
        const max = input(attribute, "max", "Maximum / through");
        const value = input(attribute, "value", "Text to match");
        if (attribute.type === "text") details.append(value.label);
        else if (attribute.type !== "boolean") details.append(min.label, max.label);
        const item = { attribute, details, mode, min, max, value };
        controls.push(item);
        for (const field of [mode, min.field, max.field, value.field]) {
            field.addEventListener(field === mode ? "change" : "input", onChange);
        }
    }
    function update() {
        const query = search.value.trim().toLowerCase();
        for (const { details, label } of cards) {
            details.hidden = !label.toLowerCase().includes(query);
            if (query && !details.hidden) details.open = true;
        }
        for (const item of controls) {
            item.min.field.disabled = item.max.field.disabled = item.mode.value !== "range";
            item.value.field.disabled = !["contains", "equals"].includes(item.mode.value);
            item.details.classList.toggle("filter-active", item.mode.value !== "");
        }
        status.textContent = `${cards.filter((c) => !c.details.hidden).length} attribute menus shown. Active filters remain applied when hidden by this search.`;
    }
    search.addEventListener("input", update);
    return {
        read: () => controls.filter((c) => c.mode.value).map((c) => ({
            key: c.attribute.key, mode: c.mode.value, min: c.min.field.value, max: c.max.field.value, value: c.value.field.value,
        })),
        reset: () => {
            search.value = "";
            for (const c of controls) for (const field of [c.mode, c.min.field, c.max.field, c.value.field]) field.value = "";
            update();
        },
        update,
    };
}
