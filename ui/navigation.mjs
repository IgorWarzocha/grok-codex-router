const SAVE_CONTEXTS = {
  agents: { label: "Save agent models", status: "agent-save-status" },
  tasks: { label: "Save task models", status: "task-save-status" },
  settings: { label: "Save settings", status: "settings-save-status" }
};

const byId = (id) => document.getElementById(id);

export function initializeNavigation() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const save = byId("save-config");

  const activate = (name, options = {}) => {
    const target = tabs.find((button) => button.dataset.panel === name) || tabs[0];
    for (const button of tabs) {
      const selected = button === target;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      byId(button.getAttribute("aria-controls")).hidden = !selected;
    }
    if (options.record && location.hash !== "#" + target.dataset.panel) {
      history.pushState(null, "", "#" + target.dataset.panel);
    }
    const saveContext = SAVE_CONTEXTS[target.dataset.panel];
    save.hidden = !saveContext;
    if (saveContext) {
      save.textContent = saveContext.label;
      save.dataset.status = saveContext.status;
    }
    if (options.focus) target.focus();
  };

  for (const button of tabs) {
    button.addEventListener("click", () => activate(button.dataset.panel, { record: true }));
    button.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(button);
      let next;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activate(tabs[next].dataset.panel, { record: true, focus: true });
    });
  }

  window.addEventListener("popstate", () => activate(location.hash.slice(1)));
  activate(location.hash.slice(1));
}
