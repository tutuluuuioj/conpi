import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  // Disable socket timeouts for long-running AI streams
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true, 5000);
    req.socket.setNoDelay(true);
  }

  // Global CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = req.url.split("?")[0];

  // API Proxy Route: forwards client chat completions to target proxy with proper streaming & CORS
  if (reqUrl === "/api/proxy") {
    const targetUrl = req.headers["x-target-url"] || "https://b1b35377079ac7b7937afc607481587bc6d22665-3000.dstack-pha-prod9.phala.network/v1/chat/completions";
    const authHeader = req.headers["authorization"] || "";

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);

    const abortController = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader
        },
        body: bodyBuffer,
        signal: abortController.signal
      });

      const responseHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": upstreamRes.headers.get("content-type") || "application/json"
      };

      if (upstreamRes.headers.get("content-type")?.includes("text/event-stream")) {
        responseHeaders["Cache-Control"] = "no-cache, no-transform";
        responseHeaders["Connection"] = "keep-alive";
      }

      res.writeHead(upstreamRes.status, responseHeaders);
      if (res.flushHeaders) res.flushHeaders();

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[proxy-error]", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `Proxy gateway error: ${err.message}` } }));
        } else {
          res.end();
        }
      }
    }
    return;
  }

  // Static files
  let filePath = path.join(__dirname, reqUrl === "/" ? "index.html" : reqUrl);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, "index.html");
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "text/plain";

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache"
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`🤖 AI Chatbot running at: http://localhost:${PORT}`);
  console.log(`📂 Serving directory: ${__dirname}`);
});
