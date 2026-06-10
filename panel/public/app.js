let ws = null;
let statsInterval = null;
let serverStatusInterval = null;
let acStatusInterval = null;
let currentMode = "minecraft";
let pendingSwitchTarget = null;
let allCars = [];
let allTracks = [];
let allCarsMods = [];
let allTracksMods = [];
let panelCarsSelection = [];
let acConfigLoaded = false;

async function login() {
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const data = await res.json();
  if (data.success) {
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("main-panel").style.display = "flex";
    initPanel();
  } else {
    document.getElementById("login-error").textContent = data.error;
  }
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
}

function showTab(name, btn) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  if (btn) btn.classList.add("active");
  if (name === "fabric") { subscribeToLogs("fabric"); loadMCConfig("fabric"); loadWhitelist("fabric"); loadOps("fabric"); }
  if (name === "paper") { subscribeToLogs("paper"); loadMCConfig("paper"); loadWhitelist("paper"); loadOps("paper"); }
  if (name === "assetto") { subscribeToLogs("assetto"); loadACConfigFields(); }
  if (name === "ac-browser") { loadCarsBrowser(); loadTracksBrowser(); }
}

function showInnerTab(server, tab, btn) {
  const prefix = server === "ac" ? "ac" : server;
  const parentTab = server === "ac" ? "assetto" : server;
  document.querySelectorAll("#tab-" + parentTab + " .inner-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll("#tab-" + parentTab + " .tab-inner-btn").forEach(b => b.classList.remove("active"));
  const el = document.getElementById(prefix + "-inner-" + tab);
  if (el) el.classList.add("active");
  if (btn) btn.classList.add("active");
  if (tab === "mods") loadModsLists();
}

function showBrowserTab(name, btn) {
  document.querySelectorAll("#tab-ac-browser .inner-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll("#tab-ac-browser .tab-inner-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("browser-inner-" + name).classList.add("active");
  if (btn) btn.classList.add("active");
}

function initPanel() {
  connectWebSocket();
  loadStats();
  loadServerStatus();
  loadACStatus();
  statsInterval = setInterval(loadStats, 2000);
  serverStatusInterval = setInterval(loadServerStatus, 3000);
  acStatusInterval = setInterval(loadACStatus, 3000);
}

function connectWebSocket() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "log") {
      const server = ws.currentServer;
      if (!server) return;
      const terminal = document.getElementById(server + "-logs");
      if (!terminal) return;
      const pauseId = server === "assetto" ? "assetto-pause" : server + "-pause";
      const paused = document.getElementById(pauseId) && document.getElementById(pauseId).checked;
      terminal.textContent += data.data;
      if (!paused) terminal.scrollTop = terminal.scrollHeight;
    }
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

function subscribeToLogs(server) {
  if (ws && ws.readyState === 1) {
    ws.currentServer = server;
    ws.send(JSON.stringify({ type: "subscribe-logs", server }));
    const terminal = document.getElementById(server + "-logs");
    if (terminal) terminal.textContent = "";
  }
}

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) return;
    const data = await res.json();
    const ramPct = Math.round((data.memory.used / data.memory.total) * 100);
    document.getElementById("ram-bar").style.width = ramPct + "%";
    document.getElementById("ram-text").textContent = formatBytes(data.memory.used) + " / " + formatBytes(data.memory.total) + " (" + ramPct + "%)";
    document.getElementById("cpu-bar").style.width = data.cpu + "%";
    document.getElementById("cpu-text").textContent = data.cpu + "%";
    document.getElementById("temp-text").textContent = data.temperature ? data.temperature.toFixed(1) + "°C" : "N/A";
    const diskPct = Math.round((data.disk.used / data.disk.total) * 100);
    document.getElementById("disk-bar").style.width = diskPct + "%";
    document.getElementById("disk-text").textContent = formatBytes(data.disk.used) + " / " + formatBytes(data.disk.total) + " (" + diskPct + "%)";
    document.getElementById("uptime-text").textContent = formatUptime(data.uptime);
    document.getElementById("power-text").textContent = data.power.watts + "W — " + data.power.monthlyCost + "€/mois";
    const ramPct2 = Math.round((data.memory.used / data.memory.total) * 100);
    updateSparklines(ramPct2, data.cpu);
    checkServerEvents(data);
    checkAlerts(data.cpu, ramPct2);
    const fp = data.servers.fabric.players;
    const fabricPlayersEl = document.getElementById("fabric-players");
    if (fp === null) { fabricPlayersEl.textContent = "Hors ligne"; fabricPlayersEl.style.color = "#f87171"; }
    else { fabricPlayersEl.textContent = fp.online + " / " + fp.max; fabricPlayersEl.style.color = fp.online > 0 ? "#4ade80" : "#eee"; }
    if (data.servers.fabric.ram !== null) {
      const pct = Math.round((data.servers.fabric.ram / data.memory.total) * 100);
      document.getElementById("fabric-ram-bar").style.width = pct + "%";
      document.getElementById("fabric-ram-text").textContent = formatBytes(data.servers.fabric.ram) + " (" + pct + "%)";
    } else { document.getElementById("fabric-ram-bar").style.width = "0%"; document.getElementById("fabric-ram-text").textContent = "Eteint"; }
    const pp = data.servers.paper.players;
    const paperPlayersEl = document.getElementById("paper-players");
    if (pp === null) { paperPlayersEl.textContent = "Hors ligne"; paperPlayersEl.style.color = "#f87171"; }
    else { paperPlayersEl.textContent = pp.online + " / " + pp.max; paperPlayersEl.style.color = pp.online > 0 ? "#4ade80" : "#eee"; }
    if (data.servers.paper.ram !== null) {
      const pct = Math.round((data.servers.paper.ram / data.memory.total) * 100);
      document.getElementById("paper-ram-bar").style.width = pct + "%";
      document.getElementById("paper-ram-text").textContent = formatBytes(data.servers.paper.ram) + " (" + pct + "%)";
    } else { document.getElementById("paper-ram-bar").style.width = "0%"; document.getElementById("paper-ram-text").textContent = "Eteint"; }
    currentMode = data.mode;
    const modeBadge = document.getElementById("mode-badge");
    if (data.mode === "assetto") { modeBadge.textContent = "🏎️ Assetto Corsa"; modeBadge.className = "mode-badge assetto"; }
    else { modeBadge.textContent = "⛏️ Minecraft"; modeBadge.className = "mode-badge minecraft"; }
  } catch (e) {}
}

async function loadServerStatus() {
  try {
    const res = await fetch("/api/servers");
    const data = await res.json();
    const statsRes = await fetch("/api/stats");
    const statsData = statsRes.ok ? await statsRes.json() : null;
    ["fabric", "paper"].forEach(s => {
      const badge = document.getElementById(s + "-status");
      if (!badge) return;
      const mshActive = data[s] === "online";
      const javaActive = statsData && statsData.servers[s] && statsData.servers[s].ram !== null;
      let statusText, statusClass;
      if (!mshActive) {
        statusText = "Hors ligne"; statusClass = "status-badge offline";
      } else if (javaActive) {
        statusText = "En ligne"; statusClass = "status-badge online";
      } else {
        statusText = "En écoute"; statusClass = "status-badge listening";
      }
      badge.textContent = statusText;
      badge.className = statusClass;
      const dashEl = document.getElementById(s + "-players");
      if (dashEl && !javaActive) {
        if (!mshActive) {
          dashEl.textContent = "Hors ligne";
          dashEl.style.color = "#f87171";
        } else {
          dashEl.textContent = "En écoute";
          dashEl.style.color = "#fbbf24";
        }
      }
    });
  } catch (e) {}
}

async function loadACStatus() {
  try {
    const res = await fetch("/api/ac/status");
    const data = await res.json();
    const badge = document.getElementById("ac-status");
    if (badge) { badge.textContent = data.active ? "En ligne" : "Hors ligne"; badge.className = "status-badge " + (data.active ? "online" : "offline"); }
    const ramEl = document.getElementById("ac-ram");
    if (ramEl) ramEl.textContent = data.ram ? formatBytes(data.ram) : "—";
    const countEl = document.getElementById("ac-player-count");
    if (countEl) countEl.textContent = data.active ? data.players.length + " joueur(s)" : "—";
    const playersList = document.getElementById("ac-players-list");
    if (playersList) {
      if (data.players && data.players.length > 0) { playersList.textContent = data.players.join(", "); playersList.style.color = "#4ade80"; }
      else { playersList.textContent = data.active ? "Aucun joueur" : "Serveur hors ligne"; playersList.style.color = "#4a5568"; }
    }
    const acDashStatus = document.getElementById("ac-dash-status");
    const acDashRamBar = document.getElementById("ac-dash-ram-bar");
    const acDashRamText = document.getElementById("ac-dash-ram-text");
    if (acDashStatus) {
      acDashStatus.textContent = data.active ? (data.players.length > 0 ? data.players.length + " pilote(s)" : "En ligne") : "Hors ligne";
      acDashStatus.style.color = data.active ? "#4ade80" : "#f87171";
    }
    if (data.ram && acDashRamBar) {
      const pct = Math.round((data.ram / (3 * 1073741824)) * 100);
      acDashRamBar.style.width = pct + "%";
      if (acDashRamText) acDashRamText.textContent = formatBytes(data.ram) + " (" + pct + "%)";
    } else if (acDashRamBar) {
      acDashRamBar.style.width = "0%";
      if (acDashRamText) acDashRamText.textContent = "Serveur éteint";
    }
  } catch (e) {}
}

async function loadACConfigFields() {
  try {
    const res = await fetch("/api/ac/config");
    const data = await res.json();
    document.getElementById("ac-name").value = data.serverCfg.SERVER && data.serverCfg.SERVER.NAME ? data.serverCfg.SERVER.NAME : "";
    document.getElementById("ac-password").value = data.serverCfg.SERVER && data.serverCfg.SERVER.PASSWORD ? data.serverCfg.SERVER.PASSWORD : "";
    document.getElementById("ac-max-clients").value = data.serverCfg.SERVER && data.serverCfg.SERVER.MAX_CLIENTS ? data.serverCfg.SERVER.MAX_CLIENTS : 10;
    document.getElementById("ac-sun-angle").value = data.serverCfg.SERVER && data.serverCfg.SERVER.SUN_ANGLE ? data.serverCfg.SERVER.SUN_ANGLE : 16;
    allTracks = data.tracks.sort();
    const trackSelect = document.getElementById("ac-track");
    trackSelect.innerHTML = "";
    allTracks.forEach(track => {
      const opt = document.createElement("option");
      opt.value = track; opt.textContent = track;
      if (data.serverCfg.SERVER && track === data.serverCfg.SERVER.TRACK) opt.selected = true;
      trackSelect.appendChild(opt);
    });
    await loadTrackConfigs();
    const configTrack = data.serverCfg.SERVER && data.serverCfg.SERVER.CONFIG_TRACK ? data.serverCfg.SERVER.CONFIG_TRACK : "";
    if (configTrack) {
      const configSelect = document.getElementById("ac-track-config");
      for (let opt of configSelect.options) { if (opt.value === configTrack) { opt.selected = true; break; } }
    }
    updateTrackPreview();
    allCars = data.cars.sort();
    allCarsMods = data.cars.sort();
    if (!acConfigLoaded) { acConfigLoaded = true; panelCarsSelection = data.selectedCars || []; renderPanelCars(); }
  } catch (e) {}
}

function renderPanelCars() {
  const container = document.getElementById("ac-cars-list");
  if (!container) return;
  container.innerHTML = "";
  if (panelCarsSelection.length === 0) {
    container.innerHTML = "<div style=\"color:#4a5568;font-size:0.82rem;padding:8px\">Aucune voiture. Utilise le <strong style=\"color:#fb923c\">Navigateur AC</strong>.</div>";
    return;
  }
  panelCarsSelection.forEach(carId => {
    const meta = allCarsMeta && allCarsMeta.find ? allCarsMeta.find(c => c.id === carId) : null;
    const name = meta ? meta.name : carId;
    const brand = meta ? meta.brand : "";
    const tag = document.createElement("div");
    tag.className = "selected-car-tag";
    tag.innerHTML = "<img src=\"/api/ac/car-image/" + carId + "/badge.png\" alt=\"\" onerror=\"this.style.display=\'none'\" style=\"width:28px;height:28px;object-fit:contain;flex-shrink:0\" /><div style=\"flex:1;min-width:0\"><div style=\"font-size:0.82rem;font-weight:bold;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">" + name + "</div><div style=\"font-size:0.72rem;color:#fb923c\">" + brand + "</div></div><button onclick=\"removePanelCar(\'" + carId + "\')\">✕</button>";
    container.appendChild(tag);
  });
}

function removePanelCar(carId) {
  panelCarsSelection = panelCarsSelection.filter(id => id !== carId);
  renderPanelCars();
}

function getCurrentPanelCars() { return panelCarsSelection; }

function applyCarSelectionToPanel(cars) {
  panelCarsSelection = cars;
  acConfigLoaded = true;
  renderPanelCars();
}

async function loadTrackConfigs() {
  const track = document.getElementById("ac-track").value;
  const res = await fetch("/api/ac/track-configs/" + track);
  const data = await res.json();
  const select = document.getElementById("ac-track-config");
  select.innerHTML = "<option value=\"\">— Pas de config —</option>";
  data.configs.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    select.appendChild(opt);
  });
  updateTrackPreview();
}

function updateTrackPreview() {
  const track = document.getElementById("ac-track").value;
  const nameEl = document.getElementById("ac-track-name");
  const imgEl = document.getElementById("ac-track-img");
  if (nameEl) nameEl.textContent = track;
  if (imgEl) {
    const cfg = document.getElementById("ac-track-config") ? document.getElementById("ac-track-config").value || "_" : "_";
    imgEl.src = "/api/ac/track-image/" + track + "/" + encodeURIComponent(cfg) + "/preview.png";
    imgEl.style.display = "block";
    imgEl.onerror = () => { imgEl.style.display = "none"; };
  }
}

async function saveACConfig() {
  const name = document.getElementById("ac-name").value;
  const password = document.getElementById("ac-password").value;
  const track = document.getElementById("ac-track").value;
  const trackConfig = document.getElementById("ac-track-config").value;
  const maxClients = document.getElementById("ac-max-clients").value;
  const sunAngle = document.getElementById("ac-sun-angle").value;
  const cars = panelCarsSelection;
  if (cars.length === 0) {
    const msg = document.getElementById("ac-config-msg");
    msg.textContent = "Selectionne au moins une voiture."; msg.style.color = "#f87171"; return;
  }
  const res = await fetch("/api/ac/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, password, track, trackConfig, cars, maxClients, sunAngle }) });
  const data = await res.json();
  const msg = document.getElementById("ac-config-msg");
  msg.textContent = data.success ? "✅ Configuration sauvegardee !" : "Erreur : " + data.error;
  msg.style.color = data.success ? "#4ade80" : "#f87171";
}

async function restartAC() {
  if (!confirm("Redemarrer Assetto Corsa ?")) return;
  const res = await fetch("/api/ac/restart", { method: "POST" });
  const data = await res.json();
  const msg = document.getElementById("ac-config-msg");
  if (msg) { msg.textContent = data.success ? "🔄 Serveur AC redemarre !" : "Erreur : " + data.error; msg.style.color = data.success ? "#4ade80" : "#f87171"; }
}

function confirmSwitch(target) {
  pendingSwitchTarget = target || (currentMode === "minecraft" ? "assetto" : "minecraft");
  const modal = document.getElementById("modal-switch");
  const title = document.getElementById("modal-title");
  const text = document.getElementById("modal-text");
  const btn = document.getElementById("modal-confirm-btn");
  if (pendingSwitchTarget === "assetto") {
    title.textContent = "🏎️ Basculer sur Assetto Corsa";
    text.textContent = "Les serveurs Minecraft vont etre arretes. Les joueurs connectes seront deconnectes. Confirmer ?";
  } else {
    title.textContent = "⛏️ Revenir sur Minecraft";
    text.textContent = "Le serveur Assetto Corsa va etre arrete. Les pilotes connectes seront deconnectes. Confirmer ?";
  }
  btn.dataset.target = pendingSwitchTarget;
  modal.style.display = "flex";
}

function closeModal() {
  document.getElementById("modal-switch").style.display = "none";
  pendingSwitchTarget = null;
}

async function executeSwitch(target) {
  closeModal();
  if (!target) return;
  const loadingModal = document.getElementById("modal-loading");
  const loadingText = document.getElementById("loading-text");
  const loadingSub = document.getElementById("loading-sub");
  if (loadingText) loadingText.textContent = target === "assetto" ? "🏎️ Activation Assetto Corsa..." : "⛏️ Activation Minecraft...";
  if (loadingSub) loadingSub.textContent = target === "assetto" ? "Arret des serveurs Minecraft" : "Arret Assetto Corsa";
  if (loadingModal) loadingModal.style.display = "flex";
  const endpoint = target === "assetto" ? "/api/ac/switch-to-assetto" : "/api/ac/switch-to-minecraft";
  try {
    await fetch(endpoint, { method: "POST" });
    showToast("Bascule lancée", target === "assetto" ? "Passage en mode Assetto Corsa" : "Passage en mode Minecraft", "success");
    addActivity("Bascule " + (target === "assetto" ? "vers Assetto Corsa" : "vers Minecraft"), "Transition en cours", "switch");
  } catch (e) { showToast("Erreur", "La bascule a échoué", "error"); }
  setTimeout(() => { if (loadingModal) loadingModal.style.display = "none"; }, 12000);
}

async function loadMCConfig(server) {
  try {
    const res = await fetch("/api/mc/" + server + "/config");
    const data = await res.json();
    const p = data.props;
    ["motd","max-players","view-distance","simulation-distance","difficulty","gamemode","pvp","white-list","allow-flight","spawn-protection"].forEach(field => {
      const el = document.getElementById(server + "-" + field);
      if (el && p[field] !== undefined) {
        el.value = p[field];
        const valEl = document.getElementById(server + "-" + field + "-val");
        if (valEl) valEl.textContent = p[field];
      }
    });
  } catch (e) {}
}

async function saveMCConfig(server) {
  const fields = ["motd","max-players","view-distance","simulation-distance","difficulty","gamemode","pvp","white-list","allow-flight","spawn-protection"];
  const body = {};
  fields.forEach(field => { const el = document.getElementById(server + "-" + field); if (el) body[field] = el.value; });
  const res = await fetch("/api/mc/" + server + "/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  const msg = document.getElementById(server + "-config-msg");
  msg.textContent = data.success ? "Configuration sauvegardee ! Redemarrez le serveur." : "Erreur : " + data.error;
  msg.style.color = data.success ? "#4ade80" : "#f87171";
}

async function loadWhitelist(server) {
  try {
    const res = await fetch("/api/mc/" + server + "/whitelist");
    const data = await res.json();
    const container = document.getElementById(server + "-whitelist-list");
    container.innerHTML = "";
    data.whitelist.forEach(p => {
      const tag = document.createElement("div");
      tag.className = "player-tag";
      tag.innerHTML = "<span>" + (p.name || p) + "</span><button onclick=\"removeFromWhitelist(\'" + server + "\',\'" + (p.name || p) + "\')\">✕</button>";
      container.appendChild(tag);
    });
  } catch (e) {}
}

async function addToWhitelist(server) {
  const input = document.getElementById(server + "-whitelist-input");
  const player = input.value.trim();
  if (!player) return;
  const res = await fetch("/api/mc/" + server + "/whitelist/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player }) });
  const data = await res.json();
  const msg = document.getElementById(server + "-whitelist-msg");
  msg.textContent = data.success ? player + " ajoute a la whitelist" : data.error;
  msg.style.color = data.success ? "#4ade80" : "#f87171";
  if (data.success) { input.value = ""; loadWhitelist(server); }
}

async function removeFromWhitelist(server, player) {
  const res = await fetch("/api/mc/" + server + "/whitelist/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player }) });
  const data = await res.json();
  if (data.success) loadWhitelist(server);
}

async function loadOps(server) {
  try {
    const res = await fetch("/api/mc/" + server + "/ops");
    const data = await res.json();
    const container = document.getElementById(server + "-ops-list");
    container.innerHTML = "";
    data.ops.forEach(p => {
      const tag = document.createElement("div");
      tag.className = "player-tag";
      tag.innerHTML = "<span>👑 " + (p.name || p) + "</span><button onclick=\"removeOp(\'" + server + "\',\'" + (p.name || p) + "\')\">✕</button>";
      container.appendChild(tag);
    });
  } catch (e) {}
}

async function addOp(server) {
  const input = document.getElementById(server + "-ops-input");
  const player = input.value.trim();
  if (!player) return;
  const res = await fetch("/api/mc/" + server + "/ops/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player }) });
  const data = await res.json();
  const msg = document.getElementById(server + "-ops-msg");
  msg.textContent = data.success ? player + " est maintenant op" : data.error;
  msg.style.color = data.success ? "#4ade80" : "#f87171";
  if (data.success) { input.value = ""; loadOps(server); }
}

async function removeOp(server, player) {
  const res = await fetch("/api/mc/" + server + "/ops/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player }) });
  const data = await res.json();
  if (data.success) loadOps(server);
}

async function serverAction(server, action) {
  const res = await fetch("/api/servers/" + server + "/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
  const data = await res.json();
  if (!data.success) alert("Erreur : " + data.error);
}

function confirmAction(server, action) {
  if (confirm("Confirmer : " + action + " sur " + server + " ?")) serverAction(server, action);
}

async function sendCommand(server) {
  const input = document.getElementById(server + "-cmd");
  const command = input.value.trim();
  if (!command) return;
  const res = await fetch("/api/servers/" + server + "/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }) });
  const data = await res.json();
  const responseEl = document.getElementById(server + "-cmd-response");
  if (data.success) { responseEl.textContent = data.response || "Commande envoyee"; responseEl.style.color = "#4ade80"; }
  else { responseEl.textContent = data.error; responseEl.style.color = "#f87171"; }
  input.value = "";
}

async function uploadMod(type, input) {
  const file = input.files[0];
  if (!file) return;
  const progressDiv = document.getElementById("upload-" + type + "-progress");
  const progressFill = document.getElementById(type + "-progress-fill");
  const progressText = document.getElementById(type + "-progress-text");
  progressDiv.style.display = "block";
  progressText.textContent = "Upload de " + file.name + "...";
  const formData = new FormData();
  formData.append("mod", file);
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = "Upload : " + pct + "% (" + formatBytes(e.loaded) + " / " + formatBytes(e.total) + ")";
    }
  };
  xhr.onload = () => {
    try {
      const data = JSON.parse(xhr.responseText);
      if (data.success) { progressText.textContent = "✅ " + data.message; progressFill.style.background = "#166534"; loadModsLists(); }
      else { progressText.textContent = "❌ Erreur : " + data.error; progressFill.style.background = "#7f1d1d"; }
    } catch (e) { progressText.textContent = "❌ Erreur inattendue"; }
    input.value = "";
  };
  xhr.open("POST", "/api/ac/upload/" + type);
  xhr.send(formData);
}

function loadModsLists() {
  fetch("/api/ac/config").then(r => r.json()).then(data => {
    allCarsMods = data.cars.sort();
    allTracksMods = data.tracks.sort();
    renderModsList("cars", allCarsMods);
    renderModsList("tracks", allTracksMods);
    document.getElementById("cars-count").textContent = allCarsMods.length;
    document.getElementById("tracks-count").textContent = allTracksMods.length;
  });
}

function renderModsList(type, items) {
  const container = document.getElementById(type + "-mod-list");
  if (!container) return;
  container.innerHTML = "";
  items.forEach(item => {
    const div = document.createElement("div");
    div.className = "mod-item";
    div.textContent = item;
    container.appendChild(div);
  });
}

function filterModList(type, query) {
  const list = type === "cars" ? allCarsMods : allTracksMods;
  renderModsList(type, list.filter(i => i.toLowerCase().includes(query.toLowerCase())));
}

async function saveSettings() {
  const rate = document.getElementById("rate-input").value;
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ratePerKwh: rate }) });
  const data = await res.json();
  document.getElementById("settings-msg").textContent = data.success ? "Tarif sauvegarde !" : "Erreur";
}

async function changePassword() {
  const pwd = document.getElementById("new-password").value;
  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newPassword: pwd }) });
  const data = await res.json();
  document.getElementById("settings-msg").textContent = data.success ? "Mot de passe change !" : "Erreur (min 6 caracteres)";
}

async function loadSysinfo() {
  const res = await fetch("/api/sysinfo");
  const data = await res.json();
  document.getElementById("sysinfo-output").textContent = data.info;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " Go";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " Mo";
  return (bytes / 1024).toFixed(0) + " Ko";
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d + "j " + h + "h " + m + "m";
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  setTimeout(initSparklines, 500);
  // Vérifie si session encore valide au chargement
  fetch("/api/stats").then(r => {
    if (r.ok) {
      document.getElementById("login-screen").style.display = "none";
      document.getElementById("main-panel").style.display = "flex";
      initPanel();
    }
  }).catch(() => {});
  ["fabric", "paper"].forEach(server => {
    const input = document.getElementById(server + "-cmd");
    if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") sendCommand(server); });
  });
  const pwdInput = document.getElementById("password");
  if (pwdInput) pwdInput.addEventListener("keydown", e => { if (e.key === "Enter") login(); });

  const confirmBtn = document.getElementById("modal-confirm-btn");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = confirmBtn.dataset.target;
      if (target) executeSwitch(target);
    });
  }

  ["car", "track"].forEach(type => {
    const zone = document.getElementById("drop-" + type);
    if (!zone) return;
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", e => {
      e.preventDefault();
      zone.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".zip")) {
        const fakeInput = { files: [file], value: "" };
        uploadMod(type, fakeInput);
      } else { alert("Seuls les fichiers .zip sont acceptes"); }
    });
  });
});

// ==================== PERSONNALISATION DASHBOARD ====================

const WIDGET_DEFAULTS = {
  'stats': true, 'temp': true, 'disk': true, 'uptime': true,
  'power': true, 'fabric': true, 'paper': true, 'switch-widget': true
};

function loadWidgetPreferences() {
  const prefs = JSON.parse(localStorage.getItem('widgetPrefs') || '{}');
  Object.keys(WIDGET_DEFAULTS).forEach(id => {
    const visible = prefs[id] !== undefined ? prefs[id] : WIDGET_DEFAULTS[id];
    const widget = document.getElementById('widget-' + id);
    const toggle = document.getElementById('toggle-' + id);
    if (widget) widget.classList.toggle('hidden', !visible);
    if (toggle) toggle.checked = visible;
  });
}

function toggleWidget(id, visible) {
  const widget = document.getElementById('widget-' + id);
  if (widget) widget.classList.toggle('hidden', !visible);
  const prefs = JSON.parse(localStorage.getItem('widgetPrefs') || '{}');
  prefs[id] = visible;
  localStorage.setItem('widgetPrefs', JSON.stringify(prefs));
}

function resetWidgets() {
  localStorage.removeItem('widgetPrefs');
  Object.keys(WIDGET_DEFAULTS).forEach(id => {
    const widget = document.getElementById('widget-' + id);
    const toggle = document.getElementById('toggle-' + id);
    if (widget) widget.classList.remove('hidden');
    if (toggle) toggle.checked = true;
  });
}

function toggleCustomizePanel() {
  const panel = document.getElementById('customize-panel');
  panel.classList.toggle('open');
}

document.addEventListener('DOMContentLoaded', () => {
  loadWidgetPreferences();
});

// ==================== THEME DARK/LIGHT ====================

function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);
}

function applyTheme(theme) {
  const btn = document.getElementById('theme-toggle-btn');
  if (theme === 'light') {
    document.body.classList.add('light-mode');
    if (btn) btn.textContent = '🌙 Mode sombre';
  } else {
    document.body.classList.remove('light-mode');
    if (btn) btn.textContent = '☀️ Mode clair';
  }
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const isLight = document.body.classList.contains('light-mode');
  applyTheme(isLight ? 'dark' : 'light');
}

// ==================== GRAPHIQUES SPARKLINE ====================

let ramSparkline = null;
let cpuSparkline = null;
let historyChart = null;
const sparklineData = { ram: Array(60).fill(0), cpu: Array(60).fill(0) };

function initSparklines() {
  const ramCanvas = document.getElementById('ram-sparkline');
  const cpuCanvas = document.getElementById('cpu-sparkline');
  if (!ramCanvas || !cpuCanvas || typeof Chart === 'undefined') return;

  const sparkConfig = (color, data) => ({
    type: 'line',
    data: {
      labels: Array(60).fill(''),
      datasets: [{ data, borderColor: color, borderWidth: 1.5, fill: true, backgroundColor: color + '22', pointRadius: 0, tension: 0.3 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, min: 0, max: 100 }
      },
      animation: false,
      events: []
    }
  });

  ramSparkline = new Chart(ramCanvas, sparkConfig('#3b82f6', [...sparklineData.ram]));
  cpuSparkline = new Chart(cpuCanvas, sparkConfig('#e94560', [...sparklineData.cpu]));

  fetch('/api/history').then(r => r.json()).then(data => {
    if (data.ram && data.ram.length > 0) {
      const last60ram = data.ram.slice(-60);
      const last60cpu = data.cpu.slice(-60);
      sparklineData.ram = [...Array(60 - last60ram.length).fill(0), ...last60ram];
      sparklineData.cpu = [...Array(60 - last60cpu.length).fill(0), ...last60cpu];
      ramSparkline.data.datasets[0].data = [...sparklineData.ram];
      cpuSparkline.data.datasets[0].data = [...sparklineData.cpu];
      ramSparkline.update('none');
      cpuSparkline.update('none');
    }
  }).catch(() => {});
}

function updateSparklines(ramPct, cpuPct) {
  sparklineData.ram.push(ramPct);
  sparklineData.ram.shift();
  sparklineData.cpu.push(cpuPct);
  sparklineData.cpu.shift();

  if (ramSparkline) {
    ramSparkline.data.datasets[0].data = [...sparklineData.ram];
    const cpuColor = cpuPct > 90 ? '#f87171' : cpuPct > 70 ? '#fb923c' : '#e94560';
    if (cpuSparkline) cpuSparkline.data.datasets[0].borderColor = cpuColor;
    ramSparkline.update('none');
  }
  if (cpuSparkline) {
    cpuSparkline.data.datasets[0].data = [...sparklineData.cpu];
    cpuSparkline.update('none');
  }
}

async function openChartModal() {
  const modal = document.getElementById('modal-chart');
  if (!modal) return;
  modal.style.display = 'flex';

  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    const canvas = document.getElementById('chart-history');
    if (!canvas) return;

    if (historyChart) { historyChart.destroy(); historyChart = null; }

    const step = Math.max(1, Math.floor(data.ram.length / 60));
    const labels = data.timestamps.filter((_, i) => i % step === 0);
    const ramData = data.ram.filter((_, i) => i % step === 0);
    const cpuData = data.cpu.filter((_, i) => i % step === 0);

    historyChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'RAM %', data: ramData, borderColor: '#3b82f6', backgroundColor: '#3b82f622', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true },
          { label: 'CPU %', data: cpuData, borderColor: '#e94560', backgroundColor: '#e9456022', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: true }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#a0aec0' } } },
        scales: {
          x: { ticks: { color: '#4a5568', maxTicksLimit: 10 }, grid: { color: '#1e3a5f' } },
          y: { min: 0, max: 100, ticks: { color: '#4a5568', callback: v => v + '%' }, grid: { color: '#1e3a5f' } }
        }
      }
    });
  } catch(e) {}
}

// ==================== NOTIFICATIONS TOAST ====================

function showToast(title, msg, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.innerHTML = '<span class="toast-icon">' + (icons[type] || 'ℹ️') + '</span><div class="toast-content"><div class="toast-title">' + title + '</div>' + (msg ? '<div class="toast-msg">' + msg + '</div>' : '') + '</div><button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==================== FAVICON DYNAMIQUE ====================

function updateFavicon(playersCount) {
  const title = playersCount > 0 ? playersCount + ' joueur(s) — LiteCorps Panel' : 'LiteCorps Panel';
  document.title = title;
}

// ==================== SURVEILLANCE ÉVÉNEMENTS ====================

let prevServerStates = { fabric: null, paper: null, assetto: null };
let prevPlayers = { fabric: 0, paper: 0 };

function checkServerEvents(data) {
  const fabricActive = data.servers.fabric.ram !== null;
  const paperActive = data.servers.paper.ram !== null;
  const totalPlayers = (data.servers.fabric.players ? data.servers.fabric.players.online : 0) +
                       (data.servers.paper.players ? data.servers.paper.players.online : 0);

  if (prevServerStates.fabric !== null && fabricActive !== prevServerStates.fabric) {
    if (fabricActive) { showToast('Fabric démarré', 'Le serveur Fabric 1.20+ est en ligne', 'success'); addActivity('Fabric démarré', 'Serveur Fabric 1.20+ en ligne', 'success'); }
    else { showToast('Fabric arrêté', 'Le serveur Fabric 1.20+ est hors ligne', 'warning'); addActivity('Fabric arrêté', 'Serveur Fabric 1.20+ hors ligne', 'warning'); }
  }
  if (prevServerStates.paper !== null && paperActive !== prevServerStates.paper) {
    if (paperActive) { showToast('Paper démarré', 'Le serveur Paper 1.17.1 est en ligne', 'success'); addActivity('Paper démarré', 'Serveur Paper 1.17.1 en ligne', 'success'); }
    else { showToast('Paper arrêté', 'Le serveur Paper 1.17.1 est hors ligne', 'warning'); addActivity('Paper arrêté', 'Serveur Paper 1.17.1 hors ligne', 'warning'); }
  }

  const fabricPlayers = data.servers.fabric.players ? data.servers.fabric.players.online : 0;
  const paperPlayers = data.servers.paper.players ? data.servers.paper.players.online : 0;

  if (prevPlayers.fabric !== null && fabricPlayers > prevPlayers.fabric) {
    showToast('Joueur connecté', 'Fabric : ' + fabricPlayers + ' joueur(s)', 'info');
    addActivity('Joueur connecté sur Fabric', fabricPlayers + ' joueur(s) en ligne', 'player');
  } else if (prevPlayers.fabric !== null && fabricPlayers < prevPlayers.fabric) {
    showToast('Joueur déconnecté', 'Fabric : ' + fabricPlayers + ' joueur(s)', 'info');
    addActivity('Joueur déconnecté de Fabric', fabricPlayers + ' joueur(s) restant', 'player');
  }
  if (prevPlayers.paper !== null && paperPlayers > prevPlayers.paper) {
    showToast('Joueur connecté', 'Paper : ' + paperPlayers + ' joueur(s)', 'info');
    addActivity('Joueur connecté sur Paper', paperPlayers + ' joueur(s) en ligne', 'player');
  } else if (prevPlayers.paper !== null && paperPlayers < prevPlayers.paper) {
    showToast('Joueur déconnecté', 'Paper : ' + paperPlayers + ' joueur(s)', 'info');
    addActivity('Joueur déconnecté de Paper', paperPlayers + ' joueur(s) restant', 'player');
  }

  prevServerStates.fabric = fabricActive;
  prevServerStates.paper = paperActive;
  prevPlayers.fabric = fabricPlayers;
  prevPlayers.paper = paperPlayers;

  updateFavicon(totalPlayers);
}

// Alerte RAM > 85%
let ramAlertSent = false;
function checkAlerts(cpuPct, ramPct) {
  if (ramPct > 85 && !ramAlertSent) {
    showToast('⚠️ RAM élevée', 'Utilisation RAM : ' + ramPct + '%', 'error');
    ramAlertSent = true;
  } else if (ramPct < 80) {
    ramAlertSent = false;
  }
  if (cpuPct > 90) {
    showToast('⚠️ CPU saturé', 'Utilisation CPU : ' + cpuPct + '%', 'error', 10000);
  }
}

// ==================== ACTIVITÉ RÉCENTE ====================

const activityLog = [];
const MAX_ACTIVITY = 50;

const activityIcons = {
  success: '🚀',
  warning: '⚠️',
  error: '❌',
  info: 'ℹ️',
  player: '👤',
  switch: '🔄'
};

function addActivity(event, detail, type = 'info') {
  const now = new Date();
  const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  activityLog.unshift({ event, detail, type, time });
  if (activityLog.length > MAX_ACTIVITY) activityLog.pop();
  renderActivity();
}

function renderActivity() {
  const container = document.getElementById('activity-timeline');
  if (!container) return;
  if (activityLog.length === 0) {
    container.innerHTML = '<div class="activity-empty">Aucune activité récente</div>';
    return;
  }
  container.innerHTML = activityLog.map(item => `
    <div class="activity-item">
      <div class="activity-icon ${item.type}">${activityIcons[item.type] || 'ℹ️'}</div>
      <div class="activity-content">
        <div class="activity-event">${item.event}</div>
        ${item.detail ? '<div class="activity-detail">' + item.detail + '</div>' : ''}
      </div>
      <div class="activity-time">${item.time}</div>
    </div>
  `).join('');
}

function clearActivity() {
  activityLog.length = 0;
  renderActivity();
}
