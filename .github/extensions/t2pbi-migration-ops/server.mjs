import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpsError, requireThat } from "./common.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/client.js", ["client.js", "text/javascript; charset=utf-8"]],
    ["/planning.js", ["planning.js", "text/javascript; charset=utf-8"]],
    ["/planning-overview.mjs", ["planning-overview.mjs", "text/javascript; charset=utf-8"]],
    ["/planning-data.mjs", ["planning-data.mjs", "text/javascript; charset=utf-8"]],
    ["/planning-attributes.mjs", ["planning-attributes.mjs", "text/javascript; charset=utf-8"]],
    ["/planning-charts.mjs", ["planning-charts.mjs", "text/javascript; charset=utf-8"]],
    ["/csv.mjs", ["csv.mjs", "text/javascript; charset=utf-8"]],
    ["/agents.js", ["agents.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const actions = new Set(["get_state", "register_run", "refresh_run", "queue_batch", "queue_source_batch",
    "attach_batch_run", "get_dispatch", "update_batch", "export_csv", "export_assessment_csv", "get_agent_activity",
    "queue_assessment", "queue_wave", "export_assessment_html", "queue_model_plan", "get_model_suggestions",
    "request_continuation", "approve_continuation"]);

async function body(request) {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) {
        bytes += chunk.length;
        requireThat(bytes <= 64 * 1024, "Request exceeds 64 KB.");
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) throw new OpsError("invalid_input", "Body must be valid JSON.");
        throw error;
    }
}

export async function startServer(operations) {
    const token = randomBytes(32).toString("hex");
    let origin;
    const server = createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Content-Security-Policy",
            `default-src 'self'; script-src 'self' 'nonce-${token}'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'`);
        try {
            requireThat(request.headers.host === new URL(origin).host, "Unexpected host.", "forbidden");
            requireThat(!request.headers.origin || request.headers.origin === origin, "Cross-origin request refused.", "forbidden");
            requireThat(request.headers["sec-fetch-site"] !== "cross-site", "Cross-site request refused.", "forbidden");
            const url = new URL(request.url, origin);
            requireThat(!url.search, "Query parameters are not supported.");
            const asset = assets.get(url.pathname);
            if (request.method === "GET" && asset) {
                let content = await fs.readFile(path.join(directory, asset[0]), "utf8");
                if (url.pathname === "/") content = content.replaceAll("__CANVAS_TOKEN__", token);
                response.writeHead(200, { "Content-Type": asset[1] });
                response.end(content);
                return;
            }
            requireThat(request.method === "POST" && url.pathname.startsWith("/api/"), "Route not found.", "not_found");
            requireThat(request.headers["x-canvas-token"] === token, "Missing canvas request token.", "forbidden");
            requireThat(request.headers["content-type"] === "application/json", "JSON content type required.");
            const action = url.pathname.slice("/api/".length);
            requireThat(actions.has(action), "Unknown action.");
            const result = await operations.call(action, await body(request));
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify(result));
        } catch (error) {
            const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : error instanceof OpsError ? 400 : 500;
            response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: error.message, code: error.code ?? "operation_failed" }));
        }
    });
    server.requestTimeout = 135_000;
    server.headersTimeout = 15_000;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return {
        url: origin,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
