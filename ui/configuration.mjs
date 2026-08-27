const EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum"
};
const MODEL_CATALOG = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }
];
const CONTEXT_WINDOWS = [
  { tokens: 272_000, label: "272k" },
  { tokens: 472_000, label: "472k" },
  { tokens: 872_000, label: "872k" }
];
const TASK_LABELS = {
  summarization: "Summarization",
  subagent: "Subagents",
  browser: "Browser use",
  computer: "Computer use",
  automation: "Automations",
  group: "Group turns"
};
const CONNECTION_LABELS = {
  "cached-websocket": "Cached WebSocket",
  websocket: "WebSocket",
  sse: "Server-sent events"
};

const byId = (id) => document.getElementById(id);

function modelLabel(id) {
  return MODEL_CATALOG.find((model) => model.id === id)?.label || id;
}

function routeInputs(prefix, route, options = {}) {
  const model = document.createElement("label");
  model.textContent = "Model";
  const modelInput = document.createElement("select");
  modelInput.name = prefix + "-model";
  if (options.allowDefault) {
    const inherit = document.createElement("option");
    inherit.value = "";
    inherit.textContent = "Use default (" + modelLabel(options.defaultRoute.model) + ")";
    modelInput.append(inherit);
  }
  if (!MODEL_CATALOG.some((available) => available.id === route.model)) {
    const current = document.createElement("option");
    current.value = route.model;
    current.textContent = route.model;
    modelInput.append(current);
  }
  for (const available of MODEL_CATALOG) {
    const option = document.createElement("option");
    option.value = available.id;
    option.textContent = available.label;
    modelInput.append(option);
  }
  modelInput.value = options.inherited ? "" : route.model;
  model.append(modelInput);

  const thinking = document.createElement("label");
  thinking.textContent = "Thinking";
  const effortInput = document.createElement("select");
  effortInput.name = prefix + "-effort";
  effortInput.disabled = Boolean(options.inherited);
  for (const effort of EFFORTS) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = EFFORT_LABELS[effort];
    option.selected = effort === route.reasoningEffort;
    effortInput.append(option);
  }
  if (options.allowDefault) {
    modelInput.addEventListener("input", () => {
      effortInput.disabled = modelInput.value === "";
    });
  }
  thinking.append(effortInput);
  return { model, modelInput, thinking, effortInput };
}

function routeCells(prefix, route, options = {}) {
  const inputs = routeInputs(prefix, route, options);
  const modelCell = document.createElement("td");
  modelCell.append(inputs.modelInput);
  const effortCell = document.createElement("td");
  effortCell.append(inputs.effortInput);
  return { ...inputs, modelCell, effortCell };
}

function renderRoutes(state) {
  const defaultRoot = byId("default-route");
  const defaults = routeInputs("default", state.config.default);
  defaultRoot.replaceChildren(defaults.model, defaults.thinking);

  const agentsRoot = byId("agent-routes");
  agentsRoot.replaceChildren();
  for (const agent of state.agents) {
    const row = document.createElement("tr");
    row.dataset.agentId = agent.id;
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = agent.name;
    const cells = routeCells("agent-" + agent.id, agent.route || agent.effectiveRoute, {
      allowDefault: true,
      inherited: !agent.route,
      defaultRoute: state.config.default
    });
    row.append(name, cells.modelCell, cells.effortCell);
    agentsRoot.append(row);
  }

  const syncInheritedDefaults = () => {
    for (const row of agentsRoot.rows) {
      const id = row.dataset.agentId;
      const model = row.querySelector('[name="agent-' + id + '-model"]');
      const effort = row.querySelector('[name="agent-' + id + '-effort"]');
      model.options[0].textContent = "Use default (" + modelLabel(defaults.modelInput.value) + ")";
      if (model.value === "") effort.value = defaults.effortInput.value;
    }
  };
  defaults.modelInput.addEventListener("input", syncInheritedDefaults);
  defaults.effortInput.addEventListener("input", syncInheritedDefaults);
  for (const row of agentsRoot.rows) {
    const id = row.dataset.agentId;
    row.querySelector('[name="agent-' + id + '-model"]').addEventListener("input", syncInheritedDefaults);
  }

  const tasksRoot = byId("class-routes");
  tasksRoot.replaceChildren();
  for (const [name, route] of Object.entries(state.config.classes)) {
    const row = document.createElement("tr");
    row.dataset.className = name;
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = TASK_LABELS[name] || name;
    const cells = routeCells("class-" + name, route);
    row.append(heading, cells.modelCell, cells.effortCell);
    tasksRoot.append(row);
  }

  const settings = byId("transport-settings");
  settings.replaceChildren();
  const authLabel = document.createElement("label");
  authLabel.textContent = "Auth source";
  const auth = document.createElement("select");
  auth.name = "auth-store";
  for (const store of ["pi", "codex"]) {
    const option = document.createElement("option");
    option.value = store;
    option.textContent = store === "pi" ? "Pi" : "Codex";
    option.selected = state.config.authStore === store;
    auth.append(option);
  }
  authLabel.append(auth);

  const contextLabels = MODEL_CATALOG.map((model) => {
    const label = document.createElement("label");
    label.textContent = model.label + " context";
    const input = document.createElement("select");
    input.name = "context-window-" + model.id;
    input.disabled = state.config.contextWindows === undefined;
    const selected = state.config.contextWindows?.[model.id] ||
      state.config.contextWindowTokens ||
      272_000;
    for (const available of CONTEXT_WINDOWS) {
      const option = document.createElement("option");
      option.value = String(available.tokens);
      option.textContent = available.label;
      option.selected = selected === available.tokens;
      input.append(option);
    }
    label.append(input);
    return label;
  });

  const modeLabel = document.createElement("label");
  modeLabel.textContent = "Connection mode";
  const mode = document.createElement("select");
  mode.name = "transport-mode";
  for (const value of ["cached-websocket", "websocket", "sse"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = CONNECTION_LABELS[value];
    option.selected = state.config.transport.mode === value;
    mode.append(option);
  }
  modeLabel.append(mode);

  const retriesLabel = document.createElement("label");
  retriesLabel.textContent = "Retry limit";
  const retries = document.createElement("input");
  retries.name = "max-retries";
  retries.type = "number";
  retries.min = "0";
  retries.max = "20";
  retries.value = state.config.transport.maxRetries;
  retriesLabel.append(retries);
  settings.append(authLabel, modeLabel, retriesLabel, ...contextLabels);
}

function collectConfig(baseConfig) {
  const config = structuredClone(baseConfig);
  const form = byId("routing-form");
  config.default = {
    model: form.elements["default-model"].value,
    reasoningEffort: form.elements["default-effort"].value
  };
  config.agents = {};
  for (const row of byId("agent-routes").rows) {
    const id = row.dataset.agentId;
    const model = form.elements["agent-" + id + "-model"].value;
    if (!model) continue;
    config.agents[id] = {
      model,
      reasoningEffort: form.elements["agent-" + id + "-effort"].value
    };
  }
  for (const row of byId("class-routes").rows) {
    const name = row.dataset.className;
    config.classes[name] = {
      model: form.elements["class-" + name + "-model"].value,
      reasoningEffort: form.elements["class-" + name + "-effort"].value
    };
  }
  config.authStore = form.elements["auth-store"].value;
  const contextInputs = MODEL_CATALOG.map((model) => ({
    model: model.id,
    input: form.elements["context-window-" + model.id]
  }));
  if (contextInputs.every(({ input }) => !input.disabled)) {
    config.contextWindows = Object.fromEntries(
      contextInputs.map(({ model, input }) => [model, Number(input.value)])
    );
    delete config.contextWindowTokens;
  }
  config.transport = {
    mode: form.elements["transport-mode"].value,
    maxRetries: Number(form.elements["max-retries"].value)
  };
  return config;
}

export function createConfigurationUi() {
  let dirty = false;
  let renderedState = "";
  byId("routing-form").addEventListener("input", () => { dirty = true; });

  return {
    render(state) {
      const signature = JSON.stringify({ config: state.config, agents: state.agents });
      if (dirty || signature === renderedState) return;
      renderRoutes(state);
      renderedState = signature;
    },
    collect(baseConfig) {
      return collectConfig(baseConfig);
    },
    markSaved() {
      dirty = false;
    }
  };
}
