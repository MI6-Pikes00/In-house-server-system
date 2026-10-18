// Panel Garage Pikes : vue d'ensemble, détail par serveur, création, fichiers, journal. Branché sur l'API de server.js.
(() => {
  const GB = 1073741824, KB = 1024, MB = 1048576;
  const POLL_MS = 5000;
  const icon = (id) => `<svg class="i" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => new Date().toLocaleTimeString('fr-FR', { hour12: false });
  const fmt = (n, d = 1) => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const opts = (map, val) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const fmtSize = (b) => b < KB ? `${b} o` : b < MB ? `${fmt(b / KB)} Ko` : b < GB ? `${fmt(b / MB)} Mo` : `${fmt(b / GB, 2)} Go`;

  const STATE_LABEL = { running: 'En ligne', sleeping: 'En veille', starting: 'Démarrage', stopping: 'Arrêt en cours', stopped: 'Arrêté', installing: 'Installation', error: 'Erreur', absent: 'Non installé' };
  const GAMEMODES = { survival: 'Survie', creative: 'Créatif', adventure: 'Aventure', spectator: 'Spectateur' };
  const DIFFS = { peaceful: 'Paisible', easy: 'Facile', normal: 'Normale', hard: 'Difficile' };
  const TRACKS_LMU = { lemans: 'Circuit de la Sarthe', spa: 'Spa-Francorchamps', monza: 'Monza', fuji: 'Fuji Speedway', sebring: 'Sebring', portimao: 'Portimão', bahrain: 'Bahrain', imola: 'Imola', cota: 'Circuit of the Americas', qatar: 'Lusail' };
  const MAPS_FS = { goldcrest: 'Goldcrest Valley', sosnovka: 'Sosnovka' };
  const GAMES = {
    mc: { label: 'Minecraft', desc: 'Paper ou Fabric, téléchargé automatiquement', ram: 4, min: 2, max: 10, port: 25565, slots: 20, colour: 'paper', code: 'MC' },
    ac: { label: 'Assetto Corsa', desc: 'Serveur dédié via SteamCMD', ram: 1.5, min: 1, max: 4, port: 9600, slots: 24, colour: 'ac', code: 'AC' },
    lmu: { label: 'Le Mans Ultimate', desc: 'Serveur dédié sous Wine, gourmand', ram: 4.5, min: 4, max: 8, port: 54297, slots: 20, colour: 'lmu', code: 'LM' },
    fs: { label: 'Farming Simulator 17', desc: 'Serveur dédié sous Wine, 16 joueurs max', ram: 3, min: 2, max: 6, port: 10823, slots: 6, colour: 'fs', code: 'FS' }
  };
  const COLOURS = { paper: 'Jaune', fabric: 'Violet', ac: 'Bleu', lmu: 'Cyan', fs: 'Orange', pink: 'Rose' };
  const LOADERS = { paper: 'Paper', fabric: 'Fabric' };
  const VERSIONS = { '1.21.4': '1.21.4', '1.21.1': '1.21.1', '1.20.1': '1.20.1', '1.19.4': '1.19.4' };
  // Jeux toujours visibles, même avant leur installation.
  const PLACEHOLDERS = [
    { id: 'lmu', type: 'lmu', placeholder: true, name: 'Le Mans Ultimate', ver: 'Pas encore installé', no: 51, colour: 'lmu', ram: 4.5 },
    { id: 'fs', type: 'fs', placeholder: true, name: 'Farming Simulator 17', ver: 'Pas encore installé', no: 17, colour: 'fs', ram: 3 }
  ];

  let servers = [];
  const byId = (id) => servers.find(s => s.id === id);
  const sys = { stats: null, cpu: [], temp: [], mode: 'minecraft' };
  let gamesInfo = {}, acCars = null, acMeta = null, acTracks = null;
  let view = 'overview', tab = 'console', ghost = null, tapeMsg = { text: '', bad: false }, lastSig = '';
  let draft = null, pendingDelete = null, pendingFileDel = null, newFolder = false, uploads = [];
  let journal = [];
  try { journal = JSON.parse(localStorage.getItem('gp-journal')) || []; } catch (_) {}

  /* ---------- API ---------- */
  async function api(url, body, method) {
    const r = await fetch(url, body === undefined && !method ? {} : { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (r.status === 401) { showLogin(); throw new Error('Session expirée'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Erreur ' + r.status);
    return d;
  }

  function journalAdd(s, cls, msg) {
    journal.unshift({ t: now(), id: s ? s.id : null, name: s ? s.name : null, cls, msg });
    journal.length = Math.min(journal.length, 200);
    try { localStorage.setItem('gp-journal', JSON.stringify(journal)); } catch (_) {}
  }

  /* ---------- Registre et état ---------- */
  function syncRegistry(reg) {
    gamesInfo = reg.games || {};
    const make = (d, isCreated) => {
      const s = byId(d.id) && !!byId(d.id).placeholder === !!d.placeholder ? byId(d.id) : { logs: [], players: [], pending: null, state: 'stopped', ramNow: null, cwd: [] };
      const { players, ramNow, active, ...rest } = d;
      Object.assign(s, rest, { created: isCreated, k: 'k-' + d.colour, ink: d.colour === 'ac' ? 'light' : 'dark', game: d.type });
      if (isCreated) {
        s.active = active; s.ramNow = ramNow || null;
        if (d.type === 'mc') s.online = players; else s.players = players || [];
        if (s.install !== 'ok' && !s.pending) s.state = s.install === 'running' ? 'installing' : 'error';
      }
      return s;
    };
    const list = reg.builtin.map(b => make(b, false)).concat(reg.created.map(c => make(c, true)));
    PLACEHOLDERS.forEach(p => { if (!reg.created.some(c => c.type === p.type)) list.push(make(p, false)); });
    servers = list;
  }

  const usedGB = () => sys.stats ? sys.stats.memory.used / GB : 0;
  const totalGB = () => sys.stats ? sys.stats.memory.total / GB : 16;

  function realState(s, svc, ac) {
    if (s.placeholder) return 'absent';
    if (s.created) return s.install === 'running' ? 'installing' : s.install === 'error' ? 'error' : s.active ? 'running' : 'stopped';
    if (s.game === 'ac') return ac && ac.active ? 'running' : 'stopped';
    if (svc[s.id] !== 'online') return 'stopped';
    return s.ramNow ? 'running' : 'sleeping'; // MSH : service actif, JVM lancée à la première connexion
  }

  function applyState(s, real) {
    const p = s.pending;
    if (p && Date.now() < p.until && !(p.state === 'starting' ? real !== 'stopped' : real === 'stopped')) { s.state = p.state; return; }
    s.pending = null;
    if (s.state !== real && lastSig && !s.placeholder) journalAdd(s, real === 'error' ? 'e' : real === 'stopped' ? '' : 'o', `${s.name} : ${STATE_LABEL[real].toLowerCase()}`);
    s.state = real;
  }

  async function poll() {
    const [reg, st, svc, ac, hist] = await Promise.allSettled([api('/api/registry'), api('/api/stats'), api('/api/servers'), api('/api/ac/status'), api('/api/history')]);
    if (reg.status === 'fulfilled') syncRegistry(reg.value);
    if (st.status === 'fulfilled') {
      const d = st.value; sys.stats = d; sys.mode = d.mode;
      for (const id of ['fabric', 'paper']) { const s = byId(id), x = d.servers[id] || {}; if (s) { s.ramNow = x.ram || null; s.online = x.players || null; } }
    }
    const a = byId('assetto');
    if (ac.status === 'fulfilled' && a) { a.ramNow = ac.value.ram || null; a.players = ac.value.players || []; }
    if (hist.status === 'fulfilled') {
      const every5 = (arr) => (arr || []).filter((_, i, all) => (all.length - 1 - i) % 5 === 0);
      sys.cpu = every5(hist.value.cpu);
      sys.temp = every5(hist.value.temp).filter(v => v != null);
    }
    const svcVal = svc.status === 'fulfilled' ? svc.value : {};
    servers.forEach(s => applyState(s, realState(s, svcVal, ac.status === 'fulfilled' ? ac.value : null)));
    const s = byId(view);
    if (s && s.game === 'mc' && tab === 'players' && s.state === 'running') await loadMcPlayers(s);
    refresh();
  }

  function refresh() {
    const sig = JSON.stringify([view, tab, sys.mode, servers.map(s => [s.id, s.state, s.players.length, s.online && s.online.online, Math.round((s.ramNow || 0) / GB * 10)]), Math.round(usedGB() * 10)]);
    const changed = sig !== lastSig; lastSig = sig;
    renderNav();
    if (changed && !['settings', 'files'].includes(tab) && !['settings', 'new'].includes(view)) render();
    else updateReadouts();
  }

  /* ---------- Nav ---------- */
  const plate = (s, lg) => `<span class="plate ${lg ? 'lg' : ''} ${s.k} ${s.ink === 'light' ? 'light-ink' : ''}" aria-hidden="true">${esc(s.no)}</span>`;
  function renderNav() {
    const cur = (v) => view === v ? 'aria-current="page"' : '';
    $('#nav').innerHTML = `
      <button type="button" data-go="overview" ${cur('overview')}>${icon('grid')}<span class="lbl">Vue d'ensemble</span></button>
      <div class="nav-title">Serveurs</div>
      ${servers.map(s => `<button type="button" data-go="${s.id}" ${cur(s.id)}>${plate(s)}<span class="lbl">${esc(s.name)}</span><span class="dot ${s.state}" title="${STATE_LABEL[s.state]}"></span></button>`).join('')}
      <button type="button" class="add" data-go="new" ${cur('new')}>${icon('plus')}<span class="lbl">Ajouter un serveur</span></button>
      <div class="nav-title">Panel</div>
      <button type="button" data-go="journal" ${cur('journal')}>${icon('log')}<span class="lbl">Journal</span></button>
      <button type="button" data-go="settings" ${cur('settings')}>${icon('gear')}<span class="lbl">Réglages du panel</span></button>`;
  }

  /* ---------- Bande mémoire ---------- */
  function draftGhost() {
    if (view !== 'new' || !draft) return null;
    return { name: draft.name || defaultName(draft), no: draft.no || '?', ram: draft.ram, k: 'k-' + draft.colour, game: draft.type, isDraft: true };
  }
  function tapeHTML() {
    const TOTAL = totalGB(), used = usedGB();
    const up = servers.filter(s => s.ramNow);
    const sysRam = Math.max(used - up.reduce((a, s) => a + s.ramNow / GB, 0), 0);
    const g = ghost ? byId(ghost) : draftGhost();
    // La bascule libère la mémoire de l'autre famille (Minecraft d'origine ↔ Assetto d'origine).
    const swaps = g && !g.isDraft && !g.created && (g.game === 'ac' || sys.mode === 'assetto');
    const frees = swaps ? servers.filter(x => x.ramNow && !x.created && x.game !== g.game).reduce((a, x) => a + x.ramNow / GB, 0) : 0;
    const free = TOTAL - used + frees;
    const over = g && g.ram > free;
    const segs = [`<div class="seg sys" style="flex:0 0 ${sysRam / TOTAL * 100}%" title="Système ${fmt(sysRam)} Go">Système</div>`]
      .concat(up.map(s => `<div class="seg ${s.ink === 'light' ? 'light-ink' : ''}" style="--c:var(--c-${s.k.slice(2)});flex:0 0 ${s.ramNow / GB / TOTAL * 100}%" title="${esc(s.name)} ${fmt(s.ramNow / GB)} Go"><b>${esc(s.no)}</b><span class="gb">${fmt(s.ramNow / GB)} Go</span></div>`));
    if (g) segs.push(`<div class="seg ghost ${over ? 'over' : ''}" style="--c:var(--c-${g.k.slice(2)});flex:0 0 ${Math.min(g.ram, Math.max(TOTAL - used, .4)) / TOTAL * 100}%"><b>${esc(g.no)}</b><span class="gb">+${fmt(g.ram)} Go</span></div>`);
    let msg = tapeMsg.text, bad = tapeMsg.bad;
    if (g) {
      msg = g.isDraft
        ? (over ? `Ce serveur demandera ${fmt(g.ram)} Go au démarrage, il n'en reste que ${fmt(free)}. Il pourra être créé, mais pas lancé tout de suite.` : `Une fois lancé, il prendra ${fmt(g.ram)} Go. Il restera ${fmt(free - g.ram)} Go libres.`)
        : (frees ? `La bascule libère ${fmt(frees)} Go. ` : '') + (over ? `${g.name} demande environ ${fmt(g.ram)} Go, il n'en resterait que ${fmt(free)}.` : `${g.name} prendra environ ${fmt(g.ram)} Go. Il restera ${fmt(free - g.ram)} Go libres.`);
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
  const playersOf = (s) => s.state !== 'running' ? 0 : s.game === 'mc' ? (s.online ? s.online.online : 0) : s.players.length;
  const maxOf = (s) => s.placeholder ? '—' : s.online ? s.online.max : s.game === 'mc' && s.props ? s.props['max-players'] : s.acCfg ? s.acCfg.SERVER.MAX_CLIENTS : s.slots || '—';
  const portOf = (s) => s.created ? s.port : s.game === 'mc' ? (s.props ? s.props['server-port'] : '—') : s.acCfg ? s.acCfg.SERVER.TCP_PORT : '—';
  const ramOf = (s) => s.ramNow ? `${fmt(s.ramNow / GB)} Go` : s.placeholder ? '—' : `~${fmt(s.ram)} Go`;
  function sessionOf(s) {
    if (s.placeholder) return 'Prêt à installer';
    if (s.state === 'installing') return 'Installation en cours';
    if (s.state === 'error') return s.error || 'Installation échouée';
    if (s.game === 'ac') return s.acCfg ? [s.acCfg.SERVER.TRACK, s.acCfg.SERVER.CONFIG_TRACK].filter(Boolean).join(' · ') : '—';
    if (s.game === 'lmu') return TRACKS_LMU[s.track] || '—';
    if (s.game === 'fs') return MAPS_FS[s.map] || '—';
    if (s.state === 'sleeping') return 'MSH : démarre à la première connexion';
    return s.props ? `${GAMEMODES[s.props.gamemode] || s.props.gamemode} · ${DIFFS[s.props.difficulty] || s.props.difficulty}` : '—';
  }
  const fmtUptime = (sec) => `${Math.floor(sec / 86400)} j ${Math.floor(sec % 86400 / 3600)} h`;
  const stateHTML = (s) => s.placeholder ? '<span class="soon">Non installé</span>' : `<span class="state"><span class="dot ${s.state}"></span>${STATE_LABEL[s.state]}</span>`;

  function actionButtons(s, small) {
    const sz = small ? 'sm' : '';
    if (s.placeholder) return `<button type="button" class="btn ${sz} primary" data-go="new" data-type="${s.type}">${icon('plus')}Installer</button>`;
    if (s.state === 'error') return `<button type="button" class="btn ${sz}" data-act="retry" data-id="${s.id}">${icon('restart')}Réessayer</button>`;
    if (['starting', 'stopping', 'installing'].includes(s.state)) return `<button type="button" class="btn ${sz} primary" disabled>${icon('play')}${STATE_LABEL[s.state]}…</button>`;
    if (s.state === 'running' || s.state === 'sleeping') return `
      <button type="button" class="btn ${sz} icon" data-act="restart" data-id="${s.id}" aria-label="Redémarrer ${esc(s.name)}" title="Redémarrer">${icon('restart')}</button>
      <button type="button" class="btn ${sz} danger" data-act="stop" data-id="${s.id}">${icon('stop')}Arrêter</button>`;
    return `<button type="button" class="btn ${sz} primary" data-act="start" data-id="${s.id}">${icon('play')}Démarrer</button>`;
  }

  function overview() {
    const st = sys.stats;
    const temp = st && st.temperature;
    const hot = temp != null && temp >= 80;
    const real = servers.filter(s => !s.placeholder);
    const ac = sys.mode === 'assetto';
    return `
      <header class="topbar">
        <div>
          <h1>Vue d'ensemble</h1>
          <div class="meta"><span><b>${real.filter(s => s.state === 'running').length}</b> serveurs en ligne sur ${real.length}</span><span><b>${servers.reduce((a, s) => a + playersOf(s), 0)}</b> joueurs connectés</span>${st ? `<span>Allumé depuis <b>${fmtUptime(st.uptime)}</b></span>` : ''}<span>${esc(location.hostname)}</span></div>
        </div>
      </header>
      ${hot ? `<div class="alert" role="status">${icon('alert')}<div><b>Le processeur chauffe : ${fmt(temp, 0)} °C</b><p>Au-delà de 90 °C, la machine ralentit. Arrête un serveur si ça dure.</p></div><div class="actions"><button type="button" class="btn sm" data-go="journal">Voir le journal</button></div></div>` : ''}
      <section class="panel"><div class="panel-b mode">
        <span>Mode actif : <b>${ac ? 'Assetto Corsa' : 'Minecraft'}</b> <span class="sub">· Fabric, Paper et l'Assetto d'origine ne tournent pas en même temps.</span></span>
        <button type="button" class="btn sm" data-act="switch" data-target="${ac ? 'minecraft' : 'assetto'}">${icon('swap')}Basculer vers ${ac ? 'Minecraft' : 'Assetto Corsa'}</button>
      </div></section>
      ${tapeHTML()}
      <div class="telemetry">
        <section class="panel" aria-labelledby="cpu-t"><div class="panel-h"><h2 id="cpu-t">Processeur</h2><span class="readout" id="cpu-now">${st ? fmt(st.cpu, 0) + ' %' : '—'}</span></div>
          <div class="panel-b"><div class="chart-box"><canvas id="c-cpu" aria-label="Charge processeur sur 30 minutes"></canvas></div></div></section>
        <section class="panel" aria-labelledby="tmp-t"><div class="panel-h"><h2 id="tmp-t">Température</h2><span class="readout ${hot ? 'warn' : ''}" id="tmp-now">${temp != null ? fmt(temp, 0) + ' °C' : '—'}</span></div>
          <div class="panel-b"><div class="chart-box"><canvas id="c-tmp" aria-label="Température processeur sur 30 minutes, seuil 80 degrés"></canvas></div></div></section>
        <section class="panel host" aria-labelledby="host-t"><div class="panel-h"><h2 id="host-t">Machine</h2></div>
          <div class="panel-b"><dl class="stats">
            <div><dt>Disque</dt><dd>${st ? `${fmt(st.disk.used / GB, 0)} / ${fmt(st.disk.total / GB, 0)} Go` : '—'}</dd></div>
            <div><dt>Consommation</dt><dd id="watts">${st ? st.power.watts + ' W' : '—'}</dd></div>
            <div><dt>Coût estimé / mois</dt><dd>${st ? fmt(st.power.monthlyCost, 2) + ' €' : '—'}</dd></div>
            <div><dt>Allumé depuis</dt><dd>${st ? fmtUptime(st.uptime) : '—'}</dd></div>
          </dl></div></section>
      </div>
      <section class="panel" aria-labelledby="ent-t">
        <div class="panel-h"><h2 id="ent-t">Serveurs de jeu</h2><button type="button" class="btn sm" data-go="new">${icon('plus')}Ajouter un serveur</button></div>
        <div class="table-wrap"><table class="entries">
          <thead><tr><th scope="col">Serveur</th><th scope="col">État</th><th scope="col">Session</th><th scope="col" class="num">Joueurs</th><th scope="col" class="num">Mémoire</th><th scope="col" class="num">Port</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
          <tbody>${servers.map(s => `
            <tr>
              <td class="c-ent"><div class="entry">${plate(s)}<button type="button" class="name" data-go="${s.id}"><span class="n">${esc(s.name)}</span><span class="v">${esc(s.ver || GAMES[s.game].label)}</span></button></div></td>
              <td class="c-state">${stateHTML(s)}</td>
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

  /* ---------- Détail : console et joueurs ---------- */
  const lineClass = (l) => /ERROR|ERREUR|SEVERE|Exception/i.test(l) ? 'e' : /WARN/i.test(l) ? 'w' : /Done \(|joined the game|DRIVER_CONNECTED|terminée/.test(l) ? 'o' : '';
  const CHIPS = ['list', 'tps', 'save-all', 'whitelist list', 'say Redémarrage dans 5 min'];

  function consoleHTML(s) {
    const canCmd = s.game === 'mc' && s.state === 'running';
    const ph = s.game === 'mc' ? (canCmd ? 'Tape une commande' : 'Serveur arrêté ou en veille : pas de RCON') : 'Logs seulement pour ce jeu';
    return `<div class="console">
      <div class="log" id="log" role="log" aria-label="Console ${esc(s.name)}">${s.logs.map(([c, t, m]) => `<p class="${c}">${t ? `<span class="t">${t}</span>  ` : ''}${esc(m)}</p>`).join('') || '<p class="t">En attente des logs…</p>'}</div>
      <form class="cmd" data-cmd="${s.id}"><label for="f-cmd" class="sr">Commande</label><input id="f-cmd" type="text" placeholder="${ph}" autocomplete="off" ${canCmd ? '' : 'disabled'}><button type="submit" class="btn" ${canCmd ? '' : 'disabled'}>${icon('send')}Envoyer</button></form>
      ${s.game === 'mc' ? `<div class="chips">${CHIPS.map(c => `<button type="button" class="chip" data-chip="${esc(c)}" ${canCmd ? '' : 'disabled'}>${esc(c)}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function playersHTML(s) {
    const list = s.state === 'running' ? s.players : [];
    if (!list.length) return `<div class="empty"><b>${s.state === 'running' ? 'Personne sur le serveur' : 'Serveur arrêté ou en veille'}</b>${s.state === 'running' ? (s.game === 'mc' || s.game === 'ac' ? 'Les joueurs apparaîtront ici dès leur connexion.' : 'Liste des joueurs pas encore disponible pour ce jeu.') : ''}</div>`;
    return `<div class="table-wrap"><table style="min-width:360px">
      <thead><tr><th scope="col">Joueur</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
      <tbody>${list.map(p => `<tr><td>${esc(p)}</td><td><div class="row-actions">${s.game === 'mc' ? `<button type="button" class="btn sm danger" data-act="kick" data-id="${s.id}" data-p="${esc(p)}">Expulser</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
  }

  /* ---------- Détail : réglages ---------- */
  const sel = (id, map, val) => `<select id="${id}">${opts(map, val)}</select>`;
  const yesno = { true: 'Oui', false: 'Non' };
  function playerList(s, kind, items, label) {
    return `<div class="field" style="grid-column:1/-1">
      <span class="lab">${label} · ${items.length}</span>
      <div class="inline-add"><label for="f-${kind}" class="sr">Pseudo</label><input id="f-${kind}" type="text" placeholder="Pseudo Minecraft" autocomplete="off"><button type="button" class="btn" data-act="${kind}-add" data-id="${s.id}">Ajouter</button></div>
      <ul class="list">${items.map(p => `<li><span>${esc(p)}</span><button type="button" class="btn sm icon" data-act="${kind}-del" data-id="${s.id}" data-p="${esc(p)}" aria-label="Retirer ${esc(p)}" title="Retirer">${icon('x')}</button></li>`).join('') || '<li class="sub">Personne</li>'}</ul>
    </div>`;
  }

  function licenceFields(type, prefix) {
    const info = gamesInfo[type] || {};
    if (type === 'mc') return '';
    const steam = info.steam ? `
      <div class="field"><label for="${prefix}-suser">Compte Steam</label><input id="${prefix}-suser" type="text" autocomplete="off" required></div>
      <div class="field"><label for="${prefix}-spass">Mot de passe Steam</label><input id="${prefix}-spass" type="password" autocomplete="off" required></div>
      <div class="field"><label for="${prefix}-sguard">Code Steam Guard</label><input id="${prefix}-sguard" type="text" autocomplete="one-time-code" inputmode="text" maxlength="8"><span class="hint">Celui de l'appli Steam au moment de valider.</span></div>
      <p class="hint" style="grid-column:1/-1;margin:0">Le compte doit posséder ${esc(GAMES[type].label)}. Les identifiants servent une seule fois à SteamCMD et ne sont pas enregistrés.</p>`
      : `<p class="hint" style="grid-column:1/-1;margin:0">Pas d'app Steam configurée pour ${esc(GAMES[type].label)} : après la création, dépose les fichiers du serveur dédié dans l'onglet Fichiers. Pour l'installation automatique, renseigne <code>games.${type}.steamAppId</code> dans config.json.</p>`;
    const key = type === 'fs' ? `<div class="field"><label for="${prefix}-pkey">Clé produit (facultatif)</label><input id="${prefix}-pkey" type="text" autocomplete="off"><span class="hint">Enregistrée dans licence.txt, lisible par toi seul.</span></div>` : '';
    return `<div class="section-title">Licence</div>${steam}${key}`;
  }
  const readLicence = (prefix) => {
    const v = (k) => { const el = document.getElementById(`${prefix}-${k}`); return el ? el.value.trim() : ''; };
    return { steamUser: v('suser'), steamPass: v('spass'), steamGuard: v('sguard'), productKey: v('pkey') };
  };

  function dangerZone(s) {
    if (!s.created) return '';
    const locked = ['running', 'starting', 'stopping', 'installing'].includes(s.state);
    return `<section class="panel danger-zone" aria-labelledby="dz-t"><div class="panel-b">
      <div><h2 id="dz-t">Supprimer ce serveur</h2><p class="sub">Retire #${esc(s.no)} de la liste, supprime son service et efface ${esc(s.dir)}. Impossible à annuler.</p>
      ${locked ? '<p class="hint">Arrête le serveur avant de le supprimer.</p>' : ''}</div>
      ${pendingDelete === s.id
        ? `<div class="confirm" role="group" aria-label="Confirmer la suppression"><b>Supprimer #${esc(s.no)} définitivement ?</b><button type="button" class="btn" data-act="del-cancel">Annuler</button><button type="button" class="btn danger-solid" data-act="del-yes" data-id="${s.id}">${icon('trash')}Supprimer</button></div>`
        : `<button type="button" class="btn danger" data-act="del-ask" data-id="${s.id}" ${locked ? 'disabled' : ''}>${icon('trash')}Supprimer…</button>`}
    </div></section>`;
  }

  function mcForm(s) {
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

  const trackImg = (id, cfg) => `/api/ac/track-image/${encodeURIComponent(id)}/${encodeURIComponent(cfg || '_')}/preview.png`;
  function acForm(s) {
    if (!s.acCfg || !acCars || !acTracks) return `<div class="empty"><b>Chargement…</b></div>`;
    const S = s.acCfg.SERVER, chosen = (S.CARS || '').split(';').filter(Boolean);
    const names = Object.fromEntries((acMeta || []).map(c => [c.id, c.name]));
    const cur = S.TRACK + '|' + (S.CONFIG_TRACK || '');
    return `
      <form class="form" data-form="${s.id}">
        <div class="field"><label for="f-name">Nom du serveur</label><input id="f-name" type="text" value="${esc(S.NAME)}"></div>
        <div class="field"><label for="f-pass">Mot de passe</label><input id="f-pass" type="password" placeholder="Aucun" value="${esc(S.PASSWORD)}"></div>
        <div class="field"><label for="f-slots">Places sur la grille</label><input id="f-slots" type="number" min="1" max="32" value="${esc(S.MAX_CLIENTS)}"></div>
        <div class="field"><label for="f-sun">Angle du soleil</label><input id="f-sun" type="number" min="-80" max="80" value="${esc(S.SUN_ANGLE)}"><span class="hint">Négatif le matin, positif l'après-midi.</span></div>
        <div class="field" style="grid-column:1/-1"><span class="lab">Circuit</span>
          <input id="f-trackq" type="text" placeholder="Filtrer les circuits" autocomplete="off" aria-label="Filtrer les circuits">
          <div class="gallery" role="radiogroup" aria-label="Circuit">${acTracks.map(t => { const v = t.id + '|' + (t.configs[0] || ''); return `<label class="pick tile" data-q="${esc((t.name + ' ' + t.id + ' ' + t.country).toLowerCase())}"><input type="radio" name="track" value="${esc(v)}" ${v === cur ? 'checked' : ''}><img loading="lazy" alt="" src="${trackImg(t.id, t.configs[0])}" onerror="this.style.visibility='hidden'"><b>${esc(t.name)}</b><span class="sub">${esc(t.country)} · ${esc(t.length)}</span></label>`; }).join('')}</div></div>
        <div class="field" style="grid-column:1/-1"><span class="lab">Voitures autorisées · <span id="car-n">${chosen.length}</span></span>
          <input id="f-carq" type="text" placeholder="Filtrer les voitures" autocomplete="off" aria-label="Filtrer les voitures">
          <div class="gallery">${acCars.map(c => `<label class="pick tile" data-q="${esc((names[c] || c).toLowerCase() + ' ' + c)}"><input type="checkbox" name="car" value="${esc(c)}" ${chosen.includes(c) ? 'checked' : ''}><img loading="lazy" alt="" src="/api/ac/car-image/${encodeURIComponent(c)}/preview.jpg" onerror="this.style.visibility='hidden'"><b>${esc(names[c] || c)}</b></label>`).join('')}</div></div>
        <div class="form-foot"><span class="sub">Redémarre le serveur pour appliquer.</span><button type="button" class="btn" data-act="restart" data-id="${s.id}">${icon('restart')}Redémarrer</button><button type="submit" class="btn primary">${icon('save')}Enregistrer</button></div>
        <div class="section-title">Ajouter du contenu</div>
        <div class="field"><label for="f-up-car">Voiture (.zip)</label><input id="f-up-car" type="file" accept=".zip" data-upload="car"></div>
        <div class="field"><label for="f-up-track">Circuit (.zip)</label><input id="f-up-track" type="file" accept=".zip" data-upload="track"></div>
      </form>`;
  }

  function settingsHTML(s) {
    if (s.created && s.install !== 'ok') return `
      <form class="form" data-reinstall="${s.id}">
        <div class="section-title">${s.state === 'installing' ? 'Installation en cours' : 'Installation échouée'}</div>
        <p class="sub" style="grid-column:1/-1;margin:0">${s.state === 'installing' ? 'Suis la progression dans l\'onglet Console.' : esc(s.error || 'Erreur inconnue')}</p>
        ${s.state === 'error' ? licenceFields(s.game, 'r') + `<div class="form-foot"><button type="submit" class="btn primary">${icon('restart')}Relancer l'installation</button></div>` : ''}
      </form>`;
    if (s.game === 'mc') return mcForm(s);
    if (s.game === 'ac') return acForm(s);
    return `<div class="empty"><b>Réglages dans les fichiers du serveur</b>Modifie la configuration de ${esc(GAMES[s.game].label)} depuis l'onglet Fichiers, puis redémarre.</div>`;
  }

  /* ---------- Détail : fichiers ---------- */
  const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  function filesHTML(s) {
    const path = '/' + s.cwd.join('/');
    const rel = (name) => encodeURIComponent([...s.cwd, name].join('/'));
    const items = [...(s.entries || [])].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    const mine = uploads.filter(u => u.srv === s.id);
    const crumbs = [`<button type="button" data-act="cd-to" data-id="${s.id}" data-depth="0">${esc(s.dir)}</button>`]
      .concat(s.cwd.map((p, i) => i === s.cwd.length - 1 ? `<span class="cur">${esc(p)}</span>` : `<button type="button" data-act="cd-to" data-id="${s.id}" data-depth="${i + 1}">${esc(p)}</button>`));
    return `<div class="files">
      <section class="panel dropzone" id="dropzone" data-id="${s.id}" aria-labelledby="fx-t">
        <div class="toolbar">
          <div class="crumbs" aria-label="Dossier courant"><h2 id="fx-t" class="sr">Fichiers</h2>${crumbs.join('<span aria-hidden="true">/</span>')}</div>
          <div class="row-actions">
            <button type="button" class="btn sm" data-act="mkdir">${icon('folder')}Nouveau dossier</button>
            <label class="btn sm primary" for="f-upload">${icon('upload')}Envoyer des fichiers</label>
            <input id="f-upload" type="file" multiple class="sr" data-id="${s.id}">
          </div>
        </div>
        <div class="drop-hint">${icon('upload')}<span>Glisse des fichiers ici pour les envoyer dans <b>${esc(path)}</b>.</span></div>
        ${mine.map(u => `<div class="up"><span class="fname">${icon('file')}<span>${esc(u.name)}</span></span><span class="sub" id="upt-${u.id}">${fmtSize(u.done)} / ${fmtSize(u.size)}</span><div class="bar"><i id="upb-${u.id}" style="width:${u.done / u.size * 100}%"></i></div></div>`).join('')}
        ${newFolder ? `<form class="up" data-mkdir="${s.id}"><div class="inline-add" style="grid-column:1/-1"><label for="f-dir" class="sr">Nom du dossier</label><input id="f-dir" type="text" placeholder="Nom du dossier" autocomplete="off"><button type="button" class="btn" data-act="mkdir-cancel">Annuler</button><button type="submit" class="btn primary">Créer</button></div></form>` : ''}
        <div class="table-wrap"><table class="ftable">
          <thead><tr><th scope="col">Nom</th><th scope="col" class="num">Taille</th><th scope="col">Modifié</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
          <tbody>
            ${s.cwd.length ? `<tr><td colspan="4"><div class="fname">${icon('back')}<button type="button" data-act="cd-to" data-id="${s.id}" data-depth="${s.cwd.length - 1}">Dossier parent</button></div></td></tr>` : ''}
            ${!s.entries ? '<tr><td colspan="4"><div class="empty"><b>Chargement…</b></div></td></tr>' : items.length ? items.map(c => `<tr>
              <td><div class="fname">${icon(c.dir ? 'folder' : 'file')}${c.dir ? `<button type="button" data-act="cd" data-id="${s.id}" data-name="${esc(c.name)}">${esc(c.name)}</button>` : `<a href="/api/files/${s.id}/download?path=${rel(c.name)}" download>${esc(c.name)}</a>`}</div></td>
              <td class="num sub">${c.dir ? '' : fmtSize(c.size)}</td>
              <td class="sub">${fmtDate(c.mtime)}</td>
              <td><div class="row-actions">${pendingFileDel === c.name
                ? `<button type="button" class="btn sm" data-act="fdel-cancel">Garder</button><button type="button" class="btn sm danger-solid" data-act="fdel-yes" data-id="${s.id}" data-name="${esc(c.name)}">Supprimer</button>`
                : `<button type="button" class="btn sm icon danger" data-act="fdel" data-name="${esc(c.name)}" aria-label="Supprimer ${esc(c.name)}" title="Supprimer">${icon('trash')}</button>`}</div></td></tr>`).join('')
              : `<tr><td colspan="4"><div class="empty"><b>Dossier vide</b>Glisse des fichiers ici ou utilise « Envoyer des fichiers ».</div></td></tr>`}
          </tbody></table></div>
      </section>
      <section class="panel" aria-labelledby="sftp-t">
        <div class="panel-h"><h2 id="sftp-t">Accès SFTP</h2><span class="note">port 22</span></div>
        <div class="panel-b" style="display:flex;flex-direction:column;gap:12px">
          ${[['Hôte', location.hostname], ['Dossier', s.dir]].map(([l, v], i) => `<div class="field"><span class="lab">${l}</span><div class="copyrow"><code id="cp-${i}">${esc(v)}</code><button type="button" class="btn sm icon" data-act="copy" data-target="cp-${i}" aria-label="Copier ${l.toLowerCase()}" title="Copier">${icon('copy')}</button></div></div>`).join('')}
          <p class="hint" style="margin:0">Pour les gros envois, ouvre ce dossier dans FileZilla, WinSCP ou Cyberduck avec ton compte SSH. Taille max par envoi ici : 2 Go.</p>
        </div>
      </section>
    </div>`;
  }

  function detail(s) {
    if (s.placeholder) return `
      <div class="detail-head">
        <button type="button" class="btn icon" data-go="overview" aria-label="Retour à la vue d'ensemble" title="Retour">${icon('back')}</button>
        ${plate(s, true)}<div class="title"><h1>${esc(s.name)}</h1><div class="meta"><span class="soon">Non installé</span></div></div>
        <div class="actions">${actionButtons(s)}</div>
      </div>
      <section class="panel"><div class="empty"><b>${esc(s.name)} n'est pas encore installé</b>Lance l'installation : il te faudra le compte Steam qui possède le jeu.</div></section>`;
    const tabs = [['console', 'term', 'Console'], ['players', 'users', `Joueurs · ${playersOf(s)}`], ['files', 'folder', 'Fichiers'], ['settings', 'sliders', 'Réglages']];
    const body = tab === 'console' ? consoleHTML(s) : tab === 'players' ? `<section class="panel">${playersHTML(s)}</section>` : tab === 'files' ? filesHTML(s)
      : `<div style="display:flex;flex-direction:column;gap:16px"><section class="panel"><div class="panel-b">${settingsHTML(s)}</div></section>${dangerZone(s)}</div>`;
    return `
      <div class="detail-head">
        <button type="button" class="btn icon" data-go="overview" aria-label="Retour à la vue d'ensemble" title="Retour">${icon('back')}</button>
        ${plate(s, true)}
        <div class="title"><h1>${esc(s.name)}</h1><div class="meta">${stateHTML(s)}<span>${esc(s.ver || GAMES[s.game].label)}</span><span>Port ${esc(portOf(s))}</span></div></div>
        <div class="actions">${actionButtons(s)}</div>
      </div>
      <section class="panel"><dl class="kv">
        <div><dt>Session</dt><dd>${esc(sessionOf(s))}</dd></div>
        <div><dt>Joueurs</dt><dd>${playersOf(s)} / ${esc(maxOf(s))}</dd></div>
        <div><dt>Mémoire</dt><dd>${s.ramNow ? fmt(s.ramNow / GB) + ' Go' : `~${fmt(s.ram)} Go estimés`}</dd></div>
        <div><dt>Mode</dt><dd>${s.created ? 'Indépendant' : (s.game === 'ac') === (sys.mode === 'assetto') ? 'Actif' : 'Inactif (bascule)'}</dd></div>
        <div><dt>Adresse</dt><dd>${esc(location.hostname)}:${esc(portOf(s))}</dd></div>
      </dl></section>
      ${tapeHTML()}
      <div class="tabs" role="tablist">${tabs.map(([id, ic, l]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${icon(ic)}${l}</button>`).join('')}</div>
      <div role="tabpanel">${body}</div>`;
  }

  /* ---------- Création ---------- */
  const usedPorts = () => servers.map(s => parseInt(portOf(s))).filter(Boolean);
  const nextNo = () => { for (let n = 1; n < 100; n++) if (!servers.some(s => !s.placeholder && String(s.no) === String(n))) return n; return 99; };
  const nextPort = (p) => { const used = usedPorts(); while (used.includes(p)) p++; return p; };
  const defaultName = (d) => d.type === 'mc' ? `Minecraft ${LOADERS[d.loader]}` : GAMES[d.type].label;
  function newDraft(type, keep) {
    const g = GAMES[type];
    const ph = PLACEHOLDERS.find(p => p.type === type);
    const no = keep && keep.no ? keep.no : ph && !servers.some(s => !s.placeholder && s.no === ph.no) ? ph.no : nextNo();
    return { type, name: keep ? keep.name : '', no, port: nextPort(g.port), ram: g.ram, colour: g.colour,
      loader: 'paper', version: '1.21.4', track: type === 'lmu' ? 'lemans' : (acTracks && acTracks[0] ? acTracks[0].id : 'spa'), map: 'goldcrest', slots: g.slots, startNow: keep ? keep.startNow : false, errors: {} };
  }
  const errHTML = (k) => draft.errors[k] ? `<span class="err" id="e-${k}">${esc(draft.errors[k])}</span>` : '';
  const inv = (k) => draft.errors[k] ? `aria-invalid="true" aria-describedby="e-${k}"` : '';
  function createHint() {
    const free = totalGB() - usedGB();
    if (!draft.startNow) return 'Il sera créé arrêté. Tu pourras le démarrer depuis la liste.';
    return draft.ram > free ? `Il ne reste que ${fmt(free)} Go : pense à arrêter un autre serveur.` : 'Installation puis démarrage.';
  }

  function createView() {
    const d = draft, g = GAMES[d.type];
    const acTrackMap = {}; (acTracks || []).forEach(t => { acTrackMap[t.id] = acTrackMap[t.id] || t.name; });
    const specific = d.type === 'mc' ? `
        <div class="field"><label for="n-loader">Chargeur</label>${sel('n-loader', LOADERS, d.loader)}<span class="hint">Paper pour les plugins, Fabric pour les mods.</span></div>
        <div class="field"><label for="n-version">Version</label>${sel('n-version', VERSIONS, d.version)}</div>`
      : d.type === 'ac' ? `<div class="field"><label for="n-track">Piste de départ</label>${sel('n-track', acTrackMap, d.track)}</div>`
      : d.type === 'lmu' ? `<div class="field"><label for="n-track">Circuit de départ</label>${sel('n-track', TRACKS_LMU, d.track)}</div>`
      : `<div class="field"><label for="n-map">Carte</label>${sel('n-map', MAPS_FS, d.map)}</div>`;
    const prev = { no: d.no || '?', k: 'k-' + d.colour, ink: d.colour === 'ac' ? 'light' : 'dark' };
    return `
      <div class="detail-head">
        <button type="button" class="btn icon" data-go="overview" aria-label="Retour à la vue d'ensemble" title="Retour">${icon('back')}</button>
        <div class="title"><h1>Nouveau serveur</h1><div class="meta"><span>Il sera installé dans /srv/games puis ajouté à la liste.</span></div></div>
      </div>
      ${tapeHTML()}
      <form class="panel" data-create novalidate>
        <div class="panel-b form">
          <div class="section-title">Jeu</div>
          <div class="picker" role="radiogroup" aria-label="Jeu" style="grid-column:1/-1">${Object.entries(GAMES).map(([k, v]) => `
            <label class="pick"><input type="radio" name="n-game" id="g-${k}" value="${k}" ${d.type === k ? 'checked' : ''}>
              <span class="plate k-${v.colour} ${v.colour === 'ac' ? 'light-ink' : ''}" aria-hidden="true">${v.code}</span>
              <span><b>${esc(v.label)}</b><span class="sub">${esc(v.desc)}</span></span></label>`).join('')}
          </div>

          <div class="section-title">Identité</div>
          <div class="field"><label for="n-name">Nom</label><input id="n-name" type="text" maxlength="40" placeholder="${esc(defaultName(d))}" value="${esc(d.name)}" ${inv('name')}>${errHTML('name')}</div>
          <div class="field"><label for="n-no">Numéro</label><input id="n-no" type="number" min="1" max="99" value="${d.no}" ${inv('no')}>${errHTML('no') || '<span class="hint">De 1 à 99, un seul par serveur.</span>'}</div>
          <div class="field"><span class="lab" id="l-col">Couleur de plaque</span>
            <div class="swatches" role="radiogroup" aria-labelledby="l-col">${Object.entries(COLOURS).map(([k, v]) => `<label class="swatch" style="--c:var(--c-${k})" title="${v}"><input type="radio" name="n-col" id="col-${k}" value="${k}" ${d.colour === k ? 'checked' : ''} aria-label="${v}"></label>`).join('')}</div></div>
          <div class="field"><span class="lab">Aperçu</span><div class="preview-entry">${plate(prev)}<span><b id="prev-name">${esc(d.name || defaultName(d))}</b><span class="sub" style="display:block">${esc(g.label)} · port ${d.port}</span></span></div></div>

          <div class="section-title">Partie</div>
          ${specific}
          <div class="field"><label for="n-slots">Joueurs max</label><input id="n-slots" type="number" min="1" max="${d.type === 'fs' ? 16 : 64}" value="${d.slots}"></div>

          <div class="section-title">Ressources</div>
          <div class="field" style="grid-column:span 2"><label for="n-ram">Mémoire réservée</label>
            <div class="range-row"><input id="n-ram" type="range" min="${g.min}" max="${g.max}" step="0.5" value="${d.ram}"><output for="n-ram" id="ram-out" class="readout">${fmt(d.ram)} Go</output></div>
            <span class="hint">Entre ${fmt(g.min)} et ${fmt(g.max)} Go pour ${esc(g.label)}. La barre du haut montre où il se placera.</span></div>
          <div class="field"><label for="n-port">Port</label><input id="n-port" type="number" min="1024" max="65535" value="${d.port}" ${inv('port')}>${errHTML('port') || '<span class="hint">Pense à l\'ouvrir sur la box.</span>'}</div>
          <div class="field"><span class="lab">Après l'installation</span><label class="check"><input type="checkbox" id="n-start" ${d.startNow ? 'checked' : ''}>Démarrer le serveur</label></div>

          ${licenceFields(d.type, 'n')}

          <div class="form-foot"><span class="sub" id="create-hint">${esc(createHint())}</span>
            <button type="button" class="btn" data-go="overview">Annuler</button>
            <button type="submit" class="btn primary">${icon('plus')}Créer le serveur</button></div>
        </div>
      </form>`;
  }

  function readDraft(f) {
    const v = (id) => f.querySelector('#' + id);
    draft.name = v('n-name').value.trim();
    draft.no = parseInt(v('n-no').value, 10) || '';
    draft.port = parseInt(v('n-port').value, 10) || '';
    draft.ram = parseFloat(v('n-ram').value);
    draft.slots = parseInt(v('n-slots').value, 10) || 1;
    draft.startNow = v('n-start').checked;
    if (v('n-loader')) draft.loader = v('n-loader').value;
    if (v('n-version')) draft.version = v('n-version').value;
    if (v('n-track')) draft.track = v('n-track').value;
    if (v('n-map')) draft.map = v('n-map').value;
    const col = f.querySelector('[name="n-col"]:checked'); if (col) draft.colour = col.value;
  }
  function validateDraft(lic) {
    const e = {};
    const name = draft.name || defaultName(draft);
    const real = servers.filter(s => !s.placeholder);
    if (name.length < 2) e.name = 'Donne-lui un nom d\'au moins 2 caractères.';
    else if (real.some(s => s.name.toLowerCase() === name.toLowerCase())) e.name = `« ${name} » existe déjà. Choisis un autre nom.`;
    if (!Number.isInteger(draft.no) || draft.no < 1 || draft.no > 99) e.no = 'Choisis un numéro entre 1 et 99.';
    else { const o = real.find(s => String(s.no) === String(draft.no)); if (o) e.no = `Le #${draft.no} est déjà pris par ${o.name}. Libre : #${nextNo()}.`; }
    if (!Number.isInteger(draft.port) || draft.port < 1024 || draft.port > 65535) e.port = 'Port entre 1024 et 65535.';
    else if (usedPorts().includes(draft.port)) e.port = `Déjà utilisé. Libre : ${nextPort(draft.port)}.`;
    draft.errors = e;
    if ((gamesInfo[draft.type] || {}).steam && (!lic.steamUser || !lic.steamPass)) { toast('Renseigne le compte Steam qui possède le jeu', 'bad'); return false; }
    return !Object.keys(e).length;
  }

  async function createServer(lic) {
    const d = draft;
    try {
      const { server } = await api('/api/registry', { type: d.type, name: d.name || defaultName(d), no: d.no, port: d.port, ram: d.ram, slots: d.slots, colour: d.colour, loader: d.loader, version: d.version, track: d.track, map: d.map, startNow: d.startNow, licence: lic });
      journalAdd(server, '', `Création de ${server.name} dans ${server.dir}`);
      toast(`${server.name} s'installe…`);
      draft = null;
      syncRegistry(await api('/api/registry'));
      tapeMsg = { text: `${server.name} s'installe…`, bad: false };
      await go(server.id);
    } catch (err) { toast(err.message, 'bad'); }
  }

  /* ---------- Journal et réglages du panel ---------- */
  function journalView() {
    return `
      <header class="topbar"><div><h1>Journal</h1><div class="meta"><span>Actions du panel et changements d'état, du plus récent au plus ancien</span></div></div>
        ${journal.length ? '<button type="button" class="btn sm" data-act="journal-clear">Vider</button>' : ''}</header>
      <section class="panel">${journal.length ? `<div class="table-wrap"><table>
        <thead><tr><th scope="col">Heure</th><th scope="col">Serveur</th><th scope="col">Message</th></tr></thead>
        <tbody>${journal.map(l => { const s = byId(l.id); return `<tr><td class="sub" style="font-family:var(--f-mono)">${esc(l.t)}</td><td>${s ? `<div class="entry">${plate(s)}<span>${esc(s.name)}</span></div>` : `<span class="sub">${esc(l.name || 'Panel')}</span>`}</td><td style="color:${l.cls === 'w' ? 'var(--warn)' : l.cls === 'e' ? 'var(--bad)' : 'inherit'}">${esc(l.msg)}</td></tr>`; }).join('')}</tbody>
      </table></div>` : '<div class="empty"><b>Rien pour l\'instant</b>Les démarrages, arrêts, créations et bascules apparaîtront ici.</div>'}</section>`;
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
  async function loadAc(s) {
    const d = await api('/api/ac/config' + (s.created ? '?id=' + encodeURIComponent(s.id) : ''));
    s.acCfg = d.serverCfg; acCars = d.cars;
    if (!acMeta) acMeta = (await api('/api/ac/cars-meta').catch(() => ({ cars: [] }))).cars;
    if (!acTracks) acTracks = (await api('/api/ac/tracks-meta').catch(() => ({ tracks: [] }))).tracks;
  }
  async function loadFiles(s) {
    s.entries = null;
    try { s.entries = (await api(`/api/files/${s.id}?path=${encodeURIComponent(s.cwd.join('/'))}`)).entries; }
    catch (e) { s.entries = []; toast(e.message, 'bad'); }
    if (byId(view) === s && tab === 'files') render();
  }
  const ready = (s) => !s.placeholder && (!s.created || s.install === 'ok');

  /* ---------- Graphiques ---------- */
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function drawChart(id, data, { min, max, unit, threshold, color, ticks = 4 }) {
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
    ctx.fillText(`−${Math.max(1, Math.round(data.length * 10 / 60))} min`, L, r.height - 4); ctx.textAlign = 'right'; ctx.fillText('maintenant', L + W, r.height - 4);
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
    drawChart('c-cpu', sys.cpu, { min: 0, max: 100, unit: '%', color: '--accent' });
    drawChart('c-tmp', sys.temp, { min: 30, max: 100, ticks: 7, unit: '°', threshold: 80, color: sys.temp.at(-1) >= 80 ? '--warn' : '--ok' });
  }

  /* ---------- Rendu ---------- */
  function render() {
    const s = byId(view);
    if (!s && !['overview', 'journal', 'settings', 'new'].includes(view)) view = 'overview';
    if (view === 'new' && !draft) draft = newDraft('mc');
    const a = document.activeElement, keep = a && a.id && a.tagName === 'INPUT' && a.type !== 'file' ? { id: a.id, v: a.value } : null;
    const log = $('#log'), stick = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    renderNav();
    $('#main').innerHTML = view === 'overview' ? overview() : view === 'journal' ? journalView() : view === 'settings' ? settingsView() : view === 'new' ? createView() : detail(byId(view));
    drawCharts();
    const nl = $('#log'); if (nl && stick) nl.scrollTop = nl.scrollHeight;
    if (keep) { const el = document.getElementById(keep.id); if (el && !el.disabled) { el.value = keep.v; el.focus(); } }
  }

  function toast(text, kind = 'ok') {
    const t = document.createElement('div'); t.className = 'toast ' + kind;
    t.innerHTML = icon(kind === 'bad' ? 'alert' : 'check') + `<span>${esc(text)}</span>`;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500);
  }

  async function go(v, type) {
    view = v; tab = 'console'; ghost = null; pendingDelete = null; pendingFileDel = null; newFolder = false;
    if (v !== 'new') tapeMsg = { text: '', bad: false };
    if (v === 'new') draft = newDraft(type || 'mc');
    history.replaceState(null, '', '#' + v);
    render(); window.scrollTo(0, 0);
    if (v === 'new') { if (!acTracks && byId('assetto')) { await loadAc(byId('assetto')).catch(() => {}); if (view === 'new') { draft.track = acTracks && acTracks[0] ? acTracks[0].id : draft.track; render(); } } $('#n-name') && $('#n-name').focus(); }
    const s = byId(v);
    if (s && !s.placeholder) subscribeLogs(s);
    if (s && s.game === 'mc' && ready(s) && !s.props) { await loadMc(s); if (view === v) render(); }
    if (s && s.game === 'ac' && ready(s) && !s.acCfg) { await loadAc(s).catch(() => {}); if (view === v) render(); }
    if (v === 'settings') api('/api/sysinfo').then(d => { const el = $('#sysinfo'); if (el) el.textContent = d.info; }).catch(() => {});
  }

  async function openTab(t) {
    tab = t; pendingDelete = null; pendingFileDel = null; newFolder = false; render();
    const s = byId(view); if (!s || !ready(s)) return;
    try {
      if (t === 'settings' && s.game === 'mc') await loadMc(s);
      if (t === 'settings' && s.game === 'ac') await loadAc(s);
      if (t === 'players' && s.game === 'mc' && s.state === 'running') await loadMcPlayers(s);
      if (t === 'files') { await loadFiles(s); return; }
    } catch (e) { toast(e.message, 'bad'); }
    if (tab === t && byId(view) === s) render();
  }

  /* ---------- Logs en direct ---------- */
  let ws = null;
  function connectWs() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => { const s = byId(view); if (s && !s.placeholder) subscribeLogs(s); };
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
  function subscribeLogs(s, force) {
    if (!ws || ws.readyState !== 1 || (ws.cur === s.id && !force)) return;
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
      const builtin = servers.filter(s => !s.created && !s.placeholder);
      setPending(builtin.filter(s => toAc ? s.game === 'mc' : s.game === 'ac'), 'stopping');
      setPending(builtin.filter(s => toAc ? s.game === 'ac' : s.game === 'mc'), 'starting');
      journalAdd(null, 'w', `Bascule vers ${toAc ? 'Assetto Corsa' : 'Minecraft'}`);
      tapeMsg = { text: 'Bascule en cours, environ 15 secondes…', bad: false }; toast('Bascule lancée');
    } catch (e) { toast(e.message, 'bad'); }
    render();
  }

  async function serverAction(s, action) {
    if (!s.created) {
      if (s.game === 'ac' && action === 'start') return doSwitch('assetto');
      if (s.game === 'ac' && action === 'stop') return doSwitch('minecraft');
      if (s.game === 'mc' && action === 'start' && sys.mode === 'assetto') return doSwitch('minecraft');
    }
    try {
      if (s.game === 'ac' && !s.created) await api('/api/ac/restart', {});
      else await api(`/api/servers/${s.id}/action`, { action });
      setPending([s], action === 'stop' ? 'stopping' : 'starting');
      journalAdd(s, action === 'stop' ? '' : 'o', { start: 'Démarrage demandé', stop: 'Arrêt demandé', restart: 'Redémarrage demandé' }[action]);
      toast(`${s.name} : ${{ start: 'démarrage', stop: 'arrêt', restart: 'redémarrage' }[action]} en cours`);
    } catch (e) { journalAdd(s, 'e', e.message); toast(e.message, 'bad'); }
    ghost = null; render();
  }

  async function listEdit(s, kind, add, player) {
    if (!/^[A-Za-z0-9_]{2,16}$/.test(player)) { toast('Pseudo invalide : 2 à 16 caractères, lettres, chiffres ou _', 'bad'); return; }
    try {
      await api(`/api/mc/${s.id}/${kind === 'wl' ? 'whitelist' : 'ops'}/${add ? 'add' : 'remove'}`, { player });
      journalAdd(s, '', `${player} ${add ? 'ajouté à' : 'retiré de'} ${kind === 'wl' ? 'la whitelist' : 'la liste des ops'}`);
      toast(`${player} ${add ? 'ajouté' : 'retiré'}`);
      await loadMc(s);
    } catch (e) { toast(e.message, 'bad'); }
    render();
  }

  function uploadFiles(s, fileList) {
    const files = [...fileList]; if (!files.length) return;
    const big = files.find(f => f.size > 2 * GB); if (big) { toast(`${big.name} dépasse 2 Go : passe par SFTP.`, 'bad'); return; }
    const u = { id: Math.random().toString(36).slice(2, 8), srv: s.id, name: files.length > 1 ? `${files.length} fichiers` : files[0].name, size: Math.max(files.reduce((a, f) => a + f.size, 0), 1), done: 0 };
    uploads.push(u); render();
    const fd = new FormData(); files.forEach(f => fd.append('files', f));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/${s.id}/upload?path=${encodeURIComponent(s.cwd.join('/'))}`);
    xhr.upload.onprogress = (e) => {
      u.done = Math.min(e.loaded, u.size);
      const b = document.getElementById('upb-' + u.id), t = document.getElementById('upt-' + u.id);
      if (b) b.style.width = (u.done / u.size * 100) + '%'; if (t) t.textContent = `${fmtSize(u.done)} / ${fmtSize(u.size)}`;
    };
    xhr.onloadend = () => {
      uploads = uploads.filter(x => x !== u);
      let err = null; try { err = xhr.status >= 400 ? JSON.parse(xhr.responseText).error : null; } catch (_) { err = 'Envoi impossible'; }
      if (xhr.status === 0) err = 'Envoi interrompu';
      if (err) toast(err, 'bad'); else { toast(`${u.name} envoyé`); journalAdd(s, '', `Fichiers : ${u.name} envoyé dans /${s.cwd.join('/')}`); }
      loadFiles(s);
    };
    xhr.send(fd);
  }

  document.addEventListener('click', async (e) => {
    const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go, g.dataset.type); return; }
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
    const s = byId(a.dataset.id) || byId(view);
    switch (a.dataset.act) {
      case 'start': case 'stop': case 'restart': serverAction(s, a.dataset.act); break;
      case 'switch': doSwitch(a.dataset.target); break;
      case 'retry': await go(s.id); openTab('settings'); break;
      case 'kick':
        try { await api(`/api/servers/${s.id}/command`, { command: 'kick ' + a.dataset.p }); journalAdd(s, 'w', `${a.dataset.p} expulsé`); toast(`${a.dataset.p} expulsé`); await loadMcPlayers(s); render(); }
        catch (err) { toast(err.message, 'bad'); }
        break;
      case 'wl-add': case 'op-add': { const k = a.dataset.act.slice(0, 2); listEdit(s, k, true, $('#f-' + k).value.trim()); break; }
      case 'wl-del': case 'op-del': listEdit(s, a.dataset.act.slice(0, 2), false, a.dataset.p); break;
      case 'del-ask': pendingDelete = s.id; render(); break;
      case 'del-cancel': pendingDelete = null; render(); break;
      case 'del-yes':
        try {
          a.disabled = true;
          await api('/api/registry/' + encodeURIComponent(s.id), undefined, 'DELETE');
          journalAdd(s, 'w', `${s.name} supprimé`); toast(`#${s.no} ${s.name} supprimé`);
          syncRegistry(await api('/api/registry')); go('overview');
        } catch (err) { toast(err.message, 'bad'); a.disabled = false; }
        break;
      case 'cd': s.cwd.push(a.dataset.name); pendingFileDel = null; newFolder = false; loadFiles(s); render(); break;
      case 'cd-to': s.cwd = s.cwd.slice(0, +a.dataset.depth); pendingFileDel = null; newFolder = false; loadFiles(s); render(); break;
      case 'mkdir': newFolder = true; render(); $('#f-dir').focus(); break;
      case 'mkdir-cancel': newFolder = false; render(); break;
      case 'fdel': pendingFileDel = a.dataset.name; render(); break;
      case 'fdel-cancel': pendingFileDel = null; render(); break;
      case 'fdel-yes':
        try {
          await api(`/api/files/${s.id}/delete`, { path: [...s.cwd, a.dataset.name].join('/') });
          journalAdd(s, 'w', `Fichiers : ${a.dataset.name} supprimé de /${s.cwd.join('/')}`); toast(`${a.dataset.name} supprimé`);
        } catch (err) { toast(err.message, 'bad'); }
        pendingFileDel = null; loadFiles(s); break;
      case 'copy': {
        const el = document.getElementById(a.dataset.target); const txt = el.textContent;
        const selectIt = () => { const r = document.createRange(); r.selectNodeContents(el); const w = getSelection(); w.removeAllRanges(); w.addRange(r); toast('Texte sélectionné, copie-le avec Ctrl+C'); };
        try { navigator.clipboard.writeText(txt).then(() => toast(`Copié : ${txt}`), selectIt); } catch (_) { selectIt(); }
        break;
      }
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
      if (f.hasAttribute('data-create')) {
        readDraft(f);
        const lic = readLicence('n');
        if (!validateDraft(lic)) { render(); const first = document.querySelector('[aria-invalid="true"]'); if (first) first.focus(); return; }
        f.querySelector('[type="submit"]').disabled = true;
        await createServer(lic); return;
      }
      if (f.dataset.reinstall) {
        const s = byId(f.dataset.reinstall), lic = readLicence('r');
        if ((gamesInfo[s.game] || {}).steam && (!lic.steamUser || !lic.steamPass)) { toast('Renseigne le compte Steam qui possède le jeu', 'bad'); return; }
        await api(`/api/registry/${s.id}/reinstall`, { licence: lic });
        journalAdd(s, '', 'Installation relancée'); toast('Installation relancée');
        s.install = 'running'; s.state = 'installing'; tab = 'console'; subscribeLogs(s, true); render(); return;
      }
      if (f.dataset.mkdir) {
        const s = byId(f.dataset.mkdir), name = $('#f-dir').value.trim();
        await api(`/api/files/${s.id}/mkdir`, { path: s.cwd.join('/'), name });
        newFolder = false; journalAdd(s, '', `Fichiers : dossier ${name} créé`); loadFiles(s); return;
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
          const tr = f.querySelector('[name="track"]:checked');
          if (!cars.length) { toast('Choisis au moins une voiture', 'bad'); return; }
          if (!tr) { toast('Choisis un circuit', 'bad'); return; }
          const [track, trackConfig] = tr.value.split('|');
          await api('/api/ac/config' + (s.created ? '?id=' + encodeURIComponent(s.id) : ''), { name: $('#f-name').value, password: $('#f-pass').value, track, trackConfig, cars, maxClients: $('#f-slots').value, sunAngle: $('#f-sun').value });
          await loadAc(s);
        }
        journalAdd(s, 'o', 'Réglages enregistrés'); toast(`Réglages de ${s.name} enregistrés`); render();
      }
    } catch (err) { toast(err.message, 'bad'); const b = f.querySelector('[type="submit"]'); if (b) b.disabled = false; }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'f-carq' || t.id === 'f-trackq') {
      const q = t.value.toLowerCase();
      t.parentElement.querySelectorAll('[data-q]').forEach(l => { l.hidden = !l.dataset.q.includes(q); });
      return;
    }
    const f = t.closest('[data-create]'); if (!f) return;
    if (t.name === 'n-game') { readDraft(f); draft = newDraft(t.value, draft); render(); document.getElementById(t.id).focus(); return; }
    readDraft(f);
    if (draft.errors[t.id.slice(2)]) delete draft.errors[t.id.slice(2)];
    if (t.name === 'n-col') { render(); document.getElementById(t.id).focus(); return; }
    const out = $('#ram-out'); if (out) out.textContent = fmt(draft.ram) + ' Go';
    const pn = $('#prev-name'); if (pn) pn.textContent = draft.name || defaultName(draft);
    const pl = document.querySelector('.preview-entry .plate'); if (pl) pl.textContent = draft.no || '?';
    const h = $('#create-hint'); if (h) h.textContent = createHint();
    refreshTape();
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.name === 'car') $('#car-n').textContent = document.querySelectorAll('[name="car"]:checked').length;
    if (t.id === 'f-upload' && t.files.length) uploadFiles(byId(t.dataset.id), t.files);
    if (t.dataset.upload && t.files.length) {
      const fd = new FormData(); fd.append('mod', t.files[0]);
      toast(`Envoi de ${t.files[0].name}…`);
      try {
        const r = await fetch('/api/ac/upload/' + t.dataset.upload, { method: 'POST', body: fd });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Envoi impossible');
        journalAdd(byId(view), 'o', `${t.files[0].name} installé`); toast(d.message || 'Installé');
        acTracks = null; acMeta = null; await loadAc(byId(view)); render();
      } catch (err) { toast(err.message, 'bad'); t.value = ''; }
    }
  });

  let dragDepth = 0;
  const zone = (e) => e.target.closest && e.target.closest('#dropzone');
  document.addEventListener('dragenter', (e) => { const z = zone(e); if (!z) return; e.preventDefault(); dragDepth++; z.classList.add('drag'); });
  document.addEventListener('dragover', (e) => { if (zone(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { const z = zone(e); if (!z) return; if (--dragDepth <= 0) { dragDepth = 0; z.classList.remove('drag'); } });
  document.addEventListener('drop', (e) => {
    const z = zone(e); if (!z) return; e.preventDefault(); dragDepth = 0; z.classList.remove('drag');
    if (e.dataTransfer.files.length) uploadFiles(byId(z.dataset.id), e.dataTransfer.files);
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
    syncRegistry(await api('/api/registry'));
    const h = location.hash.slice(1);
    if (byId(h) || ['journal', 'settings', 'new'].includes(h)) view = h;
    await Promise.allSettled(servers.filter(ready).map(s => s.game === 'mc' ? loadMc(s) : s.game === 'ac' ? loadAc(s) : null));
    connectWs(); await poll(); go(view);
    setInterval(() => poll().catch(() => {}), POLL_MS);
    document.fonts && document.fonts.ready.then(drawCharts);
  }

  try {
    const t = localStorage.getItem('gp-theme');
    if (t && t !== 'system') { document.documentElement.setAttribute('data-theme', t); document.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeSet === t)); }
  } catch (_) {}
  fetch('/api/registry').then(r => r.ok ? start() : showLogin()).catch(showLogin);
})();
