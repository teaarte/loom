// The localhost dashboard — a single static HTML page with inline vanilla JS,
// served verbatim at `GET /`. It is a thin CLIENT of the same API every other
// intake adapter uses: it lists projects, submits a task, answers a parked
// gate, and tails a project's log over SSE. No build step, no framework, no
// runtime dependency — the page is a string the `node:http` server writes.
//
// The bearer token (if the server requires one) is kept in localStorage and
// sent as `Authorization: Bearer …` on every API call. This is a localhost
// operator console, not a multi-tenant UI.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>loom control plane</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1.5rem; max-width: 60rem; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin: 1.4rem 0 .4rem; }
  fieldset { border: 1px solid #8884; border-radius: 6px; margin: 0 0 1rem; }
  label { display: inline-block; min-width: 6rem; }
  input, select, textarea, button { font: inherit; padding: .25rem .4rem; margin: .15rem 0; }
  input[type=text], textarea { width: 28rem; max-width: 100%; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8883; vertical-align: top; }
  .parked { color: #c70; font-weight: bold; }
  .stalled { color: #c00; font-weight: bold; }
  .ok { color: #2a2; }
  pre#log { background: #8881; padding: .6rem; border-radius: 6px; height: 14rem; overflow: auto; white-space: pre-wrap; }
  .row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: baseline; }
  small { opacity: .7; }
</style>
</head>
<body>
<h1>loom control plane</h1>

<fieldset>
  <legend>connection</legend>
  <label for="token">token</label>
  <input id="token" type="password" placeholder="(none — localhost trust)" />
  <button onclick="saveToken()">save</button>
  <span id="conn"></span>
</fieldset>

<fieldset>
  <legend>register a project</legend>
  <label for="regdir">dir</label>
  <input id="regdir" type="text" placeholder="/abs/path/to/project" />
  <button onclick="register()">register</button>
</fieldset>

<fieldset>
  <legend>submit a task</legend>
  <div class="row">
    <span><label for="subproj">project</label><select id="subproj"></select></span>
    <span><label for="subpolicy">policy</label>
      <select id="subpolicy">
        <option value="">(bundle default)</option>
        <option value="full-autonomous">full-autonomous (all gates auto)</option>
        <option value="gates-on-blockers">gates-on-blockers</option>
        <option value="review-plan-only">review-plan-only (plan gate human)</option>
        <option value="review-final-only">review-final-only (final gate human)</option>
        <option value="full-supervised">full-supervised (all gates human)</option>
      </select>
    </span>
  </div>
  <div><label for="subtask">task</label><textarea id="subtask" rows="2" placeholder="add a health check route"></textarea></div>
  <button onclick="submitTask()">submit</button>
  <span id="submsg"></span>
</fieldset>

<h2>projects <button onclick="refresh()">refresh</button></h2>
<table id="projects"><thead><tr>
  <th>id</th><th>dir</th><th>status</th><th>flow @ step</th><th>phase</th><th>gate / pending</th><th></th>
</tr></thead><tbody></tbody></table>

<h2 id="logh" style="display:none">log — <span id="logfor"></span> <button onclick="stopLog()">stop</button></h2>
<pre id="log" style="display:none"></pre>

<script>
let TOKEN = localStorage.getItem("loom_token") || "";
let SSE = null;
document.getElementById("token").value = TOKEN;

function headers() {
  const h = { "content-type": "application/json" };
  if (TOKEN) h["authorization"] = "Bearer " + TOKEN;
  return h;
}
function saveToken() {
  TOKEN = document.getElementById("token").value.trim();
  localStorage.setItem("loom_token", TOKEN);
  refresh();
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error((data && data.error && data.error.code) ? data.error.code + ": " + data.error.message : ("HTTP " + res.status));
  return data;
}
async function register() {
  const dir = document.getElementById("regdir").value.trim();
  if (!dir) return;
  try { await api("POST", "/projects", { dir }); document.getElementById("regdir").value = ""; refresh(); }
  catch (e) { alert(e.message); }
}
async function submitTask() {
  const project = document.getElementById("subproj").value;
  const task = document.getElementById("subtask").value.trim();
  const policy = document.getElementById("subpolicy").value;
  const msg = document.getElementById("submsg");
  if (!project || !task) { msg.textContent = "pick a project and enter a task"; return; }
  try {
    const r = await api("POST", "/submit", { project, task, ...(policy ? { policy_preset: policy } : {}) });
    msg.textContent = (r.replayed ? "already running" : "submitted") + " — " + (r.task_id || "?") + " [" + r.status + "]";
    document.getElementById("subtask").value = "";
    refresh();
  } catch (e) { msg.textContent = e.message; }
}
async function answer(id, gateEventId) {
  const decision = prompt("decision for gate '" + gateEventId + "' — accept | reject | auto-apply", "accept");
  if (!decision) return;
  let body = { gate_event_id: gateEventId, decision };
  if (decision === "reject") { const ri = prompt("reject intent — revise | abandon", "revise"); if (ri) body.reject_intent = ri; }
  const m = prompt("optional message", ""); if (m) body.message = m;
  try { await api("POST", "/projects/" + id + "/answer", body); refresh(); }
  catch (e) { alert(e.message); }
}
async function refresh() {
  const conn = document.getElementById("conn");
  let projects;
  try { projects = await api("GET", "/projects"); conn.textContent = ""; conn.className = "ok"; }
  catch (e) { conn.textContent = " — " + e.message; conn.className = "stalled"; return; }
  const sel = document.getElementById("subproj");
  const cur = sel.value;
  sel.innerHTML = "";
  for (const p of projects) {
    const o = document.createElement("option"); o.value = p.id; o.textContent = p.dir; sel.appendChild(o);
  }
  if (cur) sel.value = cur;
  const tb = document.querySelector("#projects tbody");
  tb.innerHTML = "";
  for (const p of projects) {
    const s = p.status || {};
    const tr = document.createElement("tr");
    let gate = "";
    if (s.parked_gate) gate = '<span class="parked">parked: ' + s.parked_gate.gate + '</span> <button onclick="answer(\\'' + p.id + '\\',\\'' + s.parked_gate.gate_event_id + '\\')">answer</button>';
    else if (s.pending_agents && s.pending_agents.length) gate = (s.stalled ? '<span class="stalled">' : '<span>') + s.pending_agents.length + ' pending' + (s.stalled ? ' (stalled)' : '') + '</span>';
    tr.innerHTML =
      "<td>" + p.id + "</td>" +
      "<td><small>" + p.dir + "</small></td>" +
      "<td>" + (s.has_task ? (s.status || "?") + (s.verdict ? " (" + s.verdict + ")" : "") : "<small>idle</small>") + "</td>" +
      "<td>" + (s.flow ? s.flow.name + " @ " + s.flow.step_index : "") + "</td>" +
      "<td>" + (s.active_phase || "") + "</td>" +
      "<td>" + gate + "</td>" +
      '<td><button onclick="tailLog(\\'' + p.id + '\\',\\'' + p.dir + '\\')">log</button></td>';
    tb.appendChild(tr);
  }
}
function tailLog(id, dir) {
  stopLog();
  document.getElementById("logh").style.display = "";
  document.getElementById("log").style.display = "";
  document.getElementById("logfor").textContent = dir;
  const pre = document.getElementById("log");
  pre.textContent = "";
  const url = "/projects/" + id + "/log" + (TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "");
  SSE = new EventSource(url);
  SSE.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data);
      const lines = (d.log || []).map((l) => (l.ts || "") + " [" + (l.level || "?") + "] " + (l.event || "") + (l.detail ? " " + JSON.stringify(l.detail) : "")).join("\\n");
      pre.textContent = lines;
      pre.scrollTop = pre.scrollHeight;
    } catch {}
  };
  SSE.onerror = () => { pre.textContent += "\\n[stream closed]"; stopLog(); };
}
function stopLog() { if (SSE) { SSE.close(); SSE = null; } }
refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;
