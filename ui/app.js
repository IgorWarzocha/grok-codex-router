const token = document.querySelector('meta[name="grok-codex-router-token"]').content;
const efforts = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
let currentState;
let formDirty = false;

const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function routeInputs(prefix, route, disabled = false) {
  const model = document.createElement("label");
  model.textContent = "Model";
  const modelInput = document.createElement("input");
  modelInput.name = prefix + "-model";
  modelInput.value = route.model;
  modelInput.setAttribute("list", "known-models");
  modelInput.disabled = disabled;
  model.append(modelInput);

  const reasoning = document.createElement("label");
  reasoning.textContent = "Reasoning";
  const select = document.createElement("select");
  select.name = prefix + "-effort";
  select.disabled = disabled;
  for (const effort of efforts) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    option.selected = effort === route.reasoningEffort;
    select.append(option);
  }
  reasoning.append(select);
  return { model, modelInput, reasoning, select };
}

function routeCells(prefix, route, disabled) {
  const inputs = routeInputs(prefix, route, disabled);
  const modelCell = document.createElement("td");
  modelCell.append(inputs.modelInput);
  const effortCell = document.createElement("td");
  effortCell.append(inputs.select);
  return { ...inputs, modelCell, effortCell };
}

function renderRoutes(state) {
  const models = new Set([state.config.default.model]);
  Object.values(state.config.classes).forEach((route) => models.add(route.model));
  Object.values(state.config.agents).forEach((route) => models.add(route.model));
  const datalist = byId("known-models");
  datalist.replaceChildren(...[...models].sort().map((model) => {
    const option = document.createElement("option");
    option.value = model;
    return option;
  }));

  const defaultRoot = byId("default-route");
  const defaults = routeInputs("default", state.config.default);
  defaultRoot.replaceChildren(defaults.model, defaults.reasoning);

  const agentsRoot = byId("agent-routes");
  agentsRoot.replaceChildren();
  for (const agent of state.agents) {
    const row = document.createElement("tr");
    row.dataset.agentId = agent.id;
    const name = document.createElement("th");
    name.scope = "row";
    const strong = document.createElement("strong");
    strong.textContent = agent.name;
    const identity = document.createElement("span");
    identity.textContent = agent.id;
    name.append(strong, identity);

    const overrideCell = document.createElement("td");
    const overrideLabel = document.createElement("label");
    overrideLabel.className = "check-label";
    const override = document.createElement("input");
    override.type = "checkbox";
    override.name = "agent-override";
    override.checked = Boolean(agent.route);
    const overrideText = document.createElement("span");
    overrideText.textContent = agent.route ? "Custom" : "Default";
    overrideLabel.append(override, overrideText);
    overrideCell.append(overrideLabel);

    const cells = routeCells("agent-" + agent.id, agent.route || agent.effectiveRoute, !agent.route);
    override.addEventListener("change", () => {
      cells.modelInput.disabled = !override.checked;
      cells.select.disabled = !override.checked;
      overrideText.textContent = override.checked ? "Custom" : "Default";
      formDirty = true;
    });
    row.append(name, overrideCell, cells.modelCell, cells.effortCell);
    agentsRoot.append(row);
  }

  const classesRoot = byId("class-routes");
  classesRoot.replaceChildren();
  for (const [name, route] of Object.entries(state.config.classes)) {
    const row = document.createElement("tr");
    row.dataset.className = name;
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = name;
    const cells = routeCells("class-" + name, route, false);
    row.append(heading, cells.modelCell, cells.effortCell);
    classesRoot.append(row);
  }

  const advanced = byId("transport-settings");
  advanced.replaceChildren();
  const authLabel = document.createElement("label");
  authLabel.textContent = "OAuth store";
  const auth = document.createElement("select");
  auth.name = "auth-store";
  for (const store of ["pi", "codex"]) {
    const option = document.createElement("option");
    option.value = store;
    option.textContent = store;
    option.selected = state.config.authStore === store;
    auth.append(option);
  }
  authLabel.append(auth);
  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Transport";
  const mode = document.createElement("select");
  mode.name = "transport-mode";
  for (const value of ["cached-websocket", "websocket", "sse"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = state.config.transport.mode === value;
    mode.append(option);
  }
  modeLabel.append(mode);
  const retriesLabel = document.createElement("label");
  retriesLabel.textContent = "Maximum retries";
  const retries = document.createElement("input");
  retries.name = "max-retries";
  retries.type = "number";
  retries.min = "0";
  retries.max = "20";
  retries.value = state.config.transport.maxRetries;
  retriesLabel.append(retries);
  const timeoutLabel = document.createElement("label");
  timeoutLabel.textContent = "Idle timeout, ms";
  const timeout = document.createElement("input");
  timeout.name = "idle-timeout";
  timeout.type = "number";
  timeout.min = "1000";
  timeout.value = state.config.transport.idleTimeoutMs;
  timeoutLabel.append(timeout);
  advanced.append(authLabel, modeLabel, retriesLabel, timeoutLabel);
  formDirty = false;
}

function statusText(event) {
  if (event.type === "turn") {
    return number.format(event.inputTokens || 0) + " fresh, " + number.format(event.cachedInputTokens || 0) + " cached, " + number.format(event.outputTokens || 0) + " out";
  }
  if (event.type === "request") return (event.sentInputItems || 0) + " of " + (event.fullInputItems || 0) + " input items";
  if (event.type === "failure") return [event.code, event.status && "HTTP " + event.status, event.param].filter(Boolean).join(" · ");
  if (event.type === "route") return event.reasoningEffort || "";
  return "";
}

function renderState(state) {
  currentState = state;
  byId("service-clock").textContent = "Bun service · " + formatDuration(state.service.uptimeSeconds * 1000);
  byId("host-status").textContent = state.host.hostVersion;
  byId("router-status").textContent = state.host.phase;
  byId("router-status").dataset.state = state.host.phase;
  byId("auth-status").textContent = state.auth.ok ? state.auth.store + " · " + number.format(state.auth.validForMinutes) + "m" : "Attention";
  byId("auth-status").dataset.state = state.auth.ok ? "healthy" : "error";
  byId("host-message").textContent = state.host.message;

  const summary = state.telemetry.summary;
  const cacheBase = summary.inputTokens + summary.cachedInputTokens + summary.cacheWriteInputTokens;
  byId("metric-turns").textContent = number.format(summary.turns);
  byId("metric-input").textContent = number.format(summary.inputTokens);
  byId("metric-cached").textContent = number.format(summary.cachedInputTokens);
  byId("metric-output").textContent = number.format(summary.outputTokens);
  byId("metric-cache-rate").textContent = cacheBase ? Math.round(summary.cachedInputTokens / cacheBase * 100) + "%" : "0%";
  byId("metric-duration").textContent = formatDuration(summary.durationMs);

  const usageRoot = byId("usage-by-agent");
  usageRoot.replaceChildren();
  for (const entry of state.telemetry.byAgent) {
    const row = document.createElement("tr");
    for (const value of [entry.agentName, entry.model, entry.turns, entry.inputTokens, entry.cachedInputTokens, entry.outputTokens]) {
      const cell = document.createElement("td");
      cell.textContent = typeof value === "number" ? number.format(value) : value;
      row.append(cell);
    }
    usageRoot.append(row);
  }
  if (!state.telemetry.byAgent.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "Usage will appear after the next routed turn.";
    row.append(cell);
    usageRoot.append(row);
  }

  const activity = byId("activity-log");
  activity.replaceChildren();
  for (const event of state.telemetry.recent) {
    const row = document.createElement("tr");
    const values = [
      event.ts ? new Date(event.ts).toLocaleTimeString() : "",
      event.type || "",
      [event.agentId, event.workload, event.model].filter(Boolean).join(" · "),
      [event.transport, event.socketReused ? "reused WS" : "", event.continuation].filter(Boolean).join(" · "),
      statusText(event)
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    activity.append(row);
  }

  if (!formDirty) renderRoutes(state);
  byId("issue-link").href = state.issueUrl;
  if (state.manualAction) byId("action-status").textContent = state.manualAction.message;
}

function formatDuration(ms) {
  if (!ms) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  return minutes + "m " + (seconds % 60) + "s";
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("x-grok-codex-router-token", token);
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed with HTTP " + response.status);
  }
  return response;
}

async function refresh() {
  try {
    const response = await request("/api/state");
    renderState(await response.json());
  } catch (error) {
    byId("host-message").textContent = error.message;
  }
}

function collectConfig() {
  const config = structuredClone(currentState.config);
  const form = byId("routing-form");
  config.default = {
    model: form.elements["default-model"].value.trim(),
    reasoningEffort: form.elements["default-effort"].value
  };
  config.agents = {};
  for (const row of byId("agent-routes").rows) {
    const id = row.dataset.agentId;
    if (!row.querySelector('[name="agent-override"]').checked) continue;
    config.agents[id] = {
      model: form.elements["agent-" + id + "-model"].value.trim(),
      reasoningEffort: form.elements["agent-" + id + "-effort"].value
    };
  }
  for (const row of byId("class-routes").rows) {
    const name = row.dataset.className;
    config.classes[name] = {
      model: form.elements["class-" + name + "-model"].value.trim(),
      reasoningEffort: form.elements["class-" + name + "-effort"].value
    };
  }
  config.authStore = form.elements["auth-store"].value;
  config.transport = {
    mode: form.elements["transport-mode"].value,
    maxRetries: Number(form.elements["max-retries"].value),
    idleTimeoutMs: Number(form.elements["idle-timeout"].value)
  };
  return config;
}

byId("routing-form").addEventListener("input", () => { formDirty = true; });
byId("save-routes").addEventListener("click", async () => {
  const status = byId("save-status");
  status.textContent = "Saving settings.";
  try {
    await request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-grok-codex-router-token": token },
      body: JSON.stringify(collectConfig())
    });
    formDirty = false;
    status.textContent = "Settings saved. New requests use the updated routes.";
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
});

byId("refresh").addEventListener("click", refresh);
byId("recover").addEventListener("click", async () => {
  byId("action-status").textContent = "Starting compatibility recovery.";
  await request("/api/recover", { method: "POST", headers: { "x-grok-codex-router-token": token } }).catch((error) => {
    byId("action-status").textContent = error.message;
  });
});
byId("restart").addEventListener("click", async () => {
  if (!confirm("Restart the Sand host when active turns are idle?")) return;
  byId("action-status").textContent = "Waiting for an idle Sand host restart.";
  await request("/api/restart", { method: "POST", headers: { "x-grok-codex-router-token": token } }).catch((error) => {
    byId("action-status").textContent = error.message;
  });
});
byId("copy-report").addEventListener("click", async () => {
  try {
    const response = await request("/api/issue-report");
    await navigator.clipboard.writeText(await response.text());
    byId("action-status").textContent = "Compatibility report copied.";
  } catch (error) {
    byId("action-status").textContent = error.message;
  }
});

refresh();
setInterval(refresh, 5000);
