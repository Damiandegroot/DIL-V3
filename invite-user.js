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

function getBearerToken(req) {
  const auth = String(req.headers?.authorization || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function normalizeRole(value) {
  return String(value || "").toLowerCase() === "supervisor" ? "supervisor" : "sales_rep";
}

function getCallerRole(userPayload) {
  const role =
    userPayload?.app_metadata?.role ||
    userPayload?.user_metadata?.role ||
    "sales_rep";
  return normalizeRole(role);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({
      error: "missing_server_config",
      message: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables.",
    });
  }

  const callerToken = getBearerToken(req);
  if (!callerToken) {
    return res.status(401).json({ error: "missing_token", message: "Missing bearer token." });
  }

  const body = parseJsonBody(req.body);
  const email = String(body?.email || "").trim().toLowerCase();
  const role = normalizeRole(body?.role);
  const fullName = String(body?.fullName || "").trim();
  const department = String(body?.department || "").trim();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email", message: "Provide a valid email address." });
  }

  try {
    const callerUserRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: anonKey || serviceRoleKey,
        Authorization: `Bearer ${callerToken}`,
      },
    });
    const callerUserPayload = await callerUserRes.json().catch(() => ({}));
    if (!callerUserRes.ok) {
      return res.status(401).json({
        error: "invalid_session",
        message: callerUserPayload?.msg || callerUserPayload?.message || "Invalid session token.",
      });
    }

    const callerRole = getCallerRole(callerUserPayload);
    if (callerRole !== "supervisor") {
      return res.status(403).json({
        error: "forbidden",
        message: "Only supervisors can invite users.",
      });
    }

    const redirectTo = String(
      process.env.SUPABASE_INVITE_REDIRECT_URL || req.headers?.origin || ""
    ).trim();

    const invitePayload = {
      email,
      data: {
        role,
        full_name: fullName || email.split("@")[0],
        department: department || "",
      },
    };
    if (redirectTo) invitePayload.redirect_to = redirectTo;

    const inviteRes = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify(invitePayload),
    });
    const inviteResult = await inviteRes.json().catch(() => ({}));
    if (!inviteRes.ok) {
      return res.status(inviteRes.status).json({
        error: "invite_failed",
        message: inviteResult?.msg || inviteResult?.message || "Invite request failed.",
        detail: inviteResult?.error_description || inviteResult?.error || "",
      });
    }

    return res.status(200).json({
      ok: true,
      invited: email,
      role,
    });
  } catch (error) {
    return res.status(500).json({
      error: "server_error",
      message: String(error?.message || error),
    });
  }
};
