/**
 * Workspace lifecycle: add, switch, remove.
 * Dropdown rendering and empty state management.
 */

import { splitFilepath } from "./tile-renderer.js";

export function createWorkspaceManager({
	panelNav, workspaceMenuItems, workspaceTriggerParent,
	workspaceTriggerName, configs, createWebview,
	handleDndMessage, onNoteSurfaceFocus, onSwitch,
	onApplyNavVisibility,
}) {
	const workspaces = [];
	let activeIndex = -1;
	let emptyStateEl = null;
	let dropdownOpen = false;

	function showEmptyState() {
		if (emptyStateEl) return;
		emptyStateEl = document.createElement("div");
		emptyStateEl.id = "empty-state";
		emptyStateEl.textContent = "No workspace open";
		panelNav.appendChild(emptyStateEl);
	}

	function hideEmptyState() {
		if (emptyStateEl) {
			emptyStateEl.remove();
			emptyStateEl = null;
		}
	}

	function openDropdown() {
		dropdownOpen = true;
		const menu =
			document.getElementById("workspace-menu");
		menu.classList.remove("hidden");
		panelNav.classList.add("dropdown-open");
	}

	function closeDropdown() {
		dropdownOpen = false;
		const menu =
			document.getElementById("workspace-menu");
		menu.classList.add("hidden");
		panelNav.classList.remove("dropdown-open");
	}

	function renderDropdown() {
		workspaceMenuItems.innerHTML = "";

		for (let i = 0; i < workspaces.length; i++) {
			const ws = workspaces[i];
			const parts = ws.path.split(/[\\/]/);
			const name = parts.pop() || ws.path;
			const parent = parts.length > 1
				? parts.slice(-2).join("/") + "/"
				: "";

			const item = document.createElement("button");
			item.type = "button";
			item.className =
				"dropdown-item" +
				(i === activeIndex ? " active" : "");
			item.title = ws.path;

			const labelSpan = document.createElement("span");
			labelSpan.className = "dropdown-item-label";

			const parentSpan = document.createElement("span");
			parentSpan.className = "dropdown-item-parent";
			parentSpan.textContent = parent;
			labelSpan.appendChild(parentSpan);

			const nameSpan = document.createElement("span");
			nameSpan.className = "dropdown-item-name";
			nameSpan.textContent = name;
			labelSpan.appendChild(nameSpan);

			item.appendChild(labelSpan);

			const removeBtn = document.createElement("button");
			removeBtn.type = "button";
			removeBtn.className = "ws-remove";
			removeBtn.innerHTML = "&times;";
			removeBtn.title = "Remove workspace";
			removeBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				closeDropdown();
				removeWorkspace(i);
			});
			item.appendChild(removeBtn);

			item.addEventListener("click", () => {
				closeDropdown();
				switchWorkspace(i);
			});

			workspaceMenuItems.appendChild(item);
		}

		if (activeIndex >= 0 && workspaces[activeIndex]) {
			const { parent, name } =
				splitFilepath(workspaces[activeIndex].path);
			workspaceTriggerParent.textContent = parent;
			workspaceTriggerName.textContent = name;
		} else {
			workspaceTriggerParent.textContent = "";
			workspaceTriggerName.textContent = "No workspace";
		}
	}

	function addWorkspace(path) {
		const navContainer = document.createElement("div");
		navContainer.className = "nav-container";
		navContainer.style.display = "none";
		panelNav.appendChild(navContainer);

		const navHandle = createWebview(
			"nav", configs.nav, navContainer, handleDndMessage,
		);
		navHandle.webview.addEventListener("focus", () => {
			onNoteSurfaceFocus("nav");
		});

		const wsData = { path, nav: navHandle, navContainer };
		workspaces.push(wsData);

		navHandle.send("workspace-changed", path);

		hideEmptyState();
		renderDropdown();
		return wsData;
	}

	function switchWorkspace(index) {
		if (
			index === activeIndex ||
			index < 0 ||
			index >= workspaces.length
		) {
			return;
		}

		if (activeIndex >= 0 && workspaces[activeIndex]) {
			workspaces[activeIndex]
				.navContainer.style.display = "none";
		}

		activeIndex = index;
		workspaces[activeIndex]
			.navContainer.style.display = "";

		const wsPath = workspaces[activeIndex].path;
		workspaces[activeIndex].nav.send(
			"workspace-changed", wsPath,
		);

		onApplyNavVisibility();
		renderDropdown();
		onSwitch(index);
	}

	async function removeWorkspace(index) {
		if (index < 0 || index >= workspaces.length) return;

		let result;
		try {
			result =
				await window.shellApi.workspaceRemove(index);
		} catch (err) {
			console.error(
				"[shell] Failed to remove workspace:", err,
			);
			return;
		}

		const ws = workspaces[index];
		ws.nav.webview.remove();
		ws.navContainer.remove();
		workspaces.splice(index, 1);

		activeIndex = -1;

		if (workspaces.length === 0) {
			showEmptyState();
		} else if (
			result.active >= 0 &&
			result.active < workspaces.length
		) {
			switchWorkspace(result.active);
		}

		renderDropdown();
	}

	function getAllNavWebviews() {
		return workspaces.map((ws) => ws.nav);
	}

	return {
		addWorkspace,
		switchWorkspace,
		removeWorkspace,
		getActiveWorkspace() {
			return workspaces[activeIndex] || null;
		},
		getActiveIndex() { return activeIndex; },
		getWorkspaces() { return workspaces; },
		renderDropdown,
		getAllNavWebviews,
		showEmptyState,
		hideEmptyState,
		openDropdown,
		closeDropdown,
		isDropdownOpen() { return dropdownOpen; },
	};
}
