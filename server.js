const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 3000);

function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (!key || process.env[key] !== undefined) return;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

loadEnvFile();

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (err) => reject(err));
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".xlsx")
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function normalizeStaticPath(urlPath) {
  let safePath = decodeURIComponent(urlPath.split("?")[0]);
  if (safePath === "/") safePath = "/index.html";
  const resolved = path.resolve(ROOT_DIR, `.${safePath}`);
  if (!resolved.startsWith(ROOT_DIR)) return null;
  return resolved;
}

function extractAssistantAnswer(payload) {
  if (!payload) return "";
  const choice = payload.choices && payload.choices[0];
  if (!choice) return "";
  const content = choice.message && choice.message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function buildFallbackUserPrompt(query, cases) {
  const lines = [];
  lines.push(`User question: ${query || ""}`);
  lines.push("");
  lines.push("Candidate archive cases:");
  (cases || []).slice(0, 8).forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.id || "Unknown ID"} | ${item.title || "Untitled case"}`);
    lines.push(`Type: ${item.type || "unknown"} | Status: ${item.status || "unknown"} | Department: ${item.department || "unknown"}`);
    lines.push(`Description: ${item.description || ""}`);
    lines.push(`Solution: ${item.solution || "No documented solution yet."}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function handleAssistantApi(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    json(res, 500, {
      error: "missing_api_key",
      message: "Set OPENAI_API_KEY in .env before starting the server.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    json(res, 400, { error: "invalid_request", message: error.message });
    return;
  }

  const model = String(body?.model || "gpt-4o-mini");
  const temperature = Number.isFinite(Number(body?.temperature))
    ? Number(body.temperature)
    : 0.2;
  const systemPrompt = String(
    body?.systemPrompt ||
      "You are the RED in-SYNCC Smart Assistant. Use only provided archive context."
  );
  const query = String(body?.query || "");
  const cases = Array.isArray(body?.cases) ? body.cases : [];
  const userPrompt = String(body?.userPrompt || buildFallbackUserPrompt(query, cases));

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      json(res, response.status, {
        error: "openai_request_failed",
        detail: payload?.error?.message || "Unknown OpenAI error",
      });
      return;
    }

    const answer = extractAssistantAnswer(payload);
    json(res, 200, { answer });
  } catch (error) {
    json(res, 500, { error: "server_error", detail: String(error.message || error) });
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url || "/";

  if (urlPath.startsWith("/api/openai-assistant")) {
    await handleAssistantApi(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method_not_allowed" });
    return;
  }

  const filePath = normalizeStaticPath(urlPath);
  if (!filePath) {
    text(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.join(ROOT_DIR, "index.html");
    if (!fs.existsSync(fallback)) {
      text(res, 404, "Not found");
      return;
    }
    const data = fs.readFileSync(fallback);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(data);
    return;
  }

  const contentType = getContentType(filePath);
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(data);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`RED in-SYNCC server running on http://localhost:${PORT}`);
});
