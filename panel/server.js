const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');
const { Rcon } = require('rcon-client');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
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
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new FileStore({ path: './sessions', ttl: 86400, retries: 0 }),
  secret: config.panel.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 86400000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/ac-preview', express.static('/opt/assetto/content'));

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
    const rcon = await Rcon.connect({ host: config.servers[serverName].rcon.host, port: config.servers[serverName].rcon.port, password: config.servers[serverName].rcon.password, timeout: 2000 });
    const response = await rcon.send('list');
    await rcon.end();
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
    let temp = null;
    try {
      temp = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000;
    } catch (e) {
      try {
        const s = await new Promise((resolve, reject) => { exec('sensors coretemp-isa-0000', (err, stdout) => { if (err) reject(err); else resolve(stdout); }); });
        const m = s.match(/Core 0:\s+\+?([\d.]+).C/);
        if (m) temp = parseFloat(m[1]);
      } catch (e2) {}
    }
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
  if (!['fabric','paper'].includes(name)) return res.status(400).json({ error: 'Serveur invalide' });
  if (!['start','stop','restart'].includes(action)) return res.status(400).json({ error: 'Action invalide' });
  exec('sudo systemctl ' + action + ' ' + (name==='fabric'?'msh-fabric':'msh-paper'), (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    res.json({ success: true });
  });
});

app.post('/api/servers/:name/command', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { command } = req.body;
  if (!command || command.includes(';') || command.includes('&') || command.includes('|')) return res.status(400).json({ error: 'Commande invalide' });
  const serverConfig = config.servers[name];
  if (!serverConfig) return res.status(400).json({ error: 'Serveur invalide' });
  try {
    const rcon = await Rcon.connect({ host: serverConfig.rcon.host, port: serverConfig.rcon.port, password: serverConfig.rcon.password });
    const response = await rcon.send(command);
    await rcon.end();
    res.json({ success: true, response });
  } catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
});

const MC_PATHS = { fabric: '/opt/minecraft/fabric/server.properties', paper: '/opt/minecraft/paper/server.properties' };
const WHITELIST_PATHS = { fabric: '/opt/minecraft/fabric/whitelist.json', paper: '/opt/minecraft/paper/whitelist.json' };
const OPS_PATHS = { fabric: '/opt/minecraft/fabric/ops.json', paper: '/opt/minecraft/paper/ops.json' };

app.get('/api/mc/:name/config', requireAuth, (req, res) => {
  const { name } = req.params;
  if (!MC_PATHS[name]) return res.status(400).json({ error: 'Serveur invalide' });
  try { res.json({ props: readServerProperties(MC_PATHS[name]) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mc/:name/config', requireAuth, (req, res) => {
  const { name } = req.params;
  if (!MC_PATHS[name]) return res.status(400).json({ error: 'Serveur invalide' });
  try {
    const allowed = ['max-players','view-distance','simulation-distance','motd','difficulty','gamemode','pvp','spawn-protection','online-mode','white-list','enforce-whitelist','allow-flight','level-name'];
    const updates = {};
    allowed.forEach(key => { if (req.body[key] !== undefined) updates[key] = req.body[key]; });
    writeServerProperties(MC_PATHS[name], updates);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mc/:name/whitelist', requireAuth, (req, res) => {
  const { name } = req.params;
  if (!WHITELIST_PATHS[name]) return res.status(400).json({ error: 'Serveur invalide' });
  try { res.json({ whitelist: JSON.parse(fs.readFileSync(WHITELIST_PATHS[name], 'utf8') || '[]') }); } catch (e) { res.json({ whitelist: [] }); }
});

app.post('/api/mc/:name/whitelist/add', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { player } = req.body;
  if (!player || !/^[a-zA-Z0-9_]{2,16}$/.test(player)) return res.status(400).json({ error: 'Nom invalide' });
  try {
    const rcon = await Rcon.connect({ host: config.servers[name].rcon.host, port: config.servers[name].rcon.port, password: config.servers[name].rcon.password, timeout: 2000 });
    const response = await rcon.send('whitelist add ' + player);
    await rcon.end();
    res.json({ success: true, response });
  } catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
});

app.post('/api/mc/:name/whitelist/remove', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { player } = req.body;
  if (!player || !/^[a-zA-Z0-9_]{2,16}$/.test(player)) return res.status(400).json({ error: 'Nom invalide' });
  try {
    const rcon = await Rcon.connect({ host: config.servers[name].rcon.host, port: config.servers[name].rcon.port, password: config.servers[name].rcon.password, timeout: 2000 });
    const response = await rcon.send('whitelist remove ' + player);
    await rcon.end();
    res.json({ success: true, response });
  } catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
});

app.get('/api/mc/:name/ops', requireAuth, (req, res) => {
  const { name } = req.params;
  if (!OPS_PATHS[name]) return res.status(400).json({ error: 'Serveur invalide' });
  try { res.json({ ops: JSON.parse(fs.readFileSync(OPS_PATHS[name], 'utf8') || '[]') }); } catch (e) { res.json({ ops: [] }); }
});

app.post('/api/mc/:name/ops/add', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { player } = req.body;
  if (!player || !/^[a-zA-Z0-9_]{2,16}$/.test(player)) return res.status(400).json({ error: 'Nom invalide' });
  try {
    const rcon = await Rcon.connect({ host: config.servers[name].rcon.host, port: config.servers[name].rcon.port, password: config.servers[name].rcon.password, timeout: 2000 });
    const response = await rcon.send('op ' + player);
    await rcon.end();
    res.json({ success: true, response });
  } catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
});

app.post('/api/mc/:name/ops/remove', requireAuth, async (req, res) => {
  const { name } = req.params;
  const { player } = req.body;
  if (!player || !/^[a-zA-Z0-9_]{2,16}$/.test(player)) return res.status(400).json({ error: 'Nom invalide' });
  try {
    const rcon = await Rcon.connect({ host: config.servers[name].rcon.host, port: config.servers[name].rcon.port, password: config.servers[name].rcon.password, timeout: 2000 });
    const response = await rcon.send('deop ' + player);
    await rcon.end();
    res.json({ success: true, response });
  } catch (e) { res.status(500).json({ error: 'RCON indisponible' }); }
});

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
    const serverCfg = ini.parse(fs.readFileSync('/opt/assetto/cfg/server_cfg.ini', 'utf8'));
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

app.post('/api/ac/config', requireAuth, (req, res) => {
  try {
    const { name, password, track, trackConfig, cars, maxClients, sunAngle } = req.body;
    let content = fs.readFileSync('/opt/assetto/cfg/server_cfg.ini', 'utf8');
    const setVal = (key, value) => {
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
    fs.writeFileSync('/opt/assetto/cfg/server_cfg.ini', content);
    if (cars&&Array.isArray(cars)&&maxClients) {
      let entryList = '';
      for (let i=0; i<parseInt(maxClients); i++) {
        const car = cars[i%cars.length];
        entryList += '[CAR_'+i+']\nMODEL='+car+'\nSKIN=default\nSPECTATOR_MODE=0\nDRIVERNAME=\nTEAM=\nGUID=\nBALLAST=0\nRESTRICTOR=0\n\n';
      }
      fs.writeFileSync('/opt/assetto/cfg/entry_list.ini', entryList);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
const acModUpload = multer({ storage: acModStorage, fileFilter: (req,file,cb) => file.originalname.endsWith('.zip')?cb(null,true):cb(new Error('Seuls .zip')), limits: { fileSize: 500*1024*1024 } });

app.post('/api/ac/upload/:type', requireAuth, (req, res) => {
  const { type } = req.params;
  if (!['car','track'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
  acModUpload.single('mod')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier recu' });
    const dest = type==='car'?'/opt/assetto/content/cars':'/opt/assetto/content/tracks';
    exec('cd "'+dest+'" && unzip -o "'+req.file.originalname+'" && rm "'+req.file.originalname+'"', (err2,stdout,stderr) => {
      if (err2) return res.status(500).json({ error: stderr });
      res.json({ success: true, message: 'Mod installe dans '+dest });
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

// Historique RAM/CPU en mémoire (900 valeurs = 30 min à 2s)
const history = { ram: [], cpu: [], timestamps: [] };
const MAX_HISTORY = 900;

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ ram: history.ram, cpu: history.cpu, timestamps: history.timestamps });
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
    history.timestamps.push(new Date().toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    if (history.ram.length > MAX_HISTORY) { history.ram.shift(); history.cpu.shift(); history.timestamps.shift(); }
  } catch(e) {}
}, 2000);

app.get('/api/sysinfo', requireAuth, (req, res) => {
  exec('cat /etc/debian_version && java -version 2>&1 && node -v', (err, stdout, stderr) => {
    res.json({ info: stdout+stderr });
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
        } else return;
        tail.stdout.on('data', (chunk) => {
          if (ws.readyState===1) ws.send(JSON.stringify({ type:'log', data:chunk.toString() }));
        });
      }
    } catch(e) {}
  });
  ws.on('close', () => { if (tail) tail.kill(); });
});

server.listen(config.panel.port, '0.0.0.0', () => {
  console.log('Panel demarre sur port ' + config.panel.port);
});
