const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');
const { Rcon } = require('rcon-client');
const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const https = require('https');
const ini = require('ini');
const multer = require('multer');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const FileStore = require('session-file-store')(session);
const app = express();
const sslOptions = {
  key: fs.readFileSync('./ssl/key.pem'),
  cert: fs.readFileSync('./ssl/cert.pem')
};
const server = https.createServer(sslOptions, app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const sessionMiddleware = session({
  store: new FileStore({ path: './sessions', ttl: 86400, retries: 0 }),
  secret: config.panel.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 86400000 }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const loginAttempts = {};
function checkBruteForce(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lastAttempt: now };
  if (now - loginAttempts[ip].lastAttempt > 300000) loginAttempts[ip] = { count: 0, lastAttempt: now };
  return loginAttempts[ip].count >= 5;
}
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Non autorise' });
}
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (checkBruteForce(ip)) return res.status(429).json({ error: 'Trop de tentatives' });
  const { username, password } = req.body;
  if (username === config.panel.username && password === config.panel.password) {
    req.session.authenticated = true;
    if (loginAttempts[ip]) loginAttempts[ip].count = 0;
    res.json({ success: true });
  } else {
    if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lastAttempt: Date.now() };
    loginAttempts[ip].count++;
    loginAttempts[ip].lastAttempt = Date.now();
    // Lu par la jail Fail2ban garage-panel (docs/SECURITE.md).
    console.warn(new Date().toISOString() + ' Echec connexion panel depuis ' + ip);
    res.status(401).json({ error: 'Identifiants incorrects' });
  }
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

const getJavaRam = (jarName) => new Promise(resolve => {
  exec('pgrep -f "' + jarName + '"', (err, stdout) => {
    if (err || !stdout.trim()) return resolve(null);
    const pid = stdout.trim().split('\n')[0];
    try {
      const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
      resolve(parseInt(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0) * 1024);
    } catch (e) { resolve(null); }
  });
});

const getPlayersAndMax = async (serverName) => {
  try {
    const response = await rconSend(serverName, 'list');
    const m1 = response.match(/There are (\d+) of a max of (\d+)/i);
    if (m1) return { online: parseInt(m1[1]), max: parseInt(m1[2]) };
    const m2 = response.match(/(\d+)\/(\d+)/);
    if (m2) return { online: parseInt(m2[1]), max: parseInt(m2[2]) };
    return { online: 0, max: 20 };
  } catch (e) { return null; }
};

function readServerProperties(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const props = {};
  content.split('\n').forEach(line => {
    if (line.startsWith('#') || !line.includes('=')) return;
    const [key, ...rest] = line.split('=');
    props[key.trim()] = rest.join('=').trim();
  });
  return props;
}

function writeServerProperties(filePath, updates) {
  let content = fs.readFileSync(filePath, 'utf8');
  Object.entries(updates).forEach(([key, value]) => {
    const regex = new RegExp('^' + key + '=.*$', 'm');
    if (regex.test(content)) content = content.replace(regex, key + '=' + value);
    else content += '\n' + key + '=' + value;
  });
  fs.writeFileSync(filePath, content);
}

// ==================== REGISTRE DES SERVEURS ====================
// Serveurs d'origine (MSH + bascule) et serveurs créés depuis le panel (servers.json, unités systemd gp-<id>).
const GAMES_ROOT = '/srv/games';
const REGISTRY_FILE = path.join(__dirname, 'servers.json');
const HELPER = '/usr/local/bin/gp-service';
// Réglages par jeu, surchargeables dans config.json > games. Les app IDs et exécutables Steam sont à vérifier sur la machine.
const GAMES = {
  mc: {},
  ac: { steamAppId: 302550, platform: 'linux', exe: 'acServer', contentDir: '/opt/assetto/content' },
  lmu: { steamAppId: null, platform: 'windows', exe: 'LMU Dedicated.exe' },
  fs: { steamAppId: 447020, platform: 'windows', exe: 'dedicatedServer.exe' }
};
for (const k of Object.keys(config.games || {})) GAMES[k] = { ...GAMES[k], ...config.games[k] };
const STEAMCMD = config.steamcmd || '/usr/games/steamcmd';
const BUILTIN = {
  fabric: { id: 'fabric', type: 'mc', builtin: true, name: 'Minecraft Fabric', ver: 'Fabric 1.20+ · MSH', no: 12, colour: 'fabric', dir: '/opt/minecraft/fabric', ram: 4 },
  paper: { id: 'paper', type: 'mc', builtin: true, name: 'Minecraft Paper', ver: 'Paper 1.17.1 · ViaVersion · MSH', no: 7, colour: 'paper', dir: '/opt/minecraft/paper', ram: 3 },
  assetto: { id: 'assetto', type: 'ac', builtin: true, name: 'Assetto Corsa', ver: 'acServer · Wine', no: 24, colour: 'ac', dir: '/opt/assetto', ram: 1.5 }
};
let created = {};
try { created = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) {}
// Une installation coupée par un redémarrage du panel ne reprendra pas toute seule.
Object.values(created).forEach(s => { if (s.install === 'running') { s.install = 'error'; s.error = 'Installation interrompue'; } });
const saveRegistry = () => fs.writeFileSync(REGISTRY_FILE, JSON.stringify(created, null, 2));
const findServer = (id) => BUILTIN[id] || created[id];
const publicView = ({ rcon, ...s }) => s;

const rconOf = (name) => (config.servers[name] && config.servers[name].rcon) || (created[name] && created[name].rcon);
async function rconSend(name, command) {
  const r = rconOf(name);
  if (!r) throw new Error('Serveur invalide');
  const rcon = await Rcon.connect({ host: r.host || '127.0.0.1', port: r.port, password: r.password, timeout: 2000 });
  try { return await rcon.send(command); } finally { rcon.end().catch(() => {}); }
}
const mcFile = (name, file) => { const s = findServer(name); return s && s.type === 'mc' ? path.join(s.dir, file) : null; };
const acCfgDir = (id) => created[id] && created[id].type === 'ac' ? path.join(created[id].dir, 'cfg') : '/opt/assetto/cfg';

const sh = (cmd) => new Promise(resolve => exec(cmd, (err, stdout) => resolve((stdout || '').trim())));
const helper = (args) => new Promise((resolve, reject) => {
  execFile('sudo', [HELPER, ...args], (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout));
});
async function unitRam(unit) {
  const pid = await sh('systemctl show -p MainPID --value ' + unit);
  if (!pid || pid === '0') return null;
  try { return parseInt(fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] || 0) * 1024; } catch (e) { return null; }
}
async function acPlayers(unit) {
  const logs = await sh('journalctl -u ' + unit + ' -n 200 --no-pager');
  const connected = {};
  logs.split('\n').forEach(line => {
    const jm = line.match(/DRIVER_CONNECTED.*name:\s*([^\s,]+)/i);
    const lm = line.match(/DRIVER_DISCONNECTED.*name:\s*([^\s,]+)/i);
    if (jm) connected[jm[1]] = true;
    if (lm) delete connected[lm[1]];
  });
  return Object.keys(connected);
}

app.get('/api/registry', requireAuth, async (req, res) => {
  const list = await Promise.all(Object.values(created).map(async s => {
    const unit = 'gp-' + s.id;
    const active = s.install === 'ok' && await sh('systemctl is-active ' + unit) === 'active';
    return {
      ...publicView(s), active,
      ramNow: active ? await unitRam(unit) : null,
      players: !active ? null : s.type === 'mc' ? await getPlayersAndMax(s.id) : s.type === 'ac' ? await acPlayers(unit) : null
    };
  }));
  const games = Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [k, { steam: !!g.steamAppId }]));
  res.json({ builtin: Object.values(BUILTIN), created: list, games });
});

app.post('/api/registry', requireAuth, (req, res) => {
  const b = req.body;
  const all = [...Object.values(BUILTIN), ...Object.values(created)];
  const name = String(b.name || '').trim().slice(0, 40);
  const no = parseInt(b.no), port = parseInt(b.port), slots = parseInt(b.slots) || 10;
  const ram = Math.min(Math.max(parseFloat(b.ram) || 2, 1), 12);
  if (!GAMES[b.type]) return res.status(400).json({ error: 'Jeu inconnu' });
  if (name.length < 2) return res.status(400).json({ error: 'Nom trop court' });
  if (!(no >= 1 && no <= 99) || all.some(s => s.no === no)) return res.status(400).json({ error: 'Numéro invalide ou déjà pris' });
  if (!(port >= 1024 && port <= 65535) || all.some(s => s.port === port)) return res.status(400).json({ error: 'Port invalide ou déjà pris' });
  if (b.type === 'mc' && (!['paper', 'fabric'].includes(b.loader) || !/^1\.\d+(\.\d+)?$/.test(b.version))) return res.status(400).json({ error: 'Version Minecraft invalide' });
  const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || b.type;
  const id = slug + '-' + crypto.randomBytes(2).toString('hex');
  const s = {
    id, type: b.type, name, no, port, slots, ram, colour: /^(paper|fabric|ac|lmu|fs|pink)$/.test(b.colour) ? b.colour : b.type,
    dir: path.join(GAMES_ROOT, id), install: 'running', createdAt: Date.now(),
    loader: b.loader, version: b.version, track: b.track, map: b.map
  };
  if (s.type === 'mc') s.rcon = { host: '127.0.0.1', port: port < 55536 ? port + 10000 : port - 10000, password: crypto.randomBytes(12).toString('hex') };
  created[id] = s; saveRegistry();
  res.json({ server: publicView(s) });
  install(s, b.licence || {}, !!b.startNow);
});

app.post('/api/registry/:id/reinstall', requireAuth, (req, res) => {
  const s = created[req.params.id];
  if (!s) return res.status(404).json({ error: 'Serveur introuvable' });
  if (s.install === 'running') return res.status(409).json({ error: 'Installation déjà en cours' });
  s.install = 'running'; delete s.error; saveRegistry();
  res.json({ success: true });
  install(s, req.body.licence || {}, false);
});

app.delete('/api/registry/:id', requireAuth, async (req, res) => {
  const s = created[req.params.id];
  if (!s) return res.status(404).json({ error: 'Serveur introuvable' });
  try { await helper(['remove', s.id]); delete created[s.id]; saveRegistry(); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Installation ----------
const UA = { 'User-Agent': 'GaragePikesPanel/1.0 (+https://github.com/MI6-Pikes00/In-house-server-system)' };
async function get(url) {
  try { return await fetch(url, { headers: UA }); }
  catch (e) { throw new Error(url + ' injoignable (' + ((e.cause && e.cause.code) || e.message) + ')'); }
}
async function getJson(url) {
  const r = await get(url);
  if (!r.ok) throw new Error(url + ' : HTTP ' + r.status);
  return r.json();
}
async function download(url, dest) {
  const r = await get(url);
  if (!r.ok) throw new Error(url + ' : HTTP ' + r.status);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

async function installMc(s, log) {
  let url;
  if (s.loader === 'paper') {
    const builds = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${s.version}/builds`);
    const build = builds.find(x => x.channel === 'STABLE') || builds[0];
    if (!build) throw new Error('Aucun build Paper pour ' + s.version);
    url = (build.downloads['server:default'] || Object.values(build.downloads)[0]).url;
    log(`Paper ${s.version} build ${build.id}`);
  } else {
    const [loaders, installers] = await Promise.all([getJson('https://meta.fabricmc.net/v2/versions/loader/' + s.version), getJson('https://meta.fabricmc.net/v2/versions/installer')]);
    const loader = (loaders.find(x => x.loader.stable) || loaders[0] || {}).loader;
    const installer = installers.find(x => x.stable) || installers[0];
    if (!loader || !installer) throw new Error('Fabric indisponible pour ' + s.version);
    url = `https://meta.fabricmc.net/v2/versions/loader/${s.version}/${loader.version}/${installer.version}/server/jar`;
    log(`Fabric ${s.version}, loader ${loader.version}`);
  }
  log('Téléchargement de ' + url);
  await download(url, path.join(s.dir, 'server.jar'));
  fs.writeFileSync(path.join(s.dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(s.dir, 'server.properties'), [
    'server-port=' + s.port, 'max-players=' + s.slots, 'motd=' + s.name, 'view-distance=10',
    'enable-rcon=true', 'rcon.port=' + s.rcon.port, 'rcon.password=' + s.rcon.password, 'white-list=false'
  ].join('\n') + '\n');
  log('eula.txt et server.properties écrits');
}

function steamInstall(s, g, lic, log) {
  if (!lic.steamUser || !lic.steamPass) throw new Error('Identifiants Steam requis (compte qui possède le jeu)');
  // Script SteamCMD temporaire en 0600 : le mot de passe ne passe pas dans la ligne de commande.
  const script = path.join(os.tmpdir(), 'gp-steam-' + s.id + '.txt');
  const q = (v) => '"' + String(v).replace(/"/g, '') + '"';
  fs.writeFileSync(script, [
    g.platform === 'windows' ? '@sSteamCmdForcePlatformType windows' : '',
    'force_install_dir ' + q(s.dir),
    ['login', q(lic.steamUser), q(lic.steamPass), lic.steamGuard ? q(lic.steamGuard) : ''].join(' ').trim(),
    `app_update ${g.steamAppId} validate`, 'quit'
  ].filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  log(`SteamCMD : app ${g.steamAppId} avec le compte ${lic.steamUser}`);
  return new Promise((resolve, reject) => {
    const p = spawn(STEAMCMD, ['+runscript', script]);
    const out = (chunk) => chunk.toString().split('\n').filter(l => l.trim()).forEach(l => log(l.trim()));
    p.stdout.on('data', out); p.stderr.on('data', out);
    p.on('error', (e) => { fs.rmSync(script, { force: true }); reject(new Error('SteamCMD introuvable (' + STEAMCMD + ') : ' + e.message)); });
    p.on('close', (code) => {
      fs.rmSync(script, { force: true });
      const exe = path.join(s.dir, g.exe);
      code === 0 && fs.existsSync(exe) ? resolve() : reject(new Error(`SteamCMD terminé (code ${code}), ${g.exe} absent. Vérifie le compte, le code Steam Guard et l'app ID.`));
    });
  });
}

function configureAc(s, log) {
  const cfg = path.join(s.dir, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  if (!fs.existsSync(path.join(cfg, 'server_cfg.ini'))) fs.copyFileSync('/opt/assetto/cfg/server_cfg.ini', path.join(cfg, 'server_cfg.ini'));
  const content = path.join(s.dir, 'content');
  if (!fs.existsSync(content) && fs.existsSync(GAMES.ac.contentDir)) { fs.symlinkSync(GAMES.ac.contentDir, content); log('content -> ' + GAMES.ac.contentDir); }
  const cars = (ini.parse(fs.readFileSync(path.join(cfg, 'server_cfg.ini'), 'utf8')).SERVER || {}).CARS;
  writeAcConfig(cfg, { name: s.name, maxClients: s.slots, track: s.track, cars: cars ? cars.split(';') : undefined, tcpPort: s.port, httpPort: s.port + 1000 });
  log(`server_cfg.ini : port ${s.port}, HTTP ${s.port + 1000}, ${s.slots} places`);
}

async function install(s, lic, startNow) {
  const g = GAMES[s.type];
  const log = (m) => fs.appendFileSync(path.join(s.dir, 'install.log'), `[${new Date().toLocaleTimeString('fr-FR')}] ${m}\n`);
  try {
    await helper(['prepare', s.id]);
    log(`Installation de ${s.name} dans ${s.dir}`);
    if (s.type === 'mc') await installMc(s, log);
    else if (g.steamAppId) await steamInstall(s, g, lic, log);
    else log(`Pas d'app Steam configurée pour ce jeu : dépose les fichiers du serveur dédié dans l'onglet Fichiers (${g.exe} attendu).`);
    if (s.type === 'ac') configureAc(s, log);
    if (lic.productKey) { fs.writeFileSync(path.join(s.dir, 'licence.txt'), lic.productKey + '\n', { mode: 0o600 }); log('Clé produit enregistrée dans licence.txt'); }
    await helper(['create', s.id, s.type, String(Math.ceil(s.ram)), g.exe || '']);
    s.install = 'ok';
    log('Installation terminée, service gp-' + s.id + ' créé');
    if (startNow) { await helper(['start', s.id]); log('Serveur démarré'); }
  } catch (e) {
    s.install = 'error'; s.error = e.message;
    try { log('ERREUR : ' + e.message); } catch (_) {}
  }
  saveRegistry();
}

// ---------- Fichiers (confinés au dossier du serveur) ----------
function serverPath(id, rel, write) {
  const s = findServer(id);
  if (!s) throw new Error('Serveur invalide');
  const root = path.resolve(s.dir);
  const p = path.resolve(root, '.' + path.sep + String(rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Chemin interdit');
  // En écriture, on refuse aussi de suivre un lien symbolique qui sort du dossier (ex. content AC partagé).
  if (write) {
    const realRoot = fs.realpathSync(root), real = fs.realpathSync(fs.existsSync(p) ? p : path.dirname(p));
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Chemin interdit');
  }
  return { root, p };
}
const validName = (n) => typeof n === 'string' && /^[^/\\\0]{1,120}$/.test(n) && n !== '.' && n !== '..';

app.get('/api/files/:id', requireAuth, (req, res) => {
  try {
    const { p } = serverPath(req.params.id, req.query.path);
    const entries = fs.readdirSync(p, { withFileTypes: true }).map(d => {
      let st = null; try { st = fs.statSync(path.join(p, d.name)); } catch (e) {}
      return { name: d.name, dir: st ? st.isDirectory() : false, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
    });
    res.json({ entries });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  try {
    const { p } = serverPath(req.params.id, req.query.path);
    if (!fs.statSync(p).isFile()) return res.status(400).json({ error: 'Pas un fichier' });
    res.download(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { try { cb(null, serverPath(req.params.id, req.query.path, true).p); } catch (e) { cb(e); } },
    filename: (req, file, cb) => validName(file.originalname) ? cb(null, file.originalname) : cb(new Error('Nom de fichier invalide'))
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});
app.post('/api/files/:id/upload', requireAuth, (req, res) => {
  fileUpload.array('files')(req, res, (err) => err ? res.status(400).json({ error: err.message }) : res.json({ success: true, count: (req.files || []).length }));
});

app.post('/api/files/:id/mkdir', requireAuth, (req, res) => {
  try {
    if (!validName(req.body.name)) throw new Error('Nom de dossier invalide');
    const { p } = serverPath(req.params.id, path.join(String(req.body.path || ''), req.body.name), true);
    fs.mkdirSync(p);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/files/:id/delete', requireAuth, (req, res) => {
  try {
    const { root, p } = serverPath(req.params.id, req.body.path, true);
    if (p === root) throw new Error('Impossible de supprimer la racine');
    fs.rmSync(p, { recursive: true });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

async function getTemp() {
  try { return parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch (e) {}
  const m = (await sh('sensors coretemp-isa-0000')).match(/Core 0:\s+\+?([\d.]+).C/);
  return m ? parseFloat(m[1]) : null;
}

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)[1]) * 1024;
    const memAvailable = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)[1]) * 1024;
    const memUsed = memTotal - memAvailable;
    const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    let diskInfo = await new Promise(resolve => {
      exec('df -B1 /opt/minecraft', (err, stdout) => {
        const lines = stdout.trim().split('\n');
        const parts = lines[1].split(/\s+/);
        resolve({ total: parseInt(parts[1]), used: parseInt(parts[2]), available: parseInt(parts[3]) });
      });
    });
    const temp = await getTemp();
    const cpu1 = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    await new Promise(r => setTimeout(r, 200));
    const cpu2 = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    const cpuPercent = Math.round((1 - (cpu2[3]-cpu1[3]) / (cpu2.reduce((a,b)=>a+b,0)-cpu1.reduce((a,b)=>a+b,0))) * 100);
    const totalWatts = 15 + Math.floor(cpuPercent/25)*5 + Math.round((memUsed/1073741824)*2);
    const monthlyKwh = (totalWatts*24*30)/1000;
    const monthlyCost = (monthlyKwh*config.electricity.ratePerKwh).toFixed(2);
    const [fabricRam, paperRam, fabricPlayers, paperPlayers] = await Promise.all([getJavaRam('server.jar'), getJavaRam('paper-1.17.1.jar'), getPlayersAndMax('fabric'), getPlayersAndMax('paper')]);
    const acActive = await new Promise(resolve => { exec('systemctl is-active assetto', (err, stdout) => { resolve(stdout.trim() === 'active'); }); });
    res.json({ memory: { total: memTotal, used: memUsed, available: memAvailable }, cpu: cpuPercent, temperature: temp, disk: diskInfo, uptime, power: { watts: totalWatts, monthlyKwh: monthlyKwh.toFixed(2), monthlyCost }, servers: { fabric: { ram: fabricRam, players: fabricPlayers }, paper: { ram: paperRam, players: paperPlayers } }, mode: acActive ? 'assetto' : 'minecraft' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/servers', requireAuth, (req, res) => {
  const results = {};
  let done = 0;
  ['msh-fabric', 'msh-paper'].forEach(service => {
    exec('systemctl is-active ' + service, (err, stdout) => {
      results[service === 'msh-fabric' ? 'fabric' : 'paper'] = stdout.trim() === 'active' ? 'online' : 'offline';
      if (++done === 2) res.json(results);
    });
  });
});

app.post('/api/servers/:name/action', requireAuth, (req, res) => {
  const { name } = req.params;
  const { action } = req.body;
  if (!['start','stop','restart'].includes(action)) return res.status(400).json({ error: 'Action invalide' });
  if (created[name]) {
    if (created[name].install !== 'ok') return res.status(409).json({ error: 'Serveur pas encore installé' });
    return helper([action, name]).then(() => res.json({ success: true }), e => res.status(500).json({ error: e.message }));
  }
  if (!['fabric','paper'].includes(name)) return res.status(400).json({ error: 'Serveur invalide' });
  exec('sudo systemctl ' + action + ' ' + (name==='fabric'?'msh-fabric':'msh-paper'), (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    res.json({ success: true });
  });
});

app.post('/api/servers/:name/command', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { command } = req.body;
  if (!command || command.includes(';') || command.includes('&') || command.includes('|')) return res.status(400).json({ error: 'Commande invalide' });
  if (!rconOf(name)) return res.status(400).json({ error: 'Serveur invalide' });
  try { res.json({ success: true, response: await rconSend(name, command) }); }
  catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
});

app.get('/api/mc/:name/config', requireAuth, (req, res) => {
  const file = mcFile(req.params.name, 'server.properties');
  if (!file) return res.status(400).json({ error: 'Serveur invalide' });
  try { res.json({ props: readServerProperties(file) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mc/:name/config', requireAuth, (req, res) => {
  const file = mcFile(req.params.name, 'server.properties');
  if (!file) return res.status(400).json({ error: 'Serveur invalide' });
  try {
    const allowed = ['max-players','view-distance','simulation-distance','motd','difficulty','gamemode','pvp','spawn-protection','online-mode','white-list','enforce-whitelist','allow-flight','level-name'];
    const updates = {};
    allowed.forEach(key => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });
    writeServerProperties(file, updates);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

for (const [route, file, key] of [['whitelist', 'whitelist.json', 'whitelist'], ['ops', 'ops.json', 'ops']]) {
  app.get('/api/mc/:name/' + route, requireAuth, (req, res) => {
    const f = mcFile(req.params.name, file);
    if (!f) return res.status(400).json({ error: 'Serveur invalide' });
    try { res.json({ [key]: JSON.parse(fs.readFileSync(f, 'utf8') || '[]') }); } catch (e) { res.json({ [key]: [] }); }
  });
}

for (const [route, command] of [['whitelist/add', 'whitelist add'], ['whitelist/remove', 'whitelist remove'], ['ops/add', 'op'], ['ops/remove', 'deop']]) {
  app.post('/api/mc/:name/' + route, requireAuth, async (req, res) => {
    const { player } = req.body;
    if (!player || !/^[a-zA-Z0-9_]{2,16}$/.test(player)) return res.status(400).json({ error: 'Nom invalide' });
    try { res.json({ success: true, response: await rconSend(req.params.name, command + ' ' + player) }); }
    catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
  });
}

app.get('/api/ac/status', requireAuth, (req, res) => {
  exec('systemctl is-active assetto', (err, stdout) => {
    const active = stdout.trim() === 'active';
    exec('pgrep -f "original.exe"', (err2, pids) => {
      let ram = null;
      if (!err2 && pids.trim()) {
        const pid = pids.trim().split('\n')[0];
        try { ram = parseInt(fs.readFileSync('/proc/'+pid+'/status','utf8').match(/VmRSS:\s+(\d+)/)?.[1]||0)*1024; } catch(e){}
      }
      exec('journalctl -u assetto -n 200 --no-pager', (err3, logs) => {
        const players = [];
        if (logs) {
          const connected = {};
          logs.split('\n').forEach(line => {
            const jm = line.match(/DRIVER_CONNECTED.*name:\s*([^\s,]+)/i);
            const lm = line.match(/DRIVER_DISCONNECTED.*name:\s*([^\s,]+)/i);
            if (jm) connected[jm[1]] = true;
            if (lm) delete connected[lm[1]];
          });
          players.push(...Object.keys(connected));
        }
        res.json({ active, ram, players });
      });
    });
  });
});

app.post('/api/ac/switch-to-assetto', requireAuth, (req, res) => {
  res.json({ success: true, message: 'Bascule en cours...' });
  exec('sudo /usr/local/bin/switch-to-assetto.sh');
});

app.post('/api/ac/switch-to-minecraft', requireAuth, (req, res) => {
  res.json({ success: true, message: 'Bascule en cours...' });
  exec('sudo /usr/local/bin/switch-to-minecraft.sh');
});

app.get('/api/ac/config', requireAuth, (req, res) => {
  try {
    const serverCfg = ini.parse(fs.readFileSync(path.join(acCfgDir(req.query.id), 'server_cfg.ini'), 'utf8'));
    const tracksDir = '/opt/assetto/content/tracks';
    const tracks = fs.readdirSync(tracksDir).filter(f => fs.statSync(path.join(tracksDir,f)).isDirectory());
    const carsDir = '/opt/assetto/content/cars';
    const cars = fs.readdirSync(carsDir).filter(f => fs.statSync(path.join(carsDir,f)).isDirectory());
    const selectedCars = (serverCfg.SERVER&&serverCfg.SERVER.CARS?serverCfg.SERVER.CARS:'').split(';').filter(Boolean);
    res.json({ serverCfg, tracks, cars, selectedCars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ac/track-configs/:track', requireAuth, (req, res) => {
  try {
    const configs = fs.readdirSync(path.join('/opt/assetto/content/tracks',req.params.track)).filter(f => fs.statSync(path.join('/opt/assetto/content/tracks',req.params.track,f)).isDirectory());
    res.json({ configs });
  } catch (e) { res.json({ configs: [] }); }
});

function writeAcConfig(cfgDir, { name, password, track, trackConfig, cars, maxClients, sunAngle, tcpPort, httpPort }) {
  let content = fs.readFileSync(path.join(cfgDir, 'server_cfg.ini'), 'utf8');
  const setVal = (key, value) => {
    value = String(value).replace(/[\r\n]/g, '');
    const regex = new RegExp('^' + key + '=.*$', 'm');
    if (regex.test(content)) content = content.replace(regex, key+'='+value);
    else content = content.replace('[SERVER]', '[SERVER]\n'+key+'='+value);
  };
  if (name) setVal('NAME', name);
  if (password!==undefined) setVal('PASSWORD', password);
  if (track) setVal('TRACK', track);
  if (trackConfig!==undefined) setVal('CONFIG_TRACK', trackConfig);
  if (cars&&Array.isArray(cars)) setVal('CARS', cars.join(';'));
  if (maxClients) setVal('MAX_CLIENTS', maxClients);
  if (sunAngle!==undefined) setVal('SUN_ANGLE', sunAngle);
  if (tcpPort) { setVal('TCP_PORT', tcpPort); setVal('UDP_PORT', tcpPort); }
  if (httpPort) setVal('HTTP_PORT', httpPort);
  fs.writeFileSync(path.join(cfgDir, 'server_cfg.ini'), content);
  if (cars&&Array.isArray(cars)&&cars.length&&maxClients) {
    let entryList = '';
    for (let i=0; i<parseInt(maxClients); i++) {
      const car = cars[i%cars.length];
      entryList += '[CAR_'+i+']\nMODEL='+car+'\nSKIN=default\nSPECTATOR_MODE=0\nDRIVERNAME=\nTEAM=\nGUID=\nBALLAST=0\nRESTRICTOR=0\n\n';
    }
    fs.writeFileSync(path.join(cfgDir, 'entry_list.ini'), entryList);
  }
}

app.post('/api/ac/config', requireAuth, (req, res) => {
  const { name, password, track, trackConfig, cars, maxClients, sunAngle } = req.body;
  try { writeAcConfig(acCfgDir(req.query.id), { name, password, track, trackConfig, cars, maxClients, sunAngle }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ac/restart', requireAuth, (req, res) => {
  exec('sudo systemctl restart assetto', (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    res.json({ success: true });
  });
});

app.get('/api/ac/car-image/:car/:file', requireAuth, (req, res) => {
  const car = req.params.car.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const file = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!['badge.png','preview.jpg','preview.png','dlc_preview.png'].includes(file)) return res.status(400).send('Fichier non autorise');
  const base = path.join('/opt/assetto/content/cars', car);
  for (const p of [path.join(base,'skins','default','preview.jpg'),path.join(base,'ui','preview.jpg'),path.join(base,'ui','preview.png'),path.join(base,'ui','dlc_preview.png'),path.join(base,'ui','badge.png')]) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('Not found');
});

app.get('/api/ac/track-image/:track/:config/:file', requireAuth, (req, res) => {
  const track = req.params.track.replace(/[^a-zA-Z0-9_\-]/g, '');
  const cfg = decodeURIComponent(req.params.config).replace(/[^a-zA-Z0-9_\- ]/g, '');
  const file = req.params.file.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!['preview.png','outline.png','preview.jpg','bgr00.jpg'].includes(file)) return res.status(400).send('Non autorise');
  for (const p of [path.join('/opt/assetto/content/tracks',track,'ui',cfg,file),path.join('/opt/assetto/content/tracks',track,'ui',file)]) {
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('Not found');
});

app.get('/api/ac/cars-meta', requireAuth, (req, res) => {
  try {
    const carsDir = '/opt/assetto/content/cars';
    const result = fs.readdirSync(carsDir).filter(f => fs.statSync(path.join(carsDir,f)).isDirectory()).map(car => {
      let meta = { id: car, name: car, brand: 'Unknown', category: 'Other', tags: [], specs: {} };
      try {
        const uiPath = path.join(carsDir,car,'ui','ui_car.json');
        if (fs.existsSync(uiPath)) {
          const data = JSON.parse(fs.readFileSync(uiPath,'utf8').replace(/[\u0000-\u001F\u007F]/g,' '));
          meta.name = data.name||car; meta.brand = data.brand||'Unknown';
          meta.category = data.class||(data.tags&&data.tags[0])||'Other';
          meta.tags = data.tags||[]; meta.specs = data.specs||{};
        }
      } catch(e) {}
      return meta;
    });
    res.json({ cars: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ac/tracks-meta', requireAuth, (req, res) => {
  try {
    const tracksDir = '/opt/assetto/content/tracks';
    const result = [];
    fs.readdirSync(tracksDir).filter(f => fs.statSync(path.join(tracksDir,f)).isDirectory()).forEach(track => {
      const uiDir = path.join(tracksDir,track,'ui');
      if (!fs.existsSync(uiDir)) { result.push({ id:track, name:track, country:'Unknown', length:'—', configs:[] }); return; }
      const subDirs = fs.readdirSync(uiDir).filter(f => fs.statSync(path.join(uiDir,f)).isDirectory());
      const parseMeta = (jsonPath, fallbackName, sub) => {
        let meta = { id:track, name:fallbackName, country:'Unknown', length:'—', configs:[sub||''], description:'' };
        try {
          if (fs.existsSync(jsonPath)) {
            const data = JSON.parse(fs.readFileSync(jsonPath,'utf8').replace(/[\u0000-\u001F\u007F]/g,' '));
            meta.name = data.name||fallbackName; meta.country = data.country||'Unknown';
            meta.length = data.length?(parseInt(data.length)/1000).toFixed(2)+' km':'—';
            meta.description = data.description||'';
          }
        } catch(e) {}
        return meta;
      };
      if (subDirs.length===0) {
        result.push(parseMeta(path.join(uiDir,'ui_track.json'), track, ''));
      } else {
        subDirs.forEach(sub => result.push(parseMeta(path.join(uiDir,sub,'ui_track.json'), track+' — '+sub, sub)));
      }
    });
    res.json({ tracks: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ac/cars-valid', requireAuth, (req, res) => {
  try {
    const carsDir = '/opt/assetto/content/cars';
    const cars = fs.readdirSync(carsDir).filter(f => fs.statSync(path.join(carsDir,f)).isDirectory() && fs.existsSync(path.join(carsDir,f,'data.acd')));
    res.json({ cars });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const acModStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.params.type==='car'?'/opt/assetto/content/cars':'/opt/assetto/content/tracks'),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const acModUpload = multer({ storage: acModStorage, fileFilter: (req,file,cb) => { const n = file.originalname; if (!n.endsWith('.zip')) return cb(new Error('Seuls .zip')); if (n.includes('/') || n.includes('..')) return cb(new Error('Nom de fichier invalide')); cb(null,true); }, limits: { fileSize: 500*1024*1024 } });

app.post('/api/ac/upload/:type', requireAuth, (req, res) => {
  const { type } = req.params;
  if (!['car','track'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
  acModUpload.single('mod')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier recu' });
    const dest = type==='car'?'/opt/assetto/content/cars':'/opt/assetto/content/tracks';
    execFile('zipinfo', [req.file.path], (err1,list,stderr1) => {
      if (err1) { fs.rmSync(req.file.path, { force: true }); return res.status(500).json({ error: stderr1 || err1.message }); }
      if (/^l/m.test(list)) { fs.rmSync(req.file.path, { force: true }); return res.status(400).json({ error: 'Archive refusée : elle contient des liens symboliques' }); }
      execFile('unzip', ['-o', req.file.path, '-d', dest], (err2,stdout,stderr) => {
        fs.rmSync(req.file.path, { force: true });
        if (err2) return res.status(500).json({ error: stderr });
        res.json({ success: true, message: 'Mod installe dans '+dest });
      });
    });
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { ratePerKwh, newPassword } = req.body;
  if (ratePerKwh) config.electricity.ratePerKwh = parseFloat(ratePerKwh);
  if (newPassword&&newPassword.length>=6) config.panel.password = newPassword;
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  res.json({ success: true });
});

// Historique RAM/CPU/température en mémoire (900 valeurs = 30 min à 2s)
const history = { ram: [], cpu: [], temp: [], timestamps: [] };
const MAX_HISTORY = 900;

app.get('/api/history', requireAuth, (req, res) => {
  res.json(history);
});

// Collecte toutes les 2s
setInterval(async () => {
  try {
    const meminfo = require('fs').readFileSync('/proc/meminfo', 'utf8');
    const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)[1]) * 1024;
    const memAvailable = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)[1]) * 1024;
    const ramPct = Math.round(((memTotal - memAvailable) / memTotal) * 100);
    const cpu1 = require('fs').readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    await new Promise(r => setTimeout(r, 200));
    const cpu2 = require('fs').readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    const cpuPct = Math.round((1 - (cpu2[3]-cpu1[3]) / (cpu2.reduce((a,b)=>a+b,0)-cpu1.reduce((a,b)=>a+b,0))) * 100);
    history.ram.push(ramPct);
    history.cpu.push(cpuPct);
    history.temp.push(await getTemp());
    history.timestamps.push(new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    if (history.ram.length > MAX_HISTORY) { Object.values(history).forEach(a => a.shift()); }
  } catch(e) {}
}, 2000);

app.get('/api/sysinfo', requireAuth, (req, res) => {
  exec('cat /etc/debian_version && java -version 2>&1 && node -v', (err, stdout, stderr) => {
    res.json({ info: stdout+stderr });
  });
});

server.on('upgrade', (req, socket, head) => {
  sessionMiddleware(req, {}, () => {
    if (!req.session || !req.session.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
});

wss.on('connection', (ws, req) => {
  let tail = null;
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'subscribe-logs') {
        const serverName = data.server;
        if (tail) tail.kill();
        if (serverName === 'assetto') {
          tail = spawn('journalctl', ['-u','assetto','-f','-n','50','--no-pager']);
        } else if (['fabric','paper'].includes(serverName)) {
          tail = spawn('tail', ['-f','-n','50',config.servers[serverName].logFile]);
        } else if (created[serverName]) {
          const s = created[serverName];
          tail = s.install !== 'ok' ? spawn('tail', ['-F','-n','200',path.join(s.dir,'install.log')]) : spawn('journalctl', ['-u','gp-'+s.id,'-f','-n','50','--no-pager']);
        } else return;
        tail.stdout.on('data', (chunk) => {
          if (ws.readyState===1) ws.send(JSON.stringify({ type:'log', data:chunk.toString() }));
        });
      }
    } catch(e) {}
  });
  ws.on('close', () => { if (tail) tail.kill(); });
});

// Jamais 0.0.0.0 par défaut : le panel ne doit être joignable que depuis le LAN ou WireGuard.
const HOST = config.panel.host || '127.0.0.1';
server.listen(config.panel.port, HOST, () => {
  console.log('Panel demarre sur ' + HOST + ':' + config.panel.port);
});
