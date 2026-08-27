const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exactNumber = new Intl.NumberFormat("en");

function phaseLabel(phase) {
  if (phase === "healthy") return "Healthy";
  if (phase === "patching") return "Updating";
  if (phase === "restarting") return "Restarting";
  if (phase === "incompatible") return "Needs attention";
  if (phase === "error") return "Unavailable";
  return "Checking";
}

function formatLatency(ms) {
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
}

function thinkingLabel(effort) {
  if (effort === "off" || effort === "none") return "thinking off";
  if (effort === "xhigh") return "extra-high thinking";
  if (effort === "max") return "maximum thinking";
  return effort + " thinking";
}

function renderOverview(state) {
  byId("host-status").textContent = state.host.hostVersion ? "Connected" : "Checking";
  byId("host-status").dataset.state = state.host.hostVersion ? "healthy" : "checking";
  byId("router-status").textContent = phaseLabel(state.host.phase);
  byId("router-status").dataset.state = state.host.phase;
  byId("auth-status").textContent = state.auth.ok ? "Connected" : "Needs attention";
  byId("auth-status").dataset.state = state.auth.ok ? "healthy" : "error";

  const summary = state.telemetry.summary;
  const cacheBase = summary.inputTokens + summary.cachedInputTokens + summary.cacheWriteInputTokens;
  byId("metric-turns").textContent = number.format(summary.turns);
  byId("metric-processed").textContent = number.format(cacheBase + summary.outputTokens);
  byId("metric-input").textContent = number.format(summary.inputTokens);
  byId("metric-cached").textContent = number.format(summary.cachedInputTokens);
  byId("metric-output").textContent = number.format(summary.outputTokens);
  byId("metric-cache-rate").textContent = cacheBase ? Math.round(summary.cachedInputTokens / cacheBase * 100) + "%" : "0%";
  byId("issue-link").href = state.issueUrl;
  if (state.manualAction) byId("action-status").textContent = state.manualAction.message;
}

function aggregateAgentUsage(state) {
  const agents = new Map(state.agents
    .filter((profile) => profile.available)
    .map((profile) => [profile.id, {
      name: profile.name,
      profile,
      turns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      durationMs: 0
    }]));
  for (const entry of state.telemetry.byAgent) {
    const agent = agents.get(entry.agentId);
    if (!agent) continue;
    for (const field of ["turns", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "durationMs"]) {
      agent[field] += Number(entry[field] || 0);
    }
  }
  return [...agents.values()].sort((left, right) => {
    const leftTokens = left.inputTokens + left.cachedInputTokens + left.cacheWriteInputTokens + left.outputTokens;
    const rightTokens = right.inputTokens + right.cachedInputTokens + right.cacheWriteInputTokens + right.outputTokens;
    return rightTokens - leftTokens || left.name.localeCompare(right.name);
  });
}

function diagnosticMetric(label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = number.format(value);
  detail.title = exactNumber.format(value);
  detail.setAttribute("aria-label", exactNumber.format(value));
  wrapper.append(term, detail);
  return wrapper;
}

function renderAgentStats(state) {
  const root = byId("agent-diagnostics");
  root.replaceChildren();
  for (const agent of aggregateAgentUsage(state)) {
    const card = document.createElement("article");
    card.className = "agent-card";
    const header = document.createElement("header");
    const heading = document.createElement("h3");
    heading.textContent = agent.name;
    const model = document.createElement("p");
    model.className = "agent-model";
    model.textContent = agent.profile.effectiveRoute.model + " · " + thinkingLabel(agent.profile.effectiveRoute.reasoningEffort);
    header.append(heading, model);

    if (!agent.turns) {
      const empty = document.createElement("p");
      empty.className = "agent-empty";
      empty.textContent = "No usage yet";
      card.append(header, empty);
      root.append(card);
      continue;
    }
    const cacheBase = agent.inputTokens + agent.cachedInputTokens + agent.cacheWriteInputTokens;
    const metrics = document.createElement("dl");
    metrics.className = "agent-metrics";
    metrics.append(
      diagnosticMetric("Total tokens", cacheBase + agent.outputTokens),
      diagnosticMetric("New input", agent.inputTokens),
      diagnosticMetric("Cached", agent.cachedInputTokens),
      diagnosticMetric("Output", agent.outputTokens)
    );
    const foot = document.createElement("p");
    foot.className = "agent-foot";
    const details = [
      cacheBase ? Math.round(agent.cachedInputTokens / cacheBase * 100) + "% cached" : "0% cached",
      agent.turns + (agent.turns === 1 ? " turn" : " turns")
    ];
    if (agent.durationMs) details.splice(1, 0, formatLatency(agent.durationMs / agent.turns) + " average");
    for (const value of details) {
      const item = document.createElement("span");
      item.textContent = value;
      foot.append(item);
    }
    card.append(header, metrics, foot);
    root.append(card);
  }
}

function activityDetail(event) {
  if (event.type === "turn") {
    return number.format(event.inputTokens || 0) + " fresh, " + number.format(event.cachedInputTokens || 0) + " cached, " + number.format(event.outputTokens || 0) + " out";
  }
  if (event.type === "request") return (event.sentInputItems || 0) + " of " + (event.fullInputItems || 0) + " input items";
  if (event.type === "failure") return [event.code, event.status && "HTTP " + event.status, event.param].filter(Boolean).join(" · ");
  if (event.type === "route") return event.reasoningEffort || "";
  return "";
}

function renderActivity(state) {
  const activity = byId("activity-log");
  activity.replaceChildren();
  const agentNames = new Map(state.agents.map((agent) => [agent.id, agent.name]));
  for (const entry of state.telemetry.byAgent) agentNames.set(entry.agentId, entry.agentName);
  for (const event of state.telemetry.recent) {
    const row = document.createElement("tr");
    const values = [
      event.ts ? new Date(event.ts).toLocaleTimeString() : "",
      event.type || "",
      [agentNames.get(event.agentId) || event.agentId, event.workload, event.model].filter(Boolean).join(" · "),
      [event.transport, event.socketReused ? "reused WS" : "", event.continuation].filter(Boolean).join(" · "),
      activityDetail(event)
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    activity.append(row);
  }
  if (!state.telemetry.recent.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "Activity will appear after the next routed turn.";
    row.append(cell);
    activity.append(row);
  }
}

export function renderMonitoring(state) {
  renderOverview(state);
  renderAgentStats(state);
  renderActivity(state);
}

export function renderMonitoringUnavailable() {
  for (const id of ["host-status", "router-status", "auth-status"]) {
    byId(id).textContent = "Unavailable";
    byId(id).dataset.state = "error";
  }
}
