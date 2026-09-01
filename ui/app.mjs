import { createConfigurationUi } from "./configuration.mjs";
import { renderMonitoring, renderMonitoringUnavailable } from "./monitoring.mjs";
import { initializeNavigation } from "./navigation.mjs";

const byId = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="grok-codex-router-token"]').content;
const configuration = createConfigurationUi();
let currentState;

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
    currentState = await response.json();
    renderMonitoring(currentState);
    configuration.render(currentState);
  } catch {
    renderMonitoringUnavailable();
  }
}

initializeNavigation();

byId("save-config").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = byId(button.dataset.status);
  status.textContent = "Saving.";
  try {
    await request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration.collect(currentState.config))
    });
    configuration.markSaved();
    status.textContent = "Saved.";
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  }
});

byId("refresh").addEventListener("click", refresh);
byId("router-toggle").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const enabled = currentState?.config.enabled !== false;
  button.disabled = true;
  byId("action-status").textContent = enabled ? "Switching to native inference." : "Switching to Codex inference.";
  try {
    await request("/api/router", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !enabled })
    });
    await refresh();
    byId("action-status").textContent = enabled
      ? "Native inference will handle new turns."
      : "Codex inference will handle new turns.";
  } catch (error) {
    byId("action-status").textContent = error.message;
  } finally {
    button.disabled = currentState?.manualAction?.state === "running";
  }
});
byId("recover").addEventListener("click", async () => {
  byId("action-status").textContent = "Starting compatibility recovery.";
  await request("/api/recover", { method: "POST" }).catch((error) => {
    byId("action-status").textContent = error.message;
  });
});
byId("restart").addEventListener("click", async () => {
  if (!confirm("Restart the Sand host when active turns are idle?")) return;
  byId("action-status").textContent = "Waiting for an idle Sand host restart.";
  await request("/api/restart", { method: "POST" }).catch((error) => {
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

await refresh();
setInterval(refresh, 5000);
