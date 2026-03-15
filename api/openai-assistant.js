function parseJsonBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return {};
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

  (cases || []).slice(0, 8).forEach((item, index) => {
    lines.push(`${index + 1}. ${item.id || "Unknown ID"} | ${item.title || "Untitled case"}`);
    lines.push(
      `Type: ${item.type || "unknown"} | Status: ${item.status || "unknown"} | Department: ${item.department || "unknown"}`
    );
    lines.push(`Description: ${item.description || ""}`);
    lines.push(`Solution: ${item.solution || "No documented solution yet."}`);
    lines.push("");
  });

  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "missing_api_key",
      message: "Set OPENAI_API_KEY in Vercel Environment Variables.",
    });
  }

  const body = parseJsonBody(req.body);
  const model = String(body?.model || "gpt-4o-mini");
  const temperature = Number.isFinite(Number(body?.temperature))
    ? Number(body.temperature)
    : 0.2;
  const systemPrompt = String(
    body?.systemPrompt || "You are the RED in-SYNCC Smart Assistant. Use only provided archive context."
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
      return res.status(response.status).json({
        error: "openai_request_failed",
        detail: payload?.error?.message || "Unknown OpenAI error",
      });
    }

    const answer = extractAssistantAnswer(payload);
    return res.status(200).json({ answer });
  } catch (error) {
    return res.status(500).json({
      error: "server_error",
      detail: String(error?.message || error),
    });
  }
};
