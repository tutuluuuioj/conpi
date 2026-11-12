import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4000);
const TEE_BASE_URL = (
  process.env.TEE_BASE_URL ||
  "https://ce5044ca834d2da5bb1252706bfa3b2c91d7d934-3000.dstack-pha1-prod5.phala.network"
).replace(/\/$/, "");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function relay(req, res, upstreamPath) {
  const authorization = String(req.headers.authorization || "");
  const xApiKey = String(req.headers["x-api-key"] || "");
  const body = req.method === "GET" ? undefined : await readBody(req);
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const upstream = await fetch(`${TEE_BASE_URL}${upstreamPath}`, {
      method: req.method,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(xApiKey ? { "X-API-Key": xApiKey } : {}),
        ...(body ? { "Content-Type": String(req.headers["content-type"] || "application/json") } : {}),
      },
      body,
      signal: abortController.signal,
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Cache-Control": upstream.headers.get("cache-control") || "no-store",
      ...(upstream.headers.get("retry-after") ? { "Retry-After": upstream.headers.get("retry-after") } : {}),
    });
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error?.message || "TEE proxy unavailable", code: "tee_unavailable" } }));
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const requestUrl = new URL(req.url || "/", "http://localhost");
  const pathname = requestUrl.pathname;
  const meterMatch = pathname.match(/^\/?(?:v1\/)?deals\/(\d+)\/meter$/);
  if (req.method === "GET" && meterMatch) {
    return relay(req, res, `/v1/deals/${meterMatch[1]}/meter`);
  }
  if (req.method === "POST" && ["/api/proxy", "/v1/chat/completions", "/chat/completions"].includes(pathname)) {
    return relay(req, res, "/v1/chat/completions");
  }
  if (req.method === "POST" && ["/v1/messages", "/messages"].includes(pathname)) {
    return relay(req, res, "/v1/messages");
  }
  if (req.method === "POST" && ["/v1/embeddings", "/embeddings"].includes(pathname)) {
    return relay(req, res, "/v1/embeddings");
  }
  if (req.method === "GET" && ["/v1/models", "/models"].includes(pathname)) {
    return relay(req, res, "/v1/models");
  }

  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = path.resolve(__dirname, requested);
  if (!filePath.startsWith(`${__dirname}${path.sep}`) && filePath !== path.join(__dirname, "index.html")) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("Internal Server Error");
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Conpi chatbot gateway running at http://localhost:${PORT}`);
  console.log(`All authenticated inference and metering is relayed to ${TEE_BASE_URL}`);
});
