export class OpsError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

export function requireThat(condition, message, code = "invalid_input") {
    if (!condition) throw new OpsError(code, message);
}

export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const text = (value, max = 2048) =>
    typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
export const kinds = ["workbook", "datasource"];
export const stages = ["assessment", "investigation", "conversion", "packaging", "semantic", "report", "validation", "promotion"];
export const statuses = ["queued", "running", "blocked", "finished", "cancelled"];
export const isoDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function fields(input, allowed, required = allowed) {
    requireThat(object(input), "Input must be an object.");
    requireThat(Object.keys(input).every((key) => allowed.includes(key)), "Unknown input field.");
    requireThat(required.every((key) => Object.hasOwn(input, key)), `Required fields: ${required.join(", ")}.`);
}

export function sourceScope(input) {
    fields(input, ["kind", "value"]);
    requireThat(["dashboard_url", "project"].includes(input.kind) && text(input.value) && input.value.trim(),
        "Provide a dashboard URL or an exact project name/LUID.");
    let value = input.value.trim();
    if (input.kind === "dashboard_url") {
        let url;
        try {
            url = new URL(value);
        } catch {
            throw new OpsError("invalid_input", "Dashboard URL must be an absolute HTTP or HTTPS URL.");
        }
        requireThat(["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password,
            "Dashboard URL must use HTTP(S) without embedded credentials.");
        let routes;
        try {
            routes = [url.pathname, url.hash.split("?")[0].replace(/^#/u, "")].map((route) =>
                decodeURIComponent(route).toLowerCase().split("/"));
        } catch {
            throw new OpsError("invalid_input", "Dashboard URL contains an invalid encoded route.");
        }
        requireThat(!routes.some((segments) => {
            const trusted = segments.indexOf("trusted");
            const views = segments.indexOf("views");
            return trusted >= 0 && segments[trusted + 1] && (views < 0 || trusted < views);
        }), "Trusted-ticket URLs contain credentials. Supply the credential-free dashboard URL instead.");
        const fragmentQuery = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : url.hash.slice(1);
        const credential = (key) => {
            const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
            return /(?:token|password|passwd|secret|signature|authorization|apikey|ticket|jwt|credential)$/u.test(normalized)
                || ["auth", "code", "sig", "pwd", "sessionid"].includes(normalized);
        };
        requireThat(![...url.searchParams.keys(), ...new URLSearchParams(fragmentQuery).keys()].some(credential),
            "Remove credential/token parameters from the source URL. Credentials belong in the environment.");
        value = url.href;
    }
    requireThat(text(value), "Source scope is too long or contains control characters.");
    return { kind: input.kind, value };
}

export function sourceItem(source) {
    return {
        key: `source:${createHash("sha256").update(`${source.kind}\0${source.value}`).digest("hex")}`,
        name: source.value, kind: "source", sourceLuid: null,
    };
}

export { csvCell, toCsv } from "./csv.mjs";
import { createHash } from "node:crypto";
