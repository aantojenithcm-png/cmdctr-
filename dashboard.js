// ---------- API helpers ----------
const Auth = {
  KEY: "ur_auth_tokens",
  getAll() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; }
    catch { return {}; }
  },
  get(role) { return this.getAll()[role] || null; },
  set(role, token) {
    const all = this.getAll();
    all[role] = token;
    localStorage.setItem(this.KEY, JSON.stringify(all));
  },
  clear(role) {
    const all = this.getAll();
    delete all[role];
    localStorage.setItem(this.KEY, JSON.stringify(all));
  },
};

async function apiGet(path, { auth: needsAuth = false, role } = {}) {
  const headers = {};
  if (needsAuth) {
    const token = Auth.get(role);
    if (!token) return { status: 401, data: null };
    headers["Authorization"] = "Bearer " + token;
  }
  const res = await fetch(path, { headers });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

async function apiPost(path, body, { auth: needsAuth = false, role } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (needsAuth) {
    const token = Auth.get(role);
    if (!token) return { status: 401, data: null };
    headers["Authorization"] = "Bearer " + token;
  }
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

let selectedHospitalByReport = {};

// ---------- Global state (reference data fetched once; everything else is live) ----------
const state = {
  role: "command",
  departments: [],    // [{id, name, icon}]  — fetched from /api/departments
  emergencyTypes: [], // [{id, label, severity, routes}] — fetched from /api/emergency-types
};

function isProtectedRole(role) {
  return role === "command" || state.departments.some(d => d.id === role);
}

function sevPillClass(sev) {
  return sev === "critical" ? "red" : sev === "elevated" ? "amber" : "teal";
}

function deptName(id) {
  const d = state.departments.find(x => x.id === id);
  return d ? d.name : id;
}

function showCommandCitizenAlert() {
  // Remove an older banner so repeated reports don't stack indefinitely.
  document.getElementById("citizen-emergency-alert")?.remove();

  const alert = document.createElement("div");
  alert.id = "citizen-emergency-alert";
  alert.style.cssText = `
    position:fixed; top:18px; right:18px; z-index:9999;
    width:min(420px, calc(100vw - 36px)); padding:16px 18px;
    border:2px solid var(--red); border-radius:10px;
    background:var(--panel); color:var(--text);
    box-shadow:0 12px 30px rgba(0,0,0,.35);
  `;
  alert.innerHTML = `
    <div style="font-weight:800; color:var(--red); font-size:14px; letter-spacing:.04em;">
      🚨 CITIZEN EMERGENCY REPORT
    </div>
    <div style="margin-top:6px; font-size:13.5px;">
      A citizen has reported an emergency. Review the new incident immediately.
    </div>
    <button id="citizen-alert-open" class="trigger-btn"
      style="margin-top:10px; background:var(--red); color:white; border:none; cursor:pointer;">
      View emergency
    </button>
    <button id="citizen-alert-close" class="resolve-btn" style="margin-left:6px;">
      Dismiss
    </button>
  `;
  document.body.appendChild(alert);

  document.getElementById("citizen-alert-open").onclick = () => {
    alert.remove();
    state.role = "command";
    render();
  };
  document.getElementById("citizen-alert-close").onclick = () => alert.remove();

  // Try a short attention sound. Browsers may block it; that is harmless.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch {}

  // If the operator has already granted notification permission, also show
  // a native desktop notification. We do not request permission automatically.
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Citizen emergency reported", {
        body: "A new emergency report is waiting in Command Centre.",
      });
    }
  } catch {}

  setTimeout(() => alert.remove(), 15000);
}

// ---------- Rail ----------
function renderRail() {
  const rail = document.getElementById("rail-buttons");
  const options = [
    { id: "command", name: "Command Centre", icon: "tower-broadcast" },
    ...state.departments.map(d => ({ id: d.id, name: d.name, icon: d.icon })),
    { id: "citizen", name: "Citizen", icon: "users" },
  ];
  rail.innerHTML = options.map(opt => `
    <button class="rail-btn ${state.role === opt.id ? "active" : ""}" data-role="${opt.id}">
      <span class="icon" data-icon="${opt.icon}"></span><span>${opt.name}</span>
    </button>
  `).join("");
  rail.querySelectorAll(".rail-btn").forEach(btn => {
    btn.addEventListener("click", () => { state.role = btn.dataset.role; render(); });
  });
}

// ---------- Login screen (shown for any protected role with no valid token) ----------
function renderLogin(role, message) {
  const label = role === "command" ? "Command Centre" : deptName(role);
  document.getElementById("main").innerHTML = `
    <div class="main-head">
      <h2>Sign in — ${label}</h2>
    </div>
    <div class="dpanel" style="max-width:360px;">
      <form id="login-form">
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:var(--muted); display:block; margin-bottom:6px;">Password</label>
          <input type="password" id="login-password" autocomplete="current-password"
            style="width:100%; padding:10px; border-radius:6px; border:1px solid var(--border); background:var(--panel2); color:var(--text); font-family:var(--font-body); box-sizing:border-box;">
        </div>
        <div id="login-error" style="color:var(--red); font-size:13px; margin-bottom:10px; ${message ? "" : "display:none;"}">${message || ""}</div>
        <button type="submit" class="trigger-btn" style="width:100%; background:var(--teal); color:#06231F; border:none; font-weight:600; cursor:pointer;">Sign in</button>
      </form>
    </div>
  `;
  const form = document.getElementById("login-form");
  document.getElementById("login-password").focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = document.getElementById("login-password").value;
    const r = await apiPost("/api/auth/login", { username: role, password });
    if (r.status !== 200) {
      const err = document.getElementById("login-error");
      err.textContent = (r.data && r.data.error) || "Login failed";
      err.style.display = "block";
      return;
    }
    Auth.set(role, r.data.token);
    render();
  });
}

function logoutLink() {
  return `<button id="logout-btn" class="resolve-btn" style="margin-left:auto;">Log out</button>`;
}

function wireLogout(role) {
  const btn = document.getElementById("logout-btn");
  if (btn) btn.addEventListener("click", () => { Auth.clear(role); render(); });
}

// ---------- Command Centre ----------
async function renderCommand() {
  const [incRes, pendingRes, logRes] = await Promise.all([
    apiGet("/api/incidents/active", { auth: true, role: "command" }),
    apiGet("/api/incidents/pending", { auth: true, role: "command" }),
    apiGet("/api/log", { auth: true, role: "command" }),
  ]);

  if (incRes.status === 401 || pendingRes.status === 401 || logRes.status === 401) {
    Auth.clear("command");
    return renderLogin("command", "Your session expired — please sign in again.");
  }

  const inc = incRes.data;
  const pending = pendingRes.data || [];
  const log = logRes.data || [];

  const triggerButtons = state.emergencyTypes.map(t => `
    <button class="trigger-btn sev-${t.severity}" data-trigger="${t.id}">${t.label}</button>
  `).join("");

  const pendingAlerts = pending.length ? pending.map(p => `
    <div class="dpanel accent" style="margin-bottom:10px;">
      <div class="incident-top">
        <div>
          <span class="incident-id">${p.id}</span>
          <span class="pill amber">PENDING DECISION</span>

          <div class="incident-title" style="margin-top:6px;">
            🚨 ${p.label}
          </div>

          <div class="incident-time">
            ${p.time} · citizen-reported
          </div>

          <div style="font-size:13px; margin-top:8px;">
            📍 ${p.location || "Not provided"}
          </div>

          ${p.latitude != null && p.longitude != null ? `
            <div style="margin-top:6px;">
              <a href="https://www.google.com/maps?q=${p.latitude},${p.longitude}"
                 target="_blank"
                 rel="noopener noreferrer"
                 style="color:var(--teal);">
                Open location in Google Maps ↗
              </a>
            </div>
          ` : ""}

          ${p.details ? `
            <div style="font-size:13px; color:var(--muted); margin-top:6px;">
              ${p.details}
            </div>
          ` : ""}
        </div>
      </div>

      ${p.latitude != null && p.longitude != null ? `
        <div style="margin-top:12px;">
          <button class="trigger-btn" data-ai-hospitals="${p.id}"
            style="background:var(--panel2); border:1px solid var(--teal); color:var(--teal); font-weight:700;">
            🤖 AI Find Top 5 Nearest Government Hospitals
          </button>
          <div id="ai-hospitals-${p.id}" style="margin-top:10px;"></div>
        </div>
      ` : `
        <div style="font-size:12px; color:var(--amber); margin-top:10px;">
          AI hospital matching requires the citizen's GPS coordinates.
        </div>
      `}

      <div style="display:flex; gap:8px; margin-top:12px;">
        <button class="trigger-btn" data-implement="${p.id}"
          style="background:var(--teal); color:#06231F; border:none; font-weight:700;">
          Implement emergency
        </button>

        <button class="resolve-btn" data-reject="${p.id}">
          Reject
        </button>
      </div>
    </div>
  `).join("") : `
    <div class="dpanel" style="font-size:13px; color:var(--muted);">
      No pending citizen emergency alerts.
    </div>
  `;

  const incidentCard = inc ? `
    <div class="dpanel accent">
      <div class="incident-top">
        <div>
          <span class="incident-id">${inc.id}</span>
          <span class="pill ${sevPillClass(inc.severity)}">${inc.severity}</span>

          <div class="incident-title">${inc.label}</div>

          <div class="incident-time">
            ${inc.time}${inc.createdBy === "citizen" ? " · citizen-reported" : ""}
          </div>

          <div style="font-size:13px; margin-top:8px;">
            📍 ${inc.location || "Not provided"}
          </div>

          ${inc.latitude != null && inc.longitude != null ? `
            <div style="margin-top:6px;">
              <a href="https://www.google.com/maps?q=${inc.latitude},${inc.longitude}"
                 target="_blank"
                 rel="noopener noreferrer"
                 style="color:var(--teal);">
                Open location in Google Maps ↗
              </a>
            </div>
          ` : ""}

          ${inc.details ? `
            <div style="font-size:13px; color:var(--muted); margin-top:4px;">
              ${inc.details}
            </div>
          ` : ""}
        </div>

        <button class="resolve-btn" id="resolve-btn">
          Mark resolved
        </button>
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:12px;">
        ${(inc.routes || []).map(id => `
          <span class="pill teal">${deptName(id)}</span>
        `).join("")}
      </div>
    </div>
  ` : "";

  const statusGrid = state.departments.map(d => {
    const routed = inc && (inc.routes || []).includes(d.id);
    const status = routed
      ? ((inc.departmentStatuses || {})[d.id] || "NEW")
      : "IDLE";

    return `
      <div class="status-tile ${routed ? "routed" : ""}">
        <span class="icon st-icon" data-icon="${d.icon}"></span>
        <div class="st-name">${d.name}</div>
        <div class="st-state">${status}</div>
      </div>
    `;
  }).join("");

  const logRows = log.length ? log.map(e => `
    <div class="log-row">
      <span>${e.text}</span>
      <span class="log-time">${e.time}</span>
    </div>
  `).join("") : `
    <div style="font-size:13px; color:var(--muted);">
      No events yet.
    </div>
  `;

  document.getElementById("main").innerHTML = `
    <div class="command-visual" aria-hidden="true">
      <div class="command-visual-ring ring-a"></div>
      <div class="command-visual-ring ring-b"></div>
      <div class="command-visual-center"><span class="icon" data-icon="tower-broadcast"></span></div>
      <div class="rescue-hand hand-left">🫱</div>
      <div class="rescue-hand hand-right">🫲</div>
      <div class="rescue-unit unit-1"><span class="icon" data-icon="truck-medical"></span></div>
      <div class="rescue-unit unit-2"><span class="icon" data-icon="fire-extinguisher"></span></div>
      <div class="rescue-unit unit-3"><span class="icon" data-icon="shield-halved"></span></div>
      <div class="rescue-unit unit-4"><span class="icon" data-icon="hospital"></span></div>
    </div>
    <div class="main-head command-head" style="display:flex; align-items:flex-start;">
      <div>
        <div class="visual-kicker">COORDINATE • CONNECT • RESCUE</div>
        <h2>Command centre</h2>
        <div class="sub">
          Reviews citizen alerts and decides whether to implement emergency response.
        </div>
      </div>
      ${logoutLink()}
    </div>

    <div class="label-row" style="margin-top:8px;">
      🚨 Citizen emergency alerts
    </div>

    ${pendingAlerts}

    <div class="dpanel">
      <div class="label-row">
        Classify and trigger an event
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
        <input id="incident-location"
          placeholder="Location (e.g. Anna Nagar, Chennai)"
          style="padding:10px; border-radius:6px; border:1px solid var(--border); background:var(--panel2); color:var(--text);">

        <input id="incident-details"
          placeholder="Short emergency details"
          style="padding:10px; border-radius:6px; border:1px solid var(--border); background:var(--panel2); color:var(--text);">
      </div>

      <div class="trigger-row">${triggerButtons}</div>
    </div>

    ${incidentCard}

    <div class="label-row" style="margin-top:8px;">
      Department status
    </div>

    <div class="status-grid">${statusGrid}</div>

    <div class="label-row">Event log</div>

    <div class="dpanel">${logRows}</div>
  `;

  wireLogout("command");

  document.querySelectorAll("[data-trigger]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;

      const r = await apiPost("/api/incidents/trigger", {
        typeId: btn.dataset.trigger,
        location: document.getElementById("incident-location")?.value.trim(),
        details: document.getElementById("incident-details")?.value.trim()
      }, { auth: true, role: "command" });

      if (r.status === 401) {
        Auth.clear("command");
        return render();
      }

      render();
    });
  });


  document.querySelectorAll("[data-ai-hospitals]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const report = pending.find(x => x.id === btn.dataset.aiHospitals);
      const target = document.getElementById(`ai-hospitals-${btn.dataset.aiHospitals}`);
      if (!report || !target) return;

      target.innerHTML = `<div class="dpanel" style="font-size:12px; color:var(--muted);">AI is analysing distance, emergency capability and available-bed data…</div>`;

      const r = await apiPost("/api/hospitals/recommend", {
        latitude: report.latitude,
        longitude: report.longitude,
        typeId: report.typeId === "hospital" ? "medical" : (report.typeId || "medical"),
        details: report.details || ""
      }, { auth: true, role: "command" });

      if (r.status === 401) {
        Auth.clear("command");
        return render();
      }

      if (r.status !== 200) {
        target.innerHTML = `<div class="dpanel" style="color:var(--amber);">${(r.data && r.data.error) || "AI hospital recommendation failed."}</div>`;
        btn.disabled = false;
        return;
      }

      const data = r.data;
      const cards = (data.hospitals || []).map((h, index) => `
        <div class="dpanel" style="margin-top:8px; border-left:3px solid var(--teal);">
          <div style="display:flex; justify-content:space-between; gap:8px;">
            <div>
              <strong>#${index + 1} ${h.name}</strong>
              <div style="font-size:12px; color:var(--muted); margin-top:3px;">
                ${h.district} · ${h.type} · ${h.distanceKm} km
              </div>
            </div>
            <span class="pill teal">AI ${h.aiScore}</span>
          </div>
          <div style="font-size:12px; margin-top:8px;">
            <strong>Available beds:</strong>
            ${Number.isFinite(h.availableBeds) ? h.availableBeds : "Live feed required"}
            ${Number.isFinite(h.availableBeds) ? ` / ${h.totalBeds}` : ` · total capacity ${h.totalBeds}`}
          </div>
          <div style="font-size:12px; color:var(--muted); margin-top:5px;">
            ${h.recommendationReason}
          </div>
          <div style="display:flex; gap:7px; margin-top:9px; flex-wrap:wrap;">
            <button class="trigger-btn" data-select-hospital="${h.id}" data-report-id="${report.id}">
              Select hospital
            </button>
            <a class="resolve-btn" style="text-decoration:none; display:inline-flex; align-items:center;"
               href="https://www.google.com/maps/dir/?api=1&destination=${h.latitude},${h.longitude}"
               target="_blank" rel="noopener noreferrer">
              Navigate ↗
            </a>
          </div>
        </div>
      `).join("");

      target.innerHTML = `
        <div class="dpanel accent" style="margin-top:10px;">
          <div style="font-weight:700;">🤖 AI hospital recommendation</div>
          <div style="font-size:11.5px; color:var(--muted); margin-top:4px;">
            ${data.method}
          </div>
          <div style="font-size:11.5px; color:var(--amber); margin-top:5px;">
            ${data.bedDataStatus}
          </div>
        </div>
        ${cards || `<div class="dpanel">No suitable government hospitals found.</div>`}
      `;

      target.querySelectorAll("[data-select-hospital]").forEach(selectBtn => {
        selectBtn.addEventListener("click", async () => {
          selectBtn.disabled = true;
          const sr = await apiPost("/api/hospitals/select", {
            hospitalId: selectBtn.dataset.selectHospital,
            reportId: selectBtn.dataset.reportId
          }, { auth: true, role: "command" });
          if (sr.status === 401) {
            Auth.clear("command");
            return render();
          }
          if (sr.status === 200) {
            selectedHospitalByReport[selectBtn.dataset.reportId] = selectBtn.dataset.selectHospital;
            selectBtn.textContent = "✓ Hospital selected";
            selectBtn.style.background = "var(--teal)";
            selectBtn.style.color = "#06231F";
            selectBtn.dataset.selected = "true";
          } else {
            selectBtn.disabled = false;
            alert((sr.data && sr.data.error) || "Unable to select hospital.");
          }
        });
      });
    });
  });

  document.querySelectorAll("[data-implement]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const reportId = btn.dataset.implement;
      const hospitalId = selectedHospitalByReport[reportId];

      if (!hospitalId) {
        alert("Please use AI Find Top 5, select a hospital, and then implement the emergency.");
        return;
      }

      btn.disabled = true;

      const r = await apiPost(
        "/api/incidents/citizen-decision",
        { reportId, decision: "approve", hospitalId },
        { auth: true, role: "command" }
      );

      if (r.status === 401) {
        Auth.clear("command");
        return render();
      }

      if (r.status !== 200) {
        btn.disabled = false;
        alert((r.data && r.data.error) || "Unable to implement emergency.");
        return;
      }

      delete selectedHospitalByReport[reportId];
      alert("Emergency implemented successfully.");
      render();
    });
  });

  document.querySelectorAll("[data-reject]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;

      const r = await apiPost(
        "/api/incidents/citizen-decision",
        { reportId: btn.dataset.reject, decision: "reject" },
        { auth: true, role: "command" }
      );

      if (r.status === 401) {
        Auth.clear("command");
        return render();
      }

      render();
    });
  });

  const resolveBtn = document.getElementById("resolve-btn");

  if (resolveBtn) {
    resolveBtn.addEventListener("click", async () => {
      const r = await apiPost(
        "/api/incidents/resolve",
        {},
        { auth: true, role: "command" }
      );

      if (r.status === 401) {
        Auth.clear("command");
      }

      render();
    });
  }
}

// ---------- Department view ----------
async function renderDepartment(deptId) {
  const [fullRes, incRes] = await Promise.all([
    apiGet(`/api/departments/${deptId}/full`, { auth: true, role: deptId }),
    apiGet("/api/incidents/active", { auth: true, role: deptId }),
  ]);
  if (fullRes.status === 401 || incRes.status === 401) {
    Auth.clear(deptId);
    return renderLogin(deptId, "Your session expired — please sign in again.");
  }
  const dept = fullRes.data;
  const inc = incRes.data;
  const isRouted = inc && inc.routes.includes(deptId);
  const others = inc ? inc.routes.filter(id => id !== deptId) : [];

  const currentStatus = isRouted ? ((inc.departmentStatuses || {})[deptId] || "NEW") : null;
  const statusOrder = ["NEW", "ACCEPTED", "DISPATCHED", "ARRIVED", "RESOLVED"];
  const nextStatus = isRouted ? statusOrder[statusOrder.indexOf(currentStatus) + 1] : null;
  const statusBlock = isRouted ? `
    <div class="dpanel accent-fill">
      <div style="font-size:12px; color:var(--teal); margin-bottom:4px;">ACTIVE — ${inc.id}</div>
      <div class="incident-title" style="margin-top:0;">${inc.label}</div>
      <div style="font-size:13px; margin-top:8px;">📍 ${inc.location || "Not provided"}</div>
      ${inc.details ? `<div style="font-size:13px; color:var(--muted); margin-top:4px;">${inc.details}</div>` : ""}
      <div style="margin-top:10px;"><span class="pill teal">${currentStatus}</span>${nextStatus ? ` <button class="trigger-btn" id="status-next" style="margin-left:8px;">Mark ${nextStatus}</button>` : ""}</div>
    </div>
  ` : `
    <div class="dpanel"><div style="font-size:13px; color:var(--muted);">No active incident routed to this department.</div></div>
  `;

  const features = dept.full.map(f => `
    <div class="feature-item ${isRouted ? "on" : ""}"><span class="icon" data-icon="circle-check"></span>${f}</div>
  `).join("");

  const othersBlock = (inc && others.length) ? `
    <div class="label-row"><span class="icon" data-icon="eye"></span> Other departments involved — status only, no edit access</div>
    <div style="display:flex; flex-wrap:wrap; gap:6px;">
      ${others.map(id => `<span class="pill">${deptName(id)} · ${(inc.departmentStatuses || {})[id] || "NEW"}</span>`).join("")}
    </div>
  ` : "";

  const fieldFocus = Array.isArray(dept.full) ? dept.full.slice(0, 4) : [];
  document.getElementById("main").innerHTML = `
    <div class="dept-field-banner dept-${deptId}" aria-hidden="true">
      <div class="dept-field-icon"><span class="icon" data-icon="${dept.icon}"></span></div>
      <div class="dept-field-copy">
        <div class="visual-kicker">${dept.name.toUpperCase()} • FIELD OPERATIONS</div>
        <div class="dept-field-points">${fieldFocus.map(x => `<span>${x}</span>`).join("")}</div>
      </div>
    </div>
    <div class="main-head dept-head dept-${deptId}" style="display:flex; align-items:flex-start;">
      <div>
        <h2><span class="icon" data-icon="${dept.icon}" style="color:var(--teal); margin-right:10px;"></span>${dept.name}</h2>
        <div class="sub">Full access to your own tools. Read-only summary of other departments during shared incidents.</div>
        <a href="${dept.website}" target="_blank" rel="noopener noreferrer" style="display:inline-block; margin-top:8px; color:var(--teal);">Official Tamil Nadu website ↗</a>
      </div>
      ${logoutLink()}
    </div>
    ${statusBlock}
    <div class="label-row"><span class="icon" data-icon="lock"></span> Full feature access</div>
    <div class="feature-grid">${features}</div>
    ${othersBlock}
  `;
  wireLogout(deptId);
  const statusNext = document.getElementById("status-next");
  if (statusNext) statusNext.addEventListener("click", async () => {
    statusNext.disabled = true;
    const r = await apiPost("/api/incidents/status", { status: nextStatus }, { auth: true, role: deptId });
    if (r.status === 401) { Auth.clear(deptId); return render(); }
    render();
  });
}

// ---------- Citizen view (no auth — hits the public-filtered endpoint only) ----------
async function renderCitizen() {
  const [{ data: pub }, { data: departments }] = await Promise.all([
    apiGet("/api/incidents/active/public"),
    apiGet("/api/departments")
  ]);

  const publicData = pub || {
    alert: "No active alerts in your area.",
    nearestER: "Open",
    roadClosures: "None nearby",
    ambulanceETA: "—"
  };

  const deptList = departments || state.departments || [];

  document.getElementById("main").innerHTML = `
    <div class="citizen-wrap">

      <div class="main-head">
        <h2>Citizen app</h2>
        <div class="sub">
          Only what you need to know — nothing internal to any department.
        </div>
      </div>

      <div style="display:grid; gap:8px; margin-bottom:12px;">

        <select id="citizen-department"
          style="padding:10px; border-radius:6px; border:1px solid var(--border);
          background:var(--panel2); color:var(--text);">

          <option value="">
            Select the type of emergency
          </option>

          ${deptList.map(d => `
            <option value="${d.id}">
              ${d.name}
            </option>
          `).join("")}

        </select>

        <input id="citizen-location"
          placeholder="Tap here to detect your live GPS location"
          readonly
          aria-label="Live GPS location"
          style="padding:10px; border-radius:6px; border:1px solid var(--border);
          background:var(--panel2); color:var(--text); cursor:pointer;">

        <div id="citizen-location-status"
          style="font-size:12.5px; color:var(--muted); margin-top:-8px;">
          📍 Tap the location field to share your live GPS location.
        </div>

        <input id="citizen-details"
          placeholder="What happened?"
          style="padding:10px; border-radius:6px; border:1px solid var(--border);
          background:var(--panel2); color:var(--text);">

      </div>

      <button class="sos-btn" id="sos-btn">
        <span class="icon" data-icon="triangle-exclamation"></span>
        Report an emergency
      </button>

      <div id="sos-error"
        style="color:var(--amber); font-size:12.5px; margin:-10px 0 14px; display:none;">
      </div>

      <div class="label-row">
        <span class="icon" data-icon="bell"></span>
        Alerts near you
      </div>

      <div class="dpanel" style="font-size:13.5px; line-height:1.6;">
        ${publicData.alert}
      </div>

      <div class="label-row">
        <span class="icon" data-icon="location-dot"></span>
        Public status
      </div>

      <div class="dpanel">
        <div class="pub-row">
          <span>Nearest ER</span>
          <span>${publicData.nearestER}</span>
        </div>

        <div class="pub-row">
          <span>Road closures</span>
          <span>${publicData.roadClosures}</span>
        </div>

        <div class="pub-row">
          <span>Ambulance ETA</span>
          <span>${publicData.ambulanceETA}</span>
        </div>

        <div class="pub-row">
          <span>Incident location</span>
          <span>${publicData.location || "—"}</span>
        </div>
      </div>

      <div class="citizen-foot">
        Not visible to citizens: hospital bed counts, dispatch logs,
        internal department communications, other citizens' reports.
      </div>

    </div>
  `;

  const sosBtn = document.getElementById("sos-btn");
  const locationInput = document.getElementById("citizen-location");
  const locationStatus = document.getElementById("citizen-location-status");
  const departmentInput = document.getElementById("citizen-department");
  const detailsInput = document.getElementById("citizen-details");
  const err = document.getElementById("sos-error");

  // A report is not allowed until a fresh GPS location has been confirmed.
  let gpsConfirmed = false;
  let gpsRequestInProgress = false;

  sosBtn.disabled = true;

  const showLocationMessage = (message, color = "var(--muted)") => {
    if (locationStatus) {
      locationStatus.textContent = message;
      locationStatus.style.color = color;
    }
  };

  const requestLiveLocation = () => {
    if (gpsRequestInProgress) return;

    if (!navigator.geolocation) {
      gpsConfirmed = false;
      sosBtn.disabled = true;
      showLocationMessage(
        "❌ This browser does not support GPS location.",
        "var(--red)"
      );
      return;
    }

    gpsRequestInProgress = true;
    gpsConfirmed = false;
    sosBtn.disabled = true;
    locationInput.value = "Detecting your live location…";
    showLocationMessage(
      "📡 Requesting GPS location permission…",
      "var(--amber)"
    );
    if (err) err.style.display = "none";

    navigator.geolocation.getCurrentPosition(
      position => {
        gpsRequestInProgress = false;

        const latitude = Number(position.coords.latitude);
        const longitude = Number(position.coords.longitude);
        const accuracy = Number(position.coords.accuracy);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          gpsConfirmed = false;
          sosBtn.disabled = true;
          locationInput.value = "";
          showLocationMessage(
            "❌ GPS returned an invalid location. Tap here to try again.",
            "var(--red)"
          );
          return;
        }

        // Store the exact coordinates on the input so the report uses the
        // location that was actually confirmed by the browser GPS.
        locationInput.dataset.latitude = String(latitude);
        locationInput.dataset.longitude = String(longitude);
        locationInput.dataset.accuracy = Number.isFinite(accuracy)
          ? String(accuracy)
          : "";
        locationInput.value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        gpsConfirmed = true;

        showLocationMessage(
          Number.isFinite(accuracy)
            ? `✓ Live location confirmed (GPS accuracy ~${Math.round(accuracy)} m)`
            : "✓ Live location confirmed",
          "var(--teal)"
        );

        // The Report button becomes available only after location confirmation.
        sosBtn.disabled = false;
      },
      error => {
        gpsRequestInProgress = false;
        gpsConfirmed = false;
        sosBtn.disabled = true;
        locationInput.value = "";
        delete locationInput.dataset.latitude;
        delete locationInput.dataset.longitude;
        delete locationInput.dataset.accuracy;

        let message = "Location permission is required before reporting an emergency.";

        if (error && error.code === 1) {
          message =
            "📍 Location permission was denied or blocked. Allow Location for this website in your browser settings, then tap this field again.";
        } else if (error && error.code === 2) {
          message =
            "📍 Your GPS location could not be determined. Turn on Location/GPS and tap this field again.";
        } else if (error && error.code === 3) {
          message =
            "📍 GPS took too long. Make sure Location is on and tap this field again.";
        }

        showLocationMessage(message, "var(--amber)");
        if (err) {
          err.textContent = message;
          err.style.display = "block";
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
      }
    );
  };

  // Tapping the location field is the ONLY action needed to start GPS.
  // No Google Maps window is opened here.
  locationInput?.addEventListener("click", requestLiveLocation);
  locationInput?.addEventListener("focus", requestLiveLocation);

  // If the citizen changes the emergency type after GPS was confirmed,
  // keep the confirmed GPS location and only require the emergency type.
  departmentInput?.addEventListener("change", () => {
    if (err) err.style.display = "none";
  });

  sosBtn.addEventListener("click", async () => {
    const department = departmentInput?.value;

    if (!department) {
      err.textContent = "Please select the type of emergency first.";
      err.style.display = "block";
      return;
    }

    // Never submit without a confirmed GPS location.
    const latitude = Number(locationInput?.dataset.latitude);
    const longitude = Number(locationInput?.dataset.longitude);

    if (
      !gpsConfirmed ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !locationInput?.value.trim()
    ) {
      err.textContent =
        "Please tap the location field and allow GPS location access. Your live location must be confirmed before the emergency can be reported.";
      err.style.display = "block";
      showLocationMessage(
        "📍 Live GPS location is required before reporting.",
        "var(--amber)"
      );
      requestLiveLocation();
      return;
    }

    err.style.display = "none";
    sosBtn.disabled = true;
    showLocationMessage("📤 Sending your confirmed GPS location…", "var(--amber)");

    const r = await apiPost(
      "/api/incidents/report",
      {
        departmentId: department,
        // This is the confirmed GPS coordinate string shown to the citizen.
        location: locationInput.value.trim(),
        details: detailsInput?.value.trim() || "",
        latitude,
        longitude,
        locationSource: "browser-gps",
        locationConfirmed: true
      }
    );

    if (r.status === 429) {
      err.textContent =
        (r.data && r.data.error) || "Please wait before reporting again.";
      err.style.display = "block";
      sosBtn.disabled = false;
      showLocationMessage("✓ Live location remains confirmed.", "var(--teal)");
      return;
    }

    if (r.status !== 200) {
      err.textContent =
        (r.data && r.data.error) || "Unable to send emergency report.";
      err.style.display = "block";
      sosBtn.disabled = false;
      showLocationMessage("✓ Live location remains confirmed.", "var(--teal)");
      return;
    }

    alert(
      "Emergency report sent to Command Centre with your confirmed GPS location."
    );

    render();
  });
}

// ---------- Top-level render dispatch ----------
async function render() {
  renderRail();
  if (state.role === "citizen") {
    await renderCitizen();
  } else if (isProtectedRole(state.role)) {
    const token = Auth.get(state.role);
    if (!token) { renderLogin(state.role); applyIcons(document); return; }
    if (state.role === "command") await renderCommand();
    else await renderDepartment(state.role);
  }
  applyIcons(document);
}

// ---------- Live sync across all open dashboards ----------
function connectStream() {
  try {
    const es = new EventSource("/api/stream");

    // Normal live refresh for every role.
    es.addEventListener("changed", () => render());

    // Special alert for the Command Centre when a citizen submits an SOS.
    es.addEventListener("citizen-emergency", async () => {
      if (state.role !== "command") return;
      await render();
      showCommandCitizenAlert();
    });

    es.onerror = () => { /* browser auto-reconnects; nothing to do */ };
  } catch {
    // EventSource unsupported — the dashboard still works, just without live push.
  }
}

// ---------- Bootstrap ----------
async function bootstrap() {
  const [deptRes, typeRes] = await Promise.all([
    apiGet("/api/departments"),
    apiGet("/api/emergency-types"),
  ]);
  state.departments = deptRes.data || [];
  state.emergencyTypes = typeRes.data || [];
  connectStream();
  render();
}

bootstrap();
