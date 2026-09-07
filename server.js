// Zero-dependency Node.js backend for the Unified Response prototype.
// Serves the static front-end from /public and a small JSON REST API,
// plus a Server-Sent Events stream so every open dashboard updates live
// when any other client triggers or resolves an incident.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const auth = require("./lib/auth");
const store = require("./lib/store");
const { DEPARTMENTS, EMERGENCY_TYPES, publicIncidentView } = require("./lib/data");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ---------- SSE subscriber registry ----------
const sseClients = new Set();

function broadcastChange(eventName = "changed") {
  // SSE only carries a lightweight signal. Clients re-fetch authorized data
  // through the normal API, so incident details are not exposed in the stream.
  const payload = `event: ${eventName}\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ---------- Simple in-memory rate limit for the public citizen report endpoint ----------
const lastReportByIp = new Map();
const REPORT_COOLDOWN_MS = 10_000;

// ---------- Helpers ----------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB guard
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  const token = auth.getBearerToken(req);
  const payload = auth.verify(token);
  if (!payload) {
    sendJson(res, 401, { error: "Unauthorized. Log in and include the token as: Authorization: Bearer <token>" });
    return null;
  }
  return payload; // { sub, role, iat, exp }
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- Route handlers ----------
async function handleApi(req, res, pathname) {
  const method = req.method;

  // Public: department directory (names/icons only, not internal feature lists)
  if (method === "GET" && pathname === "/api/departments") {
    return sendJson(res, 200, DEPARTMENTS.map(({ id, name, icon, website }) => ({ id, name, icon, website })));
  }

  // Auth required: a department's own full feature list (self or command only)
  const fullMatch = pathname.match(/^\/api\/departments\/([a-z]+)\/full$/);
  if (method === "GET" && fullMatch) {
    const user = requireAuth(req, res);
    if (!user) return;
    const deptId = fullMatch[1];
    if (user.role !== "command" && user.role !== deptId) {
      return sendJson(res, 403, { error: "Forbidden: you can only view your own department's full access." });
    }
    const dept = DEPARTMENTS.find(d => d.id === deptId);
    if (!dept) return sendJson(res, 404, { error: "Unknown department" });
    return sendJson(res, 200, dept);
  }

  // Public: routing rulebook (policy metadata, not sensitive)
  if (method === "GET" && pathname === "/api/emergency-types") {
    return sendJson(res, 200, EMERGENCY_TYPES);
  }

  // Public: citizen-safe filtered incident view
  if (method === "GET" && pathname === "/api/incidents/active/public") {
    return sendJson(res, 200, publicIncidentView(store.getActiveIncident()));
  }

  // Auth required: pending citizen reports are visible only to Command Centre.
  if (method === "GET" && pathname === "/api/incidents/pending") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role !== "command") return sendJson(res, 403, { error: "Forbidden" });
    return sendJson(res, 200, store.getPendingCitizenReports());
  }

  // Auth required: full incident detail (command + any department)
  if (method === "GET" && pathname === "/api/incidents/active") {
    const user = requireAuth(req, res);
    if (!user) return;
    return sendJson(res, 200, store.getActiveIncident());
  }
// Auth required: pending citizen emergency alerts.
// Only Command Centre can see these alerts.
if (method === "GET" && pathname === "/api/incidents/pending") {
  const user = requireAuth(req, res);

  if (!user) return;

  if (user.role !== "command") {
    return sendJson(res, 403, {
      error: "Forbidden: only Command Centre can view pending citizen alerts."
    });
  }

  const pending = store.load().incidents.filter(
    i => i.status === "pending" && i.createdBy === "citizen"
  );

  return sendJson(res, 200, pending);
}
  // Auth required: event log (command + any department)
  if (method === "GET" && pathname === "/api/log") {
    const user = requireAuth(req, res);
    if (!user) return;
    return sendJson(res, 200, store.getLog());
  }

  // Login
  if (method === "POST" && pathname === "/api/auth/login") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }
    const { username, password } = body;
    const user = store.getUser(username);
    if (!user || !auth.verifyPassword(password || "", user.salt, user.hash)) {
      return sendJson(res, 401, { error: "Invalid username or password" });
    }
    const token = auth.issueToken({ username: user.username, role: user.role });
    return sendJson(res, 200, { token, role: user.role });
  }

  // Command triggers a classified emergency (any type)
  if (method === "POST" && pathname === "/api/incidents/trigger") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role !== "command") {
      return sendJson(res, 403, { error: "Forbidden: only the command centre can classify and trigger events." });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }
    const type = EMERGENCY_TYPES.find(t => t.id === body.typeId);
    if (!type) return sendJson(res, 400, { error: "Unknown emergency type" });
    const incident = createIncident(type, "command", body);
    return sendJson(res, 200, incident);
  }

  // Citizen SOS — creates a PENDING alert.
// It is NOT routed to departments until Command Centre approves it.
if (method === "POST" && pathname === "/api/incidents/report") {
  const ip = req.socket.remoteAddress || "unknown";
  const last = lastReportByIp.get(ip) || 0;

  if (Date.now() - last < REPORT_COOLDOWN_MS) {
    return sendJson(res, 429, {
      error: "Please wait before reporting again."
    });
  }

  lastReportByIp.set(ip, Date.now());

  let body = {};

  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, {
      error: "Invalid JSON body"
    });
  }

  const departmentId = body.departmentId;

  const department = DEPARTMENTS.find(
    d => d.id === departmentId
  );

  if (!department) {
    return sendJson(res, 400, {
      error: "Please select a valid emergency department."
    });
  }

  const type = EMERGENCY_TYPES.find(
    t => t.routes.includes(departmentId)
  ) || {
    id: departmentId,
    label: department.name,
    severity: "standard",
    routes: [departmentId]
  };

  const s = store.load();

  const id = `INC-${1000 + s.incidents.length}`;

  const time = new Date().toLocaleTimeString();

  const incident = {
    id,
    typeId: type.id,
    label: department.name,
    severity: type.severity,
    routes: [departmentId],
    time,
    status: "pending",
    createdBy: "citizen",

    location: body.location || "Not provided",

    latitude:
      body.latitude !== undefined
        ? body.latitude
        : null,

    longitude:
      body.longitude !== undefined
        ? body.longitude
        : null,

    details: body.details || "",

    departmentStatuses: {}
  };

  s.incidents.unshift(incident);

  store.addLog({
    id: `${id}-log`,
    text: `Citizen emergency reported — awaiting Command Centre decision (${department.name})`,
    time
  });

  store.save();

  // Notify Command Centre only.
  broadcastChange("citizen-emergency");

  return sendJson(res, 200, {
    ok: true,
    pending: true,
    incidentId: incident.id,
    message: "Emergency report sent to Command Centre."
  });
}

  // Command Centre decides whether to implement a citizen report.
  if (method === "POST" && pathname === "/api/incidents/citizen-decision") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role !== "command") return sendJson(res, 403, { error: "Forbidden: only Command Centre can decide." });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid JSON body" }); }
    const report = store.removePendingCitizenReport(body.reportId);
    if (!report) return sendJson(res, 404, { error: "Citizen report not found or already processed." });

    const departmentToType = {
      traffic: "accident", health: "medical", hospital: "medical", fire: "fire",
      police: "accident", municipal: "flood", disaster: "flood", water: "flood"
    };
    const decision = body.decision;
    if (decision === "reject") {
      store.addLog({ id: `${report.id}-rejected`, text: `Citizen emergency report ${report.id} rejected by Command Centre`, time: new Date().toLocaleTimeString() });
      broadcastChange();
      return sendJson(res, 200, { ok: true, decision: "rejected" });
    }
    if (decision !== "approve") return sendJson(res, 400, { error: "Decision must be approve or reject." });

    const type = EMERGENCY_TYPES.find(t => t.id === (body.typeId || departmentToType[report.departmentId]));
    if (!type) return sendJson(res, 400, { error: "Unable to classify this report." });
    const incident = createIncident(type, "citizen", report);
    store.addLog({ id: `${report.id}-approved`, text: `Command Centre approved citizen report ${report.id} — emergency implemented`, time: new Date().toLocaleTimeString() });
    broadcastChange();
    return sendJson(res, 200, incident);
  }

  // A routed department updates only its own incident status.
  if (method === "POST" && pathname === "/api/incidents/status") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role === "command") return sendJson(res, 403, { error: "Command centre cannot change a department's operational status." });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: "Invalid JSON body" }); }
    const allowed = ["NEW", "ACCEPTED", "DISPATCHED", "ARRIVED", "RESOLVED"];
    if (!allowed.includes(body.status)) return sendJson(res, 400, { error: "Invalid status" });
    const order = Object.fromEntries(allowed.map((x, i) => [x, i]));
    const incident = store.getActiveIncident();
    if (!incident || !(incident.routes || []).includes(user.role)) return sendJson(res, 404, { error: "No active incident routed to this department" });
    const current = (incident.departmentStatuses || {})[user.role] || "NEW";
    if (order[body.status] < order[current] || order[body.status] > order[current] + 1) {
      return sendJson(res, 400, { error: `Invalid transition: ${current} → ${body.status}` });
    }
    const updated = store.updateIncidentDepartmentStatus(user.role, body.status);
    store.addLog({ id: `${updated.id}-${user.role}-${Date.now()}`, text: `${deptName(user.role)} status changed to ${body.status}`, time: new Date().toLocaleTimeString() });
    broadcastChange();
    return sendJson(res, 200, updated);
  }

  // Command resolves the active incident
  if (method === "POST" && pathname === "/api/incidents/resolve") {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.role !== "command") {
      return sendJson(res, 403, { error: "Forbidden: only the command centre can resolve incidents." });
    }
    store.resolveActiveIncident();
    store.addLog({ id: `resolve-${Date.now()}`, text: "Incident marked resolved", time: new Date().toLocaleTimeString() });
    broadcastChange();
    return sendJson(res, 200, { ok: true });
  }

  // Live update stream
  if (method === "GET" && pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function deptName(id) {
  const d = DEPARTMENTS.find(x => x.id === id);
  return d ? d.name : id;
}

function createIncident(type, createdBy, details = {}) {
  const s = store.load();
  const id = `INC-${1000 + s.incidents.length}`;
  const time = new Date().toLocaleTimeString();
  const departmentStatuses = Object.fromEntries(type.routes.map(id => [id, "NEW"]));
  const incident = {
    id, typeId: type.id, label: type.label, severity: type.severity,
    routes: type.routes, time, status: "active", createdBy,
    location: details.location || "Not provided",
    latitude: details.latitude ?? null, longitude: details.longitude ?? null,
    details: details.details || "",
    departmentStatuses,
  };
  store.addIncident(incident);
  store.addLog({
    id: `${id}-log`,
    text: `${type.label} classified — routed to ${type.routes.length} departments${createdBy === "citizen" ? " (citizen-reported)" : ""}`,
    time,
  });
  broadcastChange();
  return incident;
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, pathname);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: "Internal server error" });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

store.load(); // ensure demo accounts are seeded before first request
server.listen(PORT, () => {
  console.log(`Unified Response server running at http://localhost:${PORT}`);
});
