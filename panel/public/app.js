// Panel Garage Pikes : vue d'ensemble, détail par serveur, journal. Branché sur l'API de server.js.
(() => {
  const GB = 1073741824;
  const POLL_MS = 5000;
  const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => new Date().toLocaleTimeString('fr-FR', { hour12: false });
  const fmt = (n, d = 1) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const opts = (map, val) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(v)}</option>`).join('');

  const STATE_LABEL = { running: 'En ligne', sleeping: 'En veille', starting: 'Démarrage', stopping: 'Arrêt en cours', stopped: 'Arrêté', soon: 'Backend à venir' };
  const GAMEMODES = { survival: 'Survie', creative: 'Créatif', adventure: 'Aventure', spectator: 'Spectateur' };
  const DIFFS = { peaceful: 'Paisible', easy: 'Facile', normal: 'Normale', hard: 'Difficile' };
  const TRACKS_LMU = { lemans: 'Circuit de la Sarthe', spa: 'Spa-Francorchamps', monza: 'Monza', fuji: 'Fuji Speedway', sebring: 'Sebring', portimao: 'Portimão', bahrain: 'Bahrain', imola: 'Imola', cota: 'Circuit of the Americas', qatar: 'Lusail' };
  const MAPS_FS = { goldcrest: 'Goldcrest Valley', sosnovka: 'Sosnovka' };

  // ram : estimation en Go, utilisée pour l'aperçu sur la bande mémoire avant démarrage.
  const servers = [
    { id: 'fabric', no: 12, k: 'k-fabric', ink: 'dark', name: 'Minecraft Fabric', ver: 'Fabric 1.20+ · MSH', game: 'mc', ram: 4 },
    { id: 'paper', no: 7, k: 'k-paper', ink: 'dark', name: 'Minecraft Paper', ver: 'Paper 1.17.1 · ViaVersion · MSH', game: 'mc', ram: 3 },
    { id: 'assetto', no: 24, k: 'k-ac', ink: 'light', name: 'Assetto Corsa', ver: 'acServer · Wine', game: 'ac', ram: 1.5 },
    { id: 'lmu', no: 51, k: 'k-lmu', ink: 'dark', name: 'Le Mans Ultimate', ver: 'Serveur dédié · Wine', game: 'lmu', ram: 4.5, soon: true,
      cfg: { track: 'lemans', classes: ['Hypercar', 'LMGT3'], duration: 90, timemult: 1, fuel: 1 } },
    { id: 'fs', no: 17, k: 'k-fs', ink: 'dark', name: 'Farming Simulator 17', ver: 'Serveur dédié · Wine', game: 'fs', ram: 3, soon: true,
      cfg: { map: 'goldcrest', slot: 1, difficulty: 'normal', max: 6 } }
  ];
  servers.forEach(s => Object.assign(s, { logs: [], players: [], pending: null, state: s.soon ? 'soon' : 'stopped', ramNow: null }));
  const byId = (id) => servers.find(s => s.id === id);

  const sys = { stats: null, cpu: [], temp: [], mode: 'minecraft' };
  let acCfg = null, acMeta = null, acCars = null;
  let view = 'overview', tab = 'console', ghost = null, tapeMsg = { text: '', bad: false }, lastSig = '';
  let journal = [];
  try { journal = JSON.parse(localStorage.getItem('gp-journal')) || []; } catch (_) {}

  /* ---------- API ---------- */
  async function api(url, body) {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { showLogin(); throw new Error('Session expirée'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Erreur ' + r.status);
    return d;
  }

  function journalAdd(s, cls, msg) {
    journal.unshift({ t: now(), id: s ? s.id : null, cls, msg });
    journal.length = Math.min(journal.length, 200);
    try { localStorage.setItem('gp-journal', JSON.stringify(journal)); } catch (_) {}
  }

  /* ---------- État ---------- */
  const usedGB = () => sys.stats ? sys.stats.memory.used / GB : 0;
  const totalGB = () => sys.stats ? sys.stats.memory.total / GB : 16;
  const isUp = (s) => ['running', 'sleeping', 'starting', 'stopping'].includes(s.state);

  function realState(s, svc, ac) {
    if (s.soon) return 'soon';
    if (s.game === 'ac') return ac && ac.active ? 'running' : 'stopped';
    if (svc[s.id] !== 'online') return 'stopped';
    return s.ramNow ? 'running' : 'sleeping'; // MSH : service actif, JVM lancée à la première connexion
  }

  function applyState(s, real) {
    const p = s.pending;
    if (p && Date.now() < p.until && !(p.state === 'starting' ? real !== 'stopped' : real === 'stopped')) { s.state = p.state; return; }
    s.pending = null;
    if (s.state !== real && s.state !== 'soon' && lastSig) journalAdd(s, real === 'stopped' ? '' : 'o', `${s.name} : ${STATE_LABEL[real].toLowerCase()}`);
    s.state = real;
  }

  async function poll() {
    const [st, svc, ac, hist] = await Promise.allSettled([api('/api/stats'), api('/api/servers'), api('/api/ac/status'), api('/api/history')]);
    if (st.status === 'fulfilled') {
      const d = st.value; sys.stats = d; sys.mode = d.mode;
      for (const id of ['fabric', 'paper']) {
        const s = byId(id), x = d.servers[id] || {};
        s.ramNow = x.ram || null; s.online = x.players || null;
      }
      if (d.temperature != null) { sys.temp.push(d.temperature); if (sys.temp.length > 360) sys.temp.shift(); }
    }
    if (ac.status === 'fulfilled') { const a = byId('assetto'); a.ramNow = ac.value.ram || null; a.players = ac.value.players || []; }
    if (hist.status === 'fulfilled') sys.cpu = hist.value.cpu.filter((_, i, a) => (a.length - 1 - i) % 5 === 0);
    const svcVal = svc.status === 'fulfilled' ? svc.value : {};
    servers.forEach(s => applyState(s, realState(s, svcVal, ac.status === 'fulfilled' ? ac.value : null)));
    const s = byId(view);
    if (s && s.game === 'mc' && tab === 'players' && s.state === 'running') await loadMcPlayers(s);
    refresh();
  }

  function refresh() {
    const sig = JSON.stringify([view, tab, sys.mode, servers.map(s => [s.state, s.players.length, s.online && s.online.online, Math.round((s.ramNow || 0) / GB * 10)]), Math.round(usedGB() * 10)]);
    const changed = sig !== lastSig; lastSig = sig;
    renderNav();
    if (changed && tab !== 'settings' && view !== 'settings') render();
    else updateReadouts();
  }

  /* ---------- Nav ---------- */
  const plate = (s, lg) => `<span class="plate ${lg ? 'lg' : ''} ${s.k} ${s.ink === 'light' ? 'light-ink' : ''}" aria-hidden="true">${s.no}</span>`;
  function renderNav() {
    const cur = (v) => view === v ? 'aria-current="page"' : '';
    $('#nav').innerHTML = `
      <button type="button" data-go="overview" ${cur('overview')}>${icon('grid')}<span class="lbl">Vue d'ensemble</span></button>
      <div class="nav-title">Serveurs</div>
      ${servers.map(s => `<button type="button" data-go="${s.id}" ${cur(s.id)}>${plate(s)}<span class="lbl">${esc(s.name)}</span><span class="dot ${s.state}" title="${STATE_LABEL[s.state]}"></span></button>`).join('')}
      <div class="nav-title">Panel</div>
      <button type="button" data-go="journal" ${cur('journal')}>${icon('log')}<span class="lbl">Journal</span></button>
      <button type="button" data-go="settings" ${cur('settings')}>${icon('gear')}<span class="lbl">Réglages du panel</span></button>`;
  }

  /* ---------- Bande mémoire ---------- */
  function tapeHTML() {
    const TOTAL = totalGB(), used = usedGB();
    const up = servers.filter(s => s.ramNow);
    const sysRam = Math.max(used - up.reduce((a, s) => a + s.ramNow / GB, 0), 0);
    const g = ghost ? byId(ghost) : null;
    const frees = g ? servers.filter(x => x.ramNow && x.game !== g.game && (g.game === 'ac' || x.game === 'ac')).reduce((a, x) => a + x.ramNow / GB, 0) : 0;
    const free = TOTAL - used + frees;
    const over = g && g.ram > free;
    const segs = [`<div class="seg sys" style="flex:0 0 ${sysRam / TOTAL * 100}%" title="Système ${fmt(sysRam)} Go">Système</div>`]
      .concat(up.map(s => `<div class="seg ${s.ink === 'light' ? 'light-ink' : ''}" style="--c:var(--c-${s.k.slice(2)});flex:0 0 ${s.ramNow / GB / TOTAL * 100}%" title="${esc(s.name)} ${fmt(s.ramNow / GB)} Go"><b>${s.no}</b><span class="gb">${fmt(s.ramNow / GB)} Go</span></div>`));
    if (g) segs.push(`<div class="seg ghost ${over ? 'over' : ''}" style="--c:var(--c-${g.k.slice(2)});flex:0 0 ${Math.min(g.ram, Math.max(TOTAL - used, .4)) / TOTAL * 100}%"><b>${g.no}</b><span class="gb">+${fmt(g.ram)} Go</span></div>`);
    let msg = tapeMsg.text, bad = tapeMsg.bad;
    if (g) {
      msg = (frees ? `La bascule libère ${fmt(frees)} Go. ` : '') + (over ? `${g.name} demande environ ${fmt(g.ram)} Go, il n'en resterait que ${fmt(free)}.` : `${g.name} prendra environ ${fmt(g.ram)} Go. Il restera ${fmt(free - g.ram)} Go libres.`);
      bad = over;
    }
    const q = [0, 1, 2, 3, 4].map(i => `<span>${i ? fmt(TOTAL * i / 4, 0) + ' Go' : '0'}</span>`).join('');
    return `
      <section class="panel" aria-labelledby="tape-t" id="tape">
        <div class="panel-b tape-wrap">
          <div class="tape-head">
            <h2 id="tape-t" style="font-size:15px;font-weight:650">Mémoire</h2>
            <span class="big">${fmt(used)}<small>/ ${fmt(TOTAL)} Go utilisés · ${fmt(TOTAL - used)} Go libres</small></span>
          </div>
          <div class="tape" role="img" aria-label="Mémoire utilisée ${fmt(used)} sur ${fmt(TOTAL)} Go">${segs.join('')}</div>
          <div class="tape-scale" aria-hidden="true">${q}</div>
          <div class="tape-msg ${bad ? 'bad' : ''}">${esc(msg || 'Survole « Démarrer » pour voir la place qu\'un serveur prendra.')}</div>
        </div>
      </section>`;
  }
  function refreshTape() { const t = $('#tape'); if (t) t.outerHTML = tapeHTML(); }

  /* ---------- Vue d'ensemble ---------- */
  const playersOf = (s) => s.game === 'ac' ? (s.state === 'running' ? s.players.length : 0) : s.online ? s.online.online : 0;
  const maxOf = (s) => s.game === 'ac' ? (acCfg ? acCfg.SERVER.MAX_CLIENTS : '—') : s.online ? s.online.max : s.props ? s.props['max-players'] : s.soon ? (s.cfg.max || '—') : '—';
  const portOf = (s) => s.game === 'ac' ? (acCfg ? acCfg.SERVER.TCP_PORT : '—') : s.props ? s.props['server-port'] : '—';
  const ramOf = (s) => s.ramNow ? `${fmt(s.ramNow / GB)} Go` : s.soon ? '—' : `~${fmt(s.ram)} Go`;
  function sessionOf(s) {
    if (s.soon) return s.game === 'lmu' ? TRACKS_LMU[s.cfg.track] : MAPS_FS[s.cfg.map];
    if (s.game === 'ac') return acCfg ? [acCfg.SERVER.TRACK, acCfg.SERVER.CONFIG_TRACK].filter(Boolean).join(' · ') : '—';
    if (s.state === 'sleeping') return 'MSH : démarre à la première connexion';
    return s.props ? `${GAMEMODES[s.props.gamemode] || s.props.gamemode} · ${DIFFS[s.props.difficulty] || s.props.difficulty}` : '—';
  }
  const fmtUptime = (sec) => `${Math.floor(sec / 86400)} j ${Math.floor(sec % 86400 / 3600)} h`;

  function actionButtons(s, small) {
    const sz = small ? 'sm' : '';
    if (s.soon) return `<button type="button" class="btn ${sz} primary" disabled title="Backend à venir">${icon('play')}Démarrer</button>`;
    if (s.state === 'starting' || s.state === 'stopping') return `<button type="button" class="btn ${sz} primary" disabled>${icon('play')}${STATE_LABEL[s.state]}…</button>`;
    if (s.state === 'running' || s.state === 'sleeping') return `
      <button type="button" class="btn ${sz} icon" data-act="restart" data-id="${s.id}" aria-label="Redémarrer ${esc(s.name)}" title="Redémarrer">${icon('restart')}</button>
      <button type="button" class="btn ${sz} danger" data-act="stop" data-id="${s.id}">${icon('stop')}Arrêter</button>`;
    return `<button type="button" class="btn ${sz} primary" data-act="start" data-id="${s.id}">${icon('play')}Démarrer</button>`;
  }

  function overview() {
    const st = sys.stats;
    const temp = st && st.temperature;
    const hot = temp != null && temp >= 80;
    const running = servers.filter(s => s.state === 'running').length;
    const players = servers.reduce((a, s) => a + playersOf(s), 0);
    const ac = sys.mode === 'assetto';
    return `
      <header class="topbar">
        <div>
          <h1>Vue d'ensemble</h1>
          <div class="meta"><span><b>${running}</b> serveurs en ligne sur ${servers.filter(s => !s.soon).length}</span><span><b>${players}</b> joueurs connectés</span>${st ? `<span>Allumé depuis <b>${fmtUptime(st.uptime)}</b></span>` : ''}<span>${esc(location.hostname)}</span></div>
        </div>
      </header>
      ${hot ? `<div class="alert" role="status">${icon('alert')}<div><b>Le processeur chauffe : ${fmt(temp, 0)} °C</b><p>Au-delà de 90 °C, la machine ralentit. Arrête un serveur si ça dure.</p></div><div class="actions"><button type="button" class="btn sm" data-go="journal">Voir le journal</button></div></div>` : ''}
      <section class="panel"><div class="panel-b mode">
        <span>Mode actif : <b>${ac ? 'Assetto Corsa' : 'Minecraft'}</b> <span class="sub">· Minecraft et Assetto Corsa ne tournent pas en même temps.</span></span>
        <button type="button" class="btn sm" data-act="switch" data-target="${ac ? 'minecraft' : 'assetto'}">${icon('swap')}Basculer vers ${ac ? 'Minecraft' : 'Assetto Corsa'}</button>
      </div></section>
      ${tapeHTML()}
      <div class="telemetry">
        <section class="panel" aria-labelledby="cpu-t"><div class="panel-h"><h2 id="cpu-t">Processeur</h2><span class="readout" id="cpu-now">${st ? fmt(st.cpu, 0) + ' %' : '—'}</span></div>
          <div class="panel-b"><div class="chart-box"><canvas id="c-cpu" aria-label="Charge processeur sur 30 minutes"></canvas></div></div></section>
        <section class="panel" aria-labelledby="tmp-t"><div class="panel-h"><h2 id="tmp-t">Température</h2><span class="readout ${hot ? 'warn' : ''}" id="tmp-now">${temp != null ? fmt(temp, 0) + ' °C' : '—'}</span></div>
          <div class="panel-b"><div class="chart-box"><canvas id="c-tmp" aria-label="Température processeur depuis l'ouverture du panel, seuil 80 degrés"></canvas></div></div></section>
        <section class="panel host" aria-labelledby="host-t"><div class="panel-h"><h2 id="host-t">Machine</h2></div>
          <div class="panel-b"><dl class="stats">
            <div><dt>Disque</dt><dd>${st ? `${fmt(st.disk.used / GB, 0)} / ${fmt(st.disk.total / GB, 0)} Go` : '—'}</dd></div>
            <div><dt>Consommation</dt><dd id="watts">${st ? st.power.watts + ' W' : '—'}</dd></div>
            <div><dt>Coût estimé / mois</dt><dd>${st ? fmt(st.power.monthlyCost, 2) + ' €' : '—'}</dd></div>
            <div><dt>Allumé depuis</dt><dd>${st ? fmtUptime(st.uptime) : '—'}</dd></div>
          </dl></div></section>
      </div>
      <section class="panel" aria-labelledby="ent-t">
        <div class="panel-h"><h2 id="ent-t">Serveurs de jeu</h2></div>
        <div class="table-wrap"><table class="entries">
          <thead><tr><th scope="col">Serveur</th><th scope="col">État</th><th scope="col">Session</th><th scope="col" class="num">Joueurs</th><th scope="col" class="num">Mémoire</th><th scope="col" class="num">Port</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
          <tbody>${servers.map(s => `
            <tr>
              <td class="c-ent"><div class="entry">${plate(s)}<button type="button" class="name" data-go="${s.id}"><span class="n">${esc(s.name)}</span><span class="v">${esc(s.ver)}</span></button></div></td>
              <td class="c-state">${s.soon ? '<span class="soon">Backend à venir</span>' : `<span class="state"><span class="dot ${s.state}"></span>${STATE_LABEL[s.state]}</span>`}</td>
              <td class="c-sess">${esc(sessionOf(s))}</td>
              <td class="num c-pl" data-l="Joueurs">${playersOf(s)} / ${esc(maxOf(s))}</td>
              <td class="num c-ram" data-l="Mémoire">${ramOf(s)}</td>
              <td class="num sub c-port" data-l="Port">${esc(portOf(s))}</td>
              <td class="c-act"><div class="row-actions">${actionButtons(s, true)}</div></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>`;
  }

  function updateReadouts() {
    const st = sys.stats; if (!st) return;
    const cn = $('#cpu-now'), tn = $('#tmp-now'), w = $('#watts');
    if (cn) cn.textContent = fmt(st.cpu, 0) + ' %';
    if (tn && st.temperature != null) { tn.textContent = fmt(st.temperature, 0) + ' °C'; tn.classList.toggle('warn', st.temperature >= 80); }
    if (w) w.textContent = st.power.watts + ' W';
    drawCharts();
  }

  /* ---------- Détail ---------- */
  const lineClass = (l) => /ERROR|SEVERE|Exception/i.test(l) ? 'e' : /WARN/i.test(l) ? 'w' : /Done \(|joined the game|DRIVER_CONNECTED/.test(l) ? 'o' : '';
  const CHIPS = ['list', 'tps', 'save-all', 'whitelist list', 'say Redémarrage dans 5 min'];

  function consoleHTML(s) {
    if (s.soon) return `<section class="panel"><div class="empty"><b>Backend à venir</b>La console de ${esc(s.name)} sera branchée avec le serveur dédié.</div></section>`;
    const canCmd = s.game === 'mc' && s.state === 'running';
    const ph = s.game === 'ac' ? 'Pas de commande pour Assetto Corsa, logs seulement' : canCmd ? 'Tape une commande' : 'Serveur arrêté ou en veille : pas de RCON';
    return `<div class="console">
      <div class="log" id="log" role="log" aria-label="Console ${esc(s.name)}">${s.logs.map(([c, t, m]) => `<p class="${c}">${t ? `<span class="t">${t}</span>  ` : ''}${esc(m)}</p>`).join('') || '<p class="t">En attente des logs…</p>'}</div>
      <form class="cmd" data-cmd="${s.id}"><label for="f-cmd" class="sr">Commande</label><input id="f-cmd" type="text" placeholder="${ph}" autocomplete="off" ${canCmd ? '' : 'disabled'}><button type="submit" class="btn" ${canCmd ? '' : 'disabled'}>${icon('send')}Envoyer</button></form>
      ${s.game === 'mc' ? `<div class="chips">${CHIPS.map(c => `<button type="button" class="chip" data-chip="${esc(c)}" ${canCmd ? '' : 'disabled'}>${esc(c)}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function playersHTML(s) {
    const list = s.state === 'running' ? s.players : [];
    if (!list.length) return `<div class="empty"><b>${s.soon ? 'Backend à venir' : s.state === 'running' ? 'Personne sur le serveur' : 'Serveur arrêté ou en veille'}</b>${s.state === 'running' ? 'Les joueurs apparaîtront ici dès leur connexion.' : ''}</div>`;
    return `<div class="table-wrap"><table style="min-width:360px">
      <thead><tr><th scope="col">Joueur</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${list.map(p => `<tr><td>${esc(p)}</td><td><div class="row-actions">${s.game === 'mc' ? `<button type="button" class="btn sm danger" data-act="kick" data-id="${s.id}" data-p="${esc(p)}">Expulser</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  const sel = (id, map, val) => `<select id="${id}">${opts(map, val)}</select>`;
  const yesno = { true: 'Oui', false: 'Non' };
  function playerList(s, kind, items, label) {
    return `<div class="field" style="grid-column:1/-1">
      <span class="lab">${label} · ${items.length}</span>
      <div class="inline-add"><label for="f-${kind}" class="sr">Pseudo</label><input id="f-${kind}" type="text" placeholder="Pseudo Minecraft" autocomplete="off"><button type="button" class="btn" data-act="${kind}-add" data-id="${s.id}">Ajouter</button></div>
      <ul class="list">${items.map(p => `<li><span>${esc(p)}</span><button type="button" class="btn sm icon" data-act="${kind}-del" data-id="${s.id}" data-p="${esc(p)}" aria-label="Retirer ${esc(p)}" title="Retirer">${icon('x')}</button></li>`).join('') || '<li class="sub">Personne</li>'}</ul>
    </div>`;
  }

  function settingsHTML(s) {
    if (s.game === 'mc') {
      const p = s.props;
      if (!p) return `<div class="empty"><b>Chargement…</b></div>`;
      const num = (k, label, min, max, hint) => `<div class="field"><label for="f-${k}">${label}</label><input id="f-${k}" data-k="${k}" type="number" min="${min}" max="${max}" value="${esc(p[k])}">${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
      const pick = (k, label, map) => `<div class="field"><label for="f-${k}">${label}</label><select id="f-${k}" data-k="${k}">${opts(map, p[k])}</select></div>`;
      return `
      <form class="form" data-form="${s.id}">
        <div class="field" style="grid-column:1/-1"><label for="f-motd">MOTD</label><input id="f-motd" data-k="motd" type="text" value="${esc(p.motd)}"></div>
        ${pick('difficulty', 'Difficulté', DIFFS)}${pick('gamemode', 'Mode de jeu', GAMEMODES)}
        ${num('view-distance', 'Distance de vue (chunks)', 2, 32, 'Au-delà de 12, la RAM grimpe vite sur cette machine.')}
        ${num('simulation-distance', 'Distance de simulation', 2, 32)}
        ${num('max-players', 'Joueurs max', 1, 100)}${num('spawn-protection', 'Protection du spawn', 0, 100)}
        ${pick('pvp', 'PvP', yesno)}${pick('white-list', 'Whitelist active', yesno)}${pick('allow-flight', 'Vol autorisé', yesno)}
        <div class="form-foot"><span class="sub">Appliqué au prochain redémarrage.</span><button type="submit" class="btn primary">${icon('save')}Enregistrer</button></div>
        ${playerList(s, 'wl', s.wl || [], 'Whitelist')}
        ${playerList(s, 'op', s.ops || [], 'Opérateurs')}
      </form>`;
    }
    if (s.game === 'ac') {
      if (!acCfg || !acCars) return `<div class="empty"><b>Chargement…</b></div>`;
      const S = acCfg.SERVER, chosen = (S.CARS || '').split(';').filter(Boolean);
      const names = Object.fromEntries((acMeta || []).map(c => [c.id, c.name]));
      return `
      <form class="form" data-form="${s.id}">
        <div class="field"><label for="f-name">Nom du serveur</label><input id="f-name" type="text" value="${esc(S.NAME)}"></div>
        <div class="field"><label for="f-pass">Mot de passe</label><input id="f-pass" type="password" placeholder="Aucun" value="${esc(S.PASSWORD)}"></div>
        <div class="field"><label for="f-slots">Places sur la grille</label><input id="f-slots" type="number" min="1" max="32" value="${esc(S.MAX_CLIENTS)}"></div>
        <div class="field"><label for="f-sun">Angle du soleil</label><input id="f-sun" type="number" min="-80" max="80" value="${esc(S.SUN_ANGLE)}"><span class="hint">Négatif le matin, positif l'après-midi.</span></div>
        <div class="section-title">Circuit</div>
        <div class="field"><label for="f-track">Piste</label>${sel('f-track', Object.fromEntries(acCfg.tracks.map(t => [t, t])), S.TRACK)}</div>
        <div class="field"><label for="f-tcfg">Configuration</label>${sel('f-tcfg', Object.fromEntries(['', ...(acCfg.trackConfigs || [])].map(c => [c, c || 'Par défaut'])), S.CONFIG_TRACK || '')}</div>
        <img class="track-prev" id="track-prev" alt="" src="/api/ac/track-image/${encodeURIComponent(S.TRACK)}/${encodeURIComponent(S.CONFIG_TRACK || '_')}/preview.png" onerror="this.hidden=true">
        <div class="field" style="grid-column:1/-1"><span class="lab">Voitures autorisées · <span id="car-n">${chosen.length}</span></span>
          <input id="f-carq" type="text" placeholder="Filtrer les voitures" autocomplete="off">
          <div class="cars">${acCars.map(c => `<label class="check" data-car="${esc((names[c] || c).toLowerCase() + ' ' + c)}"><input type="checkbox" name="car" value="${esc(c)}" ${chosen.includes(c) ? 'checked' : ''}><span>${esc(names[c] || c)}</span></label>`).join('')}</div></div>
        <div class="form-foot"><span class="sub">Redémarre Assetto Corsa pour appliquer.</span><button type="button" class="btn" data-act="ac-restart">${icon('restart')}Redémarrer</button><button type="submit" class="btn primary">${icon('save')}Enregistrer</button></div>
        <div class="section-title">Ajouter du contenu</div>
        <div class="field"><label for="f-up-car">Voiture (.zip)</label><input id="f-up-car" type="file" accept=".zip" data-upload="car"></div>
        <div class="field"><label for="f-up-track">Circuit (.zip)</label><input id="f-up-track" type="file" accept=".zip" data-upload="track"></div>
      </form>`;
    }
    const c = s.cfg, soonFoot = `<div class="form-foot"><span class="sub">Backend à venir : rien n'est encore enregistré.</span><button type="submit" class="btn primary" disabled>${icon('save')}Enregistrer</button></div>`;
    if (s.game === 'lmu') return `
      <form class="form" data-form="${s.id}">
        <div class="field"><label for="f-track">Circuit</label>${sel('f-track', TRACKS_LMU, c.track)}</div>
        <div class="field"><label for="f-dur">Durée de course (min)</label><input id="f-dur" type="number" min="10" step="5" value="${c.duration}"></div>
        <div class="field"><label for="f-tm">Accélération du temps</label>${sel('f-tm', { 1: '×1', 2: '×2', 4: '×4', 10: '×10' }, c.timemult)}</div>
        <div class="field"><label for="f-fuel">Consommation</label>${sel('f-fuel', { 0: 'Désactivée', 1: 'Normale', 2: '×2' }, c.fuel)}</div>
        <div class="field"><label for="f-pass">Mot de passe</label><input id="f-pass" type="password"></div>
        <div class="field" style="grid-column:1/-1"><span class="lab">Catégories</span><div class="checks">${['Hypercar', 'LMP2', 'LMGT3'].map(v => `<label class="check"><input type="checkbox" ${c.classes.includes(v) ? 'checked' : ''}>${v}</label>`).join('')}</div></div>
        ${soonFoot}
      </form>`;
    return `
      <form class="form" data-form="${s.id}">
        <div class="field"><label for="f-map">Carte</label>${sel('f-map', MAPS_FS, c.map)}</div>
        <div class="field"><label for="f-slot">Sauvegarde</label>${sel('f-slot', { 1: 'Emplacement 1', 2: 'Emplacement 2', 3: 'Emplacement 3' }, c.slot)}</div>
        <div class="field"><label for="f-diff">Difficulté économique</label>${sel('f-diff', { easy: 'Facile', normal: 'Normale', hard: 'Difficile' }, c.difficulty)}</div>
        <div class="field"><label for="f-max">Joueurs max</label><input id="f-max" type="number" min="1" max="16" value="${c.max}"><span class="hint">16 au maximum sur FS17.</span></div>
        <div class="field"><label for="f-pass">Mot de passe admin</label><input id="f-pass" type="password" placeholder="Obligatoire"></div>
        ${soonFoot}
      </form>`;
  }

  function detail(s) {
    const tabs = [['console', 'term', 'Console'], ['players', 'users', `Joueurs · ${playersOf(s)}`], ['settings', 'sliders', 'Réglages']];
    const body = tab === 'console' ? consoleHTML(s) : tab === 'players' ? `<section class="panel">${playersHTML(s)}</section>` : `<section class="panel"><div class="panel-b">${settingsHTML(s)}</div></section>`;
    return `
      <div class="detail-head">
        <button type="button" class="btn icon" data-go="overview" aria-label="Retour à la vue d'ensemble" title="Retour">${icon('back')}</button>
        ${plate(s, true)}
        <div class="title"><h1>${esc(s.name)}</h1><div class="meta">${s.soon ? '<span class="soon">Backend à venir</span>' : `<span class="state"><span class="dot ${s.state}"></span>${STATE_LABEL[s.state]}</span>`}<span>${esc(s.ver)}</span><span>Port ${esc(portOf(s))}</span></div></div>
        <div class="actions">${actionButtons(s)}</div>
      </div>
      <section class="panel"><dl class="kv">
        <div><dt>Session</dt><dd>${esc(sessionOf(s))}</dd></div>
        <div><dt>Joueurs</dt><dd>${playersOf(s)} / ${esc(maxOf(s))}</dd></div>
        <div><dt>Mémoire</dt><dd>${s.ramNow ? fmt(s.ramNow / GB) + ' Go' : s.soon ? '—' : `~${fmt(s.ram)} Go estimés`}</dd></div>
        <div><dt>Mode</dt><dd>${s.soon ? '—' : (s.game === 'ac') === (sys.mode === 'assetto') ? 'Actif' : 'Inactif (bascule)'}</dd></div>
        <div><dt>Adresse</dt><dd>${esc(location.hostname)}:${esc(portOf(s))}</dd></div>
      </dl></section>
      ${tapeHTML()}
      <div class="tabs" role="tablist">${tabs.map(([id, ic, l]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${icon(ic)}${l}</button>`).join('')}</div>
      <div role="tabpanel">${body}</div>`;
  }

  function journalView() {
    return `
      <header class="topbar"><div><h1>Journal</h1><div class="meta"><span>Actions du panel et changements d'état, du plus récent au plus ancien</span></div></div>
        ${journal.length ? '<button type="button" class="btn sm" data-act="journal-clear">Vider</button>' : ''}</header>
      <section class="panel">${journal.length ? `<div class="table-wrap"><table>
        <thead><tr><th scope="col">Heure</th><th scope="col">Serveur</th><th scope="col">Message</th></tr></thead>
        <tbody>${journal.map(l => { const s = byId(l.id); return `<tr><td class="sub" style="font-family:var(--f-mono)">${esc(l.t)}</td><td>${s ? `<div class="entry">${plate(s)}<span>${esc(s.name)}</span></div>` : '<span class="sub">Panel</span>'}</td><td style="color:${l.cls === 'w' ? 'var(--warn)' : l.cls === 'e' ? 'var(--bad)' : 'inherit'}">${esc(l.msg)}</td></tr>`; }).join('')}</tbody>
      </table></div>` : '<div class="empty"><b>Rien pour l\'instant</b>Les démarrages, arrêts et bascules apparaîtront ici.</div>'}</section>`;
  }

  function settingsView() {
    return `
      <header class="topbar"><div><h1>Réglages du panel</h1></div></header>
      <section class="panel"><div class="panel-b">
        <form class="form" data-panel-settings>
          <div class="field"><label for="p-rate">Prix du kWh (€)</label><input id="p-rate" type="number" step="0.001" min="0" placeholder="0,206"><span class="hint">Sert au coût estimé de la vue d'ensemble.</span></div>
          <div class="field"><label for="p-pass">Nouveau mot de passe</label><input id="p-pass" type="password" minlength="6" autocomplete="new-password" placeholder="6 caractères minimum"></div>
          <div class="form-foot"><button type="submit" class="btn primary">${icon('save')}Enregistrer</button></div>
        </form>
      </div></section>
      <section class="panel"><div class="panel-h"><h2>Système</h2></div><div class="panel-b"><pre class="log" style="height:auto;margin:0" id="sysinfo">Chargement…</pre></div></section>`;
  }

  /* ---------- Chargements ---------- */
  async function loadMc(s) {
    const [c, w, o] = await Promise.allSettled([api(`/api/mc/${s.id}/config`), api(`/api/mc/${s.id}/whitelist`), api(`/api/mc/${s.id}/ops`)]);
    if (c.status === 'fulfilled') s.props = c.value.props;
    if (w.status === 'fulfilled') s.wl = w.value.whitelist.map(x => x.name);
    if (o.status === 'fulfilled') s.ops = o.value.ops.map(x => x.name);
  }
  async function loadMcPlayers(s) {
    try {
      const r = await api(`/api/servers/${s.id}/command`, { command: 'list' });
      const m = String(r.response).split(':').slice(1).join(':').trim();
      s.players = m ? m.split(/,\s*/).map(p => p.replace(/§./g, '').trim()).filter(Boolean) : [];
    } catch (_) { s.players = []; }
  }
  async function loadAc() {
    const d = await api('/api/ac/config');
    acCfg = d.serverCfg; acCfg.tracks = d.tracks; acCars = d.cars;
    acCfg.trackConfigs = (await api('/api/ac/track-configs/' + encodeURIComponent(acCfg.SERVER.TRACK)).catch(() => ({ configs: [] }))).configs;
    if (!acMeta) acMeta = (await api('/api/ac/cars-meta').catch(() => ({ cars: [] }))).cars;
  }

  /* ---------- Graphiques ---------- */
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function drawChart(id, data, { min, max, unit, threshold, color, ticks = 4, from }) {
    const cv = document.getElementById(id); if (!cv) return;
    const r = cv.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const L = 34, R = 6, T = 8, B = 20, W = r.width - L - R, H = r.height - T - B;
    const x = i => L + i / Math.max(data.length - 1, 1) * W, y = v => T + (1 - (Math.min(Math.max(v, min), max) - min) / (max - min)) * H;
    ctx.font = '11px Archivo, Arial, sans-serif'; ctx.textBaseline = 'middle';
    for (let t = 0; t <= ticks; t++) {
      const v = min + (max - min) * t / ticks;
      ctx.strokeStyle = css('--line'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, Math.round(y(v)) + .5); ctx.lineTo(L + W, Math.round(y(v)) + .5); ctx.stroke();
      ctx.fillStyle = css('--faint'); ctx.textAlign = 'right'; ctx.fillText(Math.round(v) + unit, L - 6, y(v));
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = css('--faint');
    ctx.fillText(from, L, r.height - 4); ctx.textAlign = 'right'; ctx.fillText('maintenant', L + W, r.height - 4);
    if (threshold) { ctx.strokeStyle = css('--warn'); ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(L, y(threshold)); ctx.lineTo(L + W, y(threshold)); ctx.stroke(); ctx.setLineDash([]); }
    if (data.length < 2) return;
    const col = css(color);
    const grad = ctx.createLinearGradient(0, T, 0, T + H); grad.addColorStop(0, col + '55'); grad.addColorStop(1, col + '00');
    ctx.beginPath(); data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.lineTo(x(data.length - 1), T + H); ctx.lineTo(x(0), T + H); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); data.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x(data.length - 1), y(data.at(-1)), 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
  }
  function drawCharts() {
    const hot = sys.temp.at(-1) >= 80;
    drawChart('c-cpu', sys.cpu, { min: 0, max: 100, unit: '%', color: '--accent', from: `−${Math.round(sys.cpu.length * 10 / 60)} min` });
    drawChart('c-tmp', sys.temp, { min: 30, max: 100, ticks: 7, unit: '°', threshold: 80, color: hot ? '--warn' : '--ok', from: `−${Math.max(1, Math.round(sys.temp.length * POLL_MS / 60000))} min` });
  }

  /* ---------- Rendu ---------- */
  function render() {
    const s = byId(view);
    if (!s && !['overview', 'journal', 'settings'].includes(view)) view = 'overview';
    const a = document.activeElement, keep = a && a.id && a.tagName === 'INPUT' ? { id: a.id, v: a.value } : null;
    const log = $('#log'), stick = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    renderNav();
    $('#main').innerHTML = view === 'overview' ? overview() : view === 'journal' ? journalView() : view === 'settings' ? settingsView() : detail(s);
    drawCharts();
    const nl = $('#log'); if (nl && stick) nl.scrollTop = nl.scrollHeight;
    if (keep) { const el = document.getElementById(keep.id); if (el && !el.disabled) { el.value = keep.v; el.focus(); } }
  }

  function toast(text, kind = 'ok') {
    const t = document.createElement('div'); t.className = 'toast ' + kind;
    t.innerHTML = icon(kind === 'bad' ? 'alert' : 'check') + `<span>${esc(text)}</span>`;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4000);
  }

  async function go(v) {
    view = v; tab = 'console'; ghost = null; tapeMsg = { text: '', bad: false };
    history.replaceState(null, '', '#' + v);
    render(); window.scrollTo(0, 0);
    const s = byId(v);
    if (s && !s.soon) subscribeLogs(s);
    if (s && s.game === 'mc' && !s.props) { await loadMc(s); if (view === v) render(); }
    if (v === 'settings') api('/api/sysinfo').then(d => { const el = $('#sysinfo'); if (el) el.textContent = d.info; }).catch(() => {});
  }

  async function openTab(t) {
    tab = t; render();
    const s = byId(view); if (!s || s.soon) return;
    try {
      if (t === 'settings' && s.game === 'mc') await loadMc(s);
      if (t === 'settings' && s.game === 'ac') await loadAc();
      if (t === 'players' && s.game === 'mc' && s.state === 'running') await loadMcPlayers(s);
    } catch (e) { toast(e.message, 'bad'); }
    if (tab === t && byId(view) === s) render();
  }

  /* ---------- Logs en direct ---------- */
  let ws = null;
  function connectWs() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => { const s = byId(view); if (s && !s.soon) subscribeLogs(s); };
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data); const s = byId(ws.cur);
      if (d.type !== 'log' || !s) return;
      const lines = d.data.split('\n').filter(Boolean).map(l => [lineClass(l), '', l]);
      s.logs.push(...lines); if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
      const log = $('#log');
      if (log && view === s.id && tab === 'console') {
        const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.querySelector('p.t:only-child')?.remove();
        log.insertAdjacentHTML('beforeend', lines.map(([c, , m]) => `<p class="${c}">${esc(m)}</p>`).join(''));
        if (stick) log.scrollTop = log.scrollHeight;
      }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }
  function subscribeLogs(s) {
    if (!ws || ws.readyState !== 1 || ws.cur === s.id) return;
    ws.cur = s.id; s.logs = [];
    ws.send(JSON.stringify({ type: 'subscribe-logs', server: s.id }));
  }

  /* ---------- Actions ---------- */
  function setPending(list, state) { list.forEach(s => { s.pending = { state, until: Date.now() + 90000 }; s.state = state; }); }

  async function doSwitch(target) {
    const toAc = target === 'assetto';
    const msg = toAc ? 'Arrêter Fabric et Paper puis démarrer Assetto Corsa ? Les joueurs Minecraft seront déconnectés.' : 'Arrêter Assetto Corsa puis relancer Fabric et Paper ? Les pilotes seront déconnectés.';
    if (!confirm(msg)) return;
    try {
      await api(`/api/ac/switch-to-${target}`, {});
      setPending(servers.filter(s => s.game === 'ac' && !toAc), 'stopping'); setPending(servers.filter(s => s.game === 'mc' && toAc), 'stopping');
      setPending(servers.filter(s => toAc ? s.game === 'ac' : s.game === 'mc'), 'starting');
      journalAdd(null, 'w', `Bascule vers ${toAc ? 'Assetto Corsa' : 'Minecraft'}`);
      tapeMsg = { text: 'Bascule en cours, environ 15 secondes…', bad: false }; toast('Bascule lancée');
    } catch (e) { toast(e.message, 'bad'); }
    render();
  }

  async function serverAction(s, action) {
    if (s.game === 'ac') {
      if (action === 'start') return doSwitch('assetto');
      if (action === 'stop') return doSwitch('minecraft');
    }
    if (s.game === 'mc' && action === 'start' && sys.mode === 'assetto') return doSwitch('minecraft');
    try {
      if (s.game === 'ac') await api('/api/ac/restart', {});
      else await api(`/api/servers/${s.id}/action`, { action });
      setPending([s], action === 'stop' ? 'stopping' : 'starting');
      journalAdd(s, action === 'stop' ? '' : 'o', { start: 'Démarrage demandé', stop: 'Arrêt demandé', restart: 'Redémarrage demandé' }[action]);
      toast(`${s.name} : ${{ start: 'démarrage', stop: 'arrêt', restart: 'redémarrage' }[action]} en cours`);
    } catch (e) { journalAdd(s, 'e', e.message); toast(e.message, 'bad'); }
    ghost = null; render();
  }

  async function listEdit(s, kind, add, player) {
    if (!/^[A-Za-z0-9_]{2,16}$/.test(player)) { toast('Pseudo invalide : 2 à 16 caractères, lettres, chiffres ou _', 'bad'); return; }
    const path = kind === 'wl' ? 'whitelist' : 'ops';
    try {
      await api(`/api/mc/${s.id}/${path}/${add ? 'add' : 'remove'}`, { player });
      journalAdd(s, '', `${player} ${add ? 'ajouté à' : 'retiré de'} ${kind === 'wl' ? 'la whitelist' : 'la liste des ops'}`);
      toast(`${player} ${add ? 'ajouté' : 'retiré'}`);
      await loadMc(s);
    } catch (e) { toast(e.message, 'bad'); }
    render();
  }

  document.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go); return; }
    const tb = e.target.closest('[data-tab]'); if (tb) { openTab(tb.dataset.tab); return; }
    const th = e.target.closest('[data-theme-set]');
    if (th) {
      const v = th.dataset.themeSet;
      if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v);
      document.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', b === th));
      try { localStorage.setItem('gp-theme', v); } catch (_) {}
      drawCharts(); return;
    }
    const chip = e.target.closest('[data-chip]'); if (chip) { const i = $('#f-cmd'); i.value = chip.dataset.chip; i.focus(); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    const s = byId(a.dataset.id);
    switch (a.dataset.act) {
      case 'start': case 'stop': case 'restart': serverAction(s, a.dataset.act); break;
      case 'switch': doSwitch(a.dataset.target); break;
      case 'kick':
        try { await api(`/api/servers/${s.id}/command`, { command: 'kick ' + a.dataset.p }); journalAdd(s, 'w', `${a.dataset.p} expulsé`); toast(`${a.dataset.p} expulsé`); await loadMcPlayers(s); render(); }
        catch (err) { toast(err.message, 'bad'); }
        break;
      case 'wl-add': case 'op-add': { const k = a.dataset.act.slice(0, 2); listEdit(s, k, true, $('#f-' + k).value.trim()); break; }
      case 'wl-del': case 'op-del': listEdit(s, a.dataset.act.slice(0, 2), false, a.dataset.p); break;
      case 'ac-restart': serverAction(byId('assetto'), 'restart'); break;
      case 'journal-clear': journal = []; try { localStorage.removeItem('gp-journal'); } catch (_) {} render(); break;
      case 'logout': await fetch('/api/logout', { method: 'POST' }); location.reload(); break;
    }
  });

  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      if (f.id === 'login-form') {
        const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#l-user').value, password: $('#l-pass').value }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { $('#l-err').textContent = d.error || 'Connexion impossible'; return; }
        start(); return;
      }
      if (f.dataset.cmd) {
        const s = byId(f.dataset.cmd), i = $('#f-cmd'), c = i.value.trim(); if (!c) return;
        s.logs.push(['u', now(), '> ' + c]); i.value = '';
        try { const r = await api(`/api/servers/${s.id}/command`, { command: c }); s.logs.push(['', now(), String(r.response || 'OK').replace(/§./g, '')]); }
        catch (err) { s.logs.push(['e', now(), err.message]); }
        render(); $('#f-cmd').focus(); return;
      }
      if (f.hasAttribute('data-panel-settings')) {
        const rate = $('#p-rate').value, pwd = $('#p-pass').value;
        if (pwd && pwd.length < 6) { toast('Mot de passe : 6 caractères minimum', 'bad'); return; }
        await api('/api/settings', { ratePerKwh: rate || undefined, newPassword: pwd || undefined });
        toast('Réglages enregistrés'); f.reset(); return;
      }
      if (f.dataset.form) {
        const s = byId(f.dataset.form);
        if (s.game === 'mc') {
          const body = {}; f.querySelectorAll('[data-k]').forEach(el => { body[el.dataset.k] = el.value; });
          await api(`/api/mc/${s.id}/config`, body); await loadMc(s);
        } else if (s.game === 'ac') {
          const cars = [...f.querySelectorAll('[name="car"]:checked')].map(x => x.value);
          if (!cars.length) { toast('Choisis au moins une voiture', 'bad'); return; }
          await api('/api/ac/config', { name: $('#f-name').value, password: $('#f-pass').value, track: $('#f-track').value, trackConfig: $('#f-tcfg').value, cars, maxClients: $('#f-slots').value, sunAngle: $('#f-sun').value });
          await loadAc();
        }
        journalAdd(s, 'o', 'Réglages enregistrés'); toast(`Réglages de ${s.name} enregistrés`); render();
      }
    } catch (err) { toast(err.message, 'bad'); }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'f-carq') {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('[data-car]').forEach(l => { l.hidden = !l.dataset.car.includes(q); });
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.name === 'car') $('#car-n').textContent = document.querySelectorAll('[name="car"]:checked').length;
    if (t.id === 'f-track' && view === 'assetto') {
      const { configs } = await api('/api/ac/track-configs/' + encodeURIComponent(t.value)).catch(() => ({ configs: [] }));
      $('#f-tcfg').innerHTML = opts(Object.fromEntries(['', ...configs].map(c => [c, c || 'Par défaut'])), '');
    }
    if ((t.id === 'f-track' || t.id === 'f-tcfg') && view === 'assetto') {
      const img = $('#track-prev'); img.hidden = false;
      img.src = `/api/ac/track-image/${encodeURIComponent($('#f-track').value)}/${encodeURIComponent($('#f-tcfg').value || '_')}/preview.png`;
    }
    if (t.dataset.upload && t.files.length) {
      const fd = new FormData(); fd.append('mod', t.files[0]);
      toast(`Envoi de ${t.files[0].name}…`);
      try {
        const r = await fetch('/api/ac/upload/' + t.dataset.upload, { method: 'POST', body: fd });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Envoi impossible');
        journalAdd(byId('assetto'), 'o', `${t.files[0].name} installé`); toast(d.message || 'Installé');
        await loadAc(); render();
      } catch (err) { toast(err.message, 'bad'); t.value = ''; }
    }
  });

  const setGhost = (id) => { if (id !== ghost) { ghost = id; refreshTape(); } };
  document.addEventListener('pointerover', (e) => { const a = e.target.closest('[data-act="start"]'); setGhost(a ? a.dataset.id : null); });
  document.addEventListener('focusin', (e) => { const a = e.target.closest('[data-act="start"]'); setGhost(a ? a.dataset.id : null); });
  window.addEventListener('resize', drawCharts);

  /* ---------- Démarrage ---------- */
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#l-user').focus(); }
  let started = false;
  async function start() {
    $('#login').hidden = true; $('#app').hidden = false; $('#host').textContent = location.hostname;
    if (started) return; started = true;
    const h = location.hash.slice(1);
    if (byId(h) || h === 'journal' || h === 'settings') view = h;
    await Promise.allSettled([loadMc(byId('fabric')), loadMc(byId('paper')), loadAc()]);
    connectWs(); await poll(); go(view);
    setInterval(() => poll().catch(() => {}), POLL_MS);
    document.fonts && document.fonts.ready.then(drawCharts);
  }

  try {
    const t = localStorage.getItem('gp-theme');
    if (t && t !== 'system') { document.documentElement.setAttribute('data-theme', t); document.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeSet === t)); }
  } catch (_) {}
  fetch('/api/stats').then(r => r.ok ? start() : showLogin()).catch(showLogin);
})();
