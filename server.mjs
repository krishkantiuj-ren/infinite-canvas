import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "web", "dist");
const port = Number(process.env.PORT || 3000);
const tasks = new Map();
const mimeTypes = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [id, task] of tasks) if (task.updatedAt < cutoff) tasks.delete(id);
}, 60 * 1000).unref();

const server = createServer(handleRequest);
server.listen(port, "0.0.0.0", () => console.log(`infinite-canvas server listening on ${port}`));

async function handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/config.js") return writeText(res, 200, "application/javascript", `window.__RUNTIME_CONFIG__ = ${JSON.stringify({ ANALYTICS_GA4_ID: process.env.ANALYTICS_GA4_ID || "", ANALYTICS_BAIDU_ID: process.env.ANALYTICS_BAIDU_ID || "" })};`);

    const ddshub = url.pathname.startsWith("/ddshub/v1/");
    const fastai = url.pathname.startsWith("/fastai/v1/");
    if (ddshub || fastai) return handleApi(req, res, url, { ddshub, fastai });
    return serveStatic(res, url.pathname);
}

async function handleApi(req, res, url, route) {
    if (req.method === "OPTIONS") return writeText(res, 204, "text/plain", "");
    const isImage = req.method === "POST" && route.ddshub && /^\/ddshub\/v1\/images\/(generations|edits)$/.test(url.pathname);
    if (isImage) {
        const id = randomUUID();
        const body = await readBody(req);
        const task = { id, status: "queued", updatedAt: Date.now(), body: null };
        tasks.set(id, task);
        void runImageTask(task, url.pathname, req.headers, body);
        return writeJson(res, 202, { id, status: "queued" });
    }

    const taskMatch = url.pathname.match(/^\/ddshub\/v1\/images\/(generations|edits)\/tasks\/([^/]+)$/);
    if (req.method === "GET" && taskMatch) return readImageTask(res, decodeURIComponent(taskMatch[2]));

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const target = upstreamUrl(url.pathname, route);
    const response = await fetchUpstream(target, req.method, req.headers, body, 300000);
    return writeResponse(res, response);
}

async function runImageTask(task, pathname, headers, body) {
    task.status = "running";
    task.updatedAt = Date.now();
    try {
        const response = await fetchUpstream(upstreamUrl(pathname, { ddshub: true, fastai: false }), "POST", headers, body, 10 * 60 * 1000);
        task.status = response.ok ? "succeeded" : "failed";
        task.statusCode = response.status;
        task.headers = { "content-type": response.headers.get("content-type") || "application/json" };
        task.body = Buffer.from(await response.arrayBuffer());
    } catch (error) {
        task.status = "failed";
        task.statusCode = 502;
        task.headers = { "content-type": "application/json" };
        task.body = Buffer.from(JSON.stringify({ error: { message: error instanceof Error ? error.message : "上游请求失败" } }));
    }
    task.updatedAt = Date.now();
}

function readImageTask(res, id) {
    const task = tasks.get(id);
    if (!task) return writeJson(res, 404, { error: { message: "任务不存在或已过期" } });
    if (task.status === "queued" || task.status === "running") return writeJson(res, 202, { id, status: task.status });
    res.writeHead(task.statusCode, task.headers);
    return res.end(task.body);
}

function upstreamUrl(pathname, route) {
    const path = pathname.replace(route.ddshub ? /^\/ddshub/ : /^\/fastai/, "");
    if (route.fastai && path === "/v1/images/generations") return `https://fast.ns.tisoz.com${path}`;
    return route.ddshub ? `https://www.ddshub.cc${path}` : `https://www.fastaitoken.com${path}`;
}

async function fetchUpstream(url, method, headers, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const forwarded = {};
        if (headers.authorization) forwarded.authorization = headers.authorization;
        if (headers["content-type"]) forwarded["content-type"] = headers["content-type"];
        return await fetch(url, { method, headers: forwarded, body, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

async function serveStatic(res, pathname) {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = normalize(join(root, requested));
    const safeRoot = root.endsWith(sep) ? root : root + sep;
    if (!file.startsWith(safeRoot) || !existsSync(file)) return createReadStream(join(root, "index.html")).pipe(res);
    res.writeHead(200, { "content-type": mimeTypes[extname(file)] || "application/octet-stream" });
    return createReadStream(file).pipe(res);
}

async function writeResponse(res, response) {
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" });
    return res.end(Buffer.from(await response.arrayBuffer()));
}

function writeJson(res, status, value) { return writeText(res, status, "application/json", JSON.stringify(value)); }
function writeText(res, status, contentType, body) { res.writeHead(status, { "content-type": contentType }); return res.end(body); }
