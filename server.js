const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Config
let config = { port: 80, ip: "", autoUpdate: true, patchRepo: "abibisgomulsang/abibi-patch", currentVersion: "2.0" };
const cfgPath = path.join(__dirname, 'config.json');
try { if (fs.existsSync(cfgPath)) config = { ...config, ...JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) }; } catch(e) {}
const PORT = config.port || 3000;
let FIXED_IP = config.ip || "";

// ═══ 스마트 로컬 IP 감지 ═══
// 진짜 로컬 네트워크 IP만 선별 (VPN, CGNAT, 가상 어댑터 제외)
function detectLocalIP() {
  const ni = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ni)) {
    for (const iface of ni[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      const lowerName = name.toLowerCase();

      // 제외: 가상/VPN 어댑터 이름
      if (lowerName.includes('vmware') || lowerName.includes('virtualbox') ||
          lowerName.includes('vethernet') || lowerName.includes('hyper-v') ||
          lowerName.includes('tailscale') || lowerName.includes('zerotier') ||
          lowerName.includes('vpn') || lowerName.includes('docker') ||
          lowerName.includes('wsl') || lowerName.includes('loopback')) continue;

      // 제외: 특수 IP 대역
      if (ip.startsWith('169.254.')) continue;   // APIPA (자동 사설)
      if (ip.startsWith('100.')) continue;        // CGNAT / Tailscale
      if (ip.startsWith('127.')) continue;        // 루프백

      // 우선순위 점수 매기기
      let score = 0;
      if (ip.startsWith('192.168.')) score = 100;       // 가장 일반적인 가정/사무실
      else if (ip.startsWith('10.')) score = 80;         // 사설망
      else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) score = 70; // 172.16~31
      else score = 10;                                    // 기타 (공인 IP 등)

      // 이더넷 우선 (유선이 더 안정적)
      if (lowerName.includes('이더넷') || lowerName.includes('ethernet')) score += 5;
      // Wi-Fi
      if (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('무선')) score += 3;

      candidates.push({ ip, name, score });
    }
  }

  if (candidates.length === 0) return 'localhost';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].ip;
}

// 사용 가능한 모든 로컬 IP 목록 (관리자가 선택할 수 있도록)
function listLocalIPs() {
  const ni = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ni)) {
    for (const iface of ni[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (ip.startsWith('169.254.') || ip.startsWith('127.')) continue;
      list.push({ ip, adapter: name });
    }
  }
  return list;
}

// ═══ IP 고정 저장 ═══
// 처음 실행 시 IP가 비어있으면 자동 감지해서 config.json에 저장 → 다음부터 고정
function saveIPToConfig(ip) {
  try {
    config.ip = ip;
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
    FIXED_IP = ip;
    return true;
  } catch(e) { return false; }
}

// 시작 시 IP 고정 처리
if (!FIXED_IP) {
  const detected = detectLocalIP();
  if (detected && detected !== 'localhost') {
    saveIPToConfig(detected);
    console.log('  [자동] 로컬 IP 감지 및 고정: ' + detected);
  }
}

app.use(express.json({ limit: '50mb' }));

// Shared Data API
app.get('/api/shared/:key', (req, res) => {
  const fp = path.join(DATA_DIR, encodeURIComponent(req.params.key) + '.json');
  try { if (fs.existsSync(fp)) res.json({ value: fs.readFileSync(fp, 'utf-8') }); else res.json({ value: null }); } catch(e) { res.json({ value: null }); }
});
app.post('/api/shared/:key', (req, res) => {
  const fp = path.join(DATA_DIR, encodeURIComponent(req.params.key) + '.json');
  try { fs.writeFileSync(fp, JSON.stringify(req.body.value), 'utf-8'); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// Backup / Restore
app.post('/api/backup', (req, res) => {
  try {
    const dir = req.body.path || path.join(__dirname, 'backups', new Date().toISOString().slice(0,10));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    files.forEach(f => fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f)));
    res.json({ ok: true, path: dir, count: files.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/backup/save', (req, res) => {
  try {
    const all = {};
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).forEach(f => { all[f] = fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'); });
    res.json(all);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/backup/restore', (req, res) => {
  try {
    const data = req.body;
    Object.entries(data).forEach(([fn, content]) => { if (fn.endsWith('.json')) fs.writeFileSync(path.join(DATA_DIR, fn), content, 'utf-8'); });
    res.json({ ok: true, count: Object.keys(data).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══ 암호화 엑셀 복호화 API ═══
let multer, upload;
try { multer = require('multer'); upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); } catch(e) {}

app.post('/api/decrypt-excel', (req, res) => {
  if (!upload) return res.status(500).json({ error: 'multer 미설치. npm install 실행 필요' });
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const password = req.body.password || '';
      const fileBuffer = req.file.buffer;
      let decryptedBuffer = fileBuffer;
      try {
        const officeCrypto = require('officecrypto-tool');
        if (officeCrypto.isEncrypted && officeCrypto.isEncrypted(fileBuffer)) {
          decryptedBuffer = await officeCrypto.decrypt(fileBuffer, { password });
        }
      } catch(decErr) {
        return res.status(400).json({ error: '비밀번호가 틀리거나 복호화 실패: ' + decErr.message });
      }
      const XLSX = require('xlsx');
      const wb = XLSX.read(decryptedBuffer, { type: 'buffer' });
      let data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      if (data.length > 0 && !data[0]['상품명']) {
        const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
        const hi = raw.findIndex(r => r && r.some(c => String(c).includes('상품명')));
        if (hi >= 0) {
          const hd = raw[hi];
          data = raw.slice(hi + 1).filter(r => r && r.length > 0).map(row => {
            const o = {}; hd.forEach((h, i) => { if (h) o[String(h).trim()] = row[i]; }); return o;
          });
        }
      }
      data.forEach(r => { if (!r['옵션관리코드']) r['옵션관리코드'] = ''; if (!r['상품종류']) r['상품종류'] = ''; });
      res.json({ ok: true, data, count: data.length });
    } catch(e) { res.status(400).json({ error: '파일 처리 실패: ' + e.message }); }
  });
});

// Worker app
// ★ 캐시 방지 헤더 (모바일이 항상 최신 파일 받도록)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path === '/worker' || req.path === '/worker/') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use('/worker', express.static(path.join(__dirname, 'worker', 'dist')));
app.get('/worker/*', (req, res) => res.sendFile(path.join(__dirname, 'worker', 'dist', 'index.html')));

// ═══ Server Info + IP 관리 API ═══
app.get('/api/server-info', (req, res) => {
  const ip = FIXED_IP || detectLocalIP();
  res.json({
    ip, port: PORT,
    fixed: !!FIXED_IP,
    adminUrl: 'http://' + ip + (PORT === 80 ? '' : ':' + PORT),
    workerUrl: 'http://' + ip + (PORT === 80 ? '' : ':' + PORT) + '/worker',
    availableIPs: listLocalIPs()
  });
});

// ★ 관리자가 IP를 수동으로 변경/고정하는 API
app.post('/api/set-ip', (req, res) => {
  try {
    const newIP = (req.body.ip || '').trim();
    if (!newIP) return res.status(400).json({ error: 'IP를 입력하세요' });
    saveIPToConfig(newIP);
    res.json({ ok: true, ip: newIP, message: 'IP가 ' + newIP + '(으)로 고정되었습니다. 서버 재시작 후 적용됩니다.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ★ IP 자동 재감지 (다시 잡기)
app.post('/api/redetect-ip', (req, res) => {
  try {
    const detected = detectLocalIP();
    if (detected && detected !== 'localhost') {
      saveIPToConfig(detected);
      res.json({ ok: true, ip: detected, message: 'IP를 다시 감지했습니다: ' + detected });
    } else {
      res.status(400).json({ error: '로컬 IP를 찾을 수 없습니다' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ★ 포트 변경 API
app.post('/api/set-port', (req, res) => {
  try {
    const newPort = parseInt(req.body.port);
    if (!newPort || newPort < 1 || newPort > 65535) return res.status(400).json({ error: '올바른 포트 번호를 입력하세요 (1~65535)' });
    config.port = newPort;
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ ok: true, port: newPort, message: '포트가 ' + newPort + '(으)로 변경되었습니다. 서버 재시작 후 적용됩니다.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/qr', async (req, res) => {
  try {
    const QRCode = require('qrcode');
    const ip = FIXED_IP || detectLocalIP();
    const url = req.query.url || ('http://' + ip + (PORT === 80 ? '' : ':' + PORT) + '/worker');
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 256 });
    res.set('Content-Type', 'image/svg+xml'); res.send(svg);
  } catch(e) {
    const ip = FIXED_IP || detectLocalIP();
    const portStr = PORT === 80 ? '' : ':' + PORT;
    res.set('Content-Type', 'image/svg+xml');
    res.send('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="60"><text x="10" y="30" font-size="11" font-family="monospace">http://' + ip + portStr + '/worker</text><text x="10" y="50" font-size="9" fill="#999">npm install qrcode</text></svg>');
  }
});

// Admin app
app.use('/', express.static(path.join(__dirname, 'admin', 'dist')));
app.get('/*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/worker'))
    res.sendFile(path.join(__dirname, 'admin', 'dist', 'index.html'));
});

const displayIP = FIXED_IP || detectLocalIP();

// Port conflict auto-handling
const killPort = () => {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const result = execSync('netstat -ano | findstr :' + PORT + ' | findstr LISTENING', { encoding: 'utf-8', timeout: 3000 });
      const pids = new Set();
      result.trim().split('\n').forEach(line => { const p = line.trim().split(/\s+/).pop(); if (p && p !== '0' && p !== String(process.pid)) pids.add(p); });
      pids.forEach(pid => { try { execSync('taskkill /PID ' + pid + ' /F', { timeout: 3000 }); console.log('  * 기존 서버 종료 (PID: ' + pid + ')'); } catch(e) {} });
      if (pids.size > 0) { const end = Date.now() + 1000; while (Date.now() < end) {} }
    }
  } catch(e) {}
};


// ═══ 온라인 자동 업데이트 (GitHub) ═══
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'ABIBI-Updater', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } };
    https.get(url, opts, (res) => {
      // 리다이렉트 처리 (GitHub raw/release)
      if (res.statusCode === 301 || res.statusCode === 302) {
        return httpsGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function checkAndUpdate() {
  if (config.autoUpdate === false) return;
  const repo = config.patchRepo || 'abibisgomulsang/abibi-patch';
  const base = 'https://raw.githubusercontent.com/' + repo + '/main/';
  try {
    console.log('  [업데이트] 최신 버전 확인 중...');
    const cacheBust = '?t=' + Date.now();
    const verBuf = await httpsGet(base + 'version.json' + cacheBust);
    const remote = JSON.parse(verBuf.toString('utf-8'));
    const localVer = config.currentVersion || '0.0';

    if (remote.version && remote.version !== localVer) {
      console.log('  [업데이트] 새 버전 발견: ' + localVer + ' -> ' + remote.version);
      let AdmZip;
      try { AdmZip = require('adm-zip'); }
      catch(e) { console.log('  [업데이트] adm-zip 미설치 - 자동 업데이트 건너뜀 (npm install adm-zip)'); return; }

      // ★ 패치 전 데이터 자동 백업 (안전장치)
      try {
        const backupDir = path.join(__dirname, 'backups', 'auto-' + new Date().toISOString().slice(0,10));
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
        dataFiles.forEach(f => fs.copyFileSync(path.join(DATA_DIR, f), path.join(backupDir, f)));
        console.log('  [업데이트] 데이터 백업 완료 (' + dataFiles.length + '개 파일) - 배분 데이터는 안전합니다');
      } catch(e) { console.log('  [업데이트] 백업 건너뜀: ' + e.message); }

      // ★ admin 다운로드 & 교체 (dist 화면 코드만 교체, data 폴더는 절대 안 건드림)
      console.log('  [업데이트] admin 화면 교체 중... (배분 데이터 유지)');
      const adminZip = await httpsGet(base + 'admin.zip' + cacheBust);
      const adminDir = path.join(__dirname, 'admin', 'dist');
      new AdmZip(adminZip).extractAllTo(adminDir, true);

      // worker 다운로드 & 교체
      console.log('  [업데이트] worker 다운로드 중...');
      const workerZip = await httpsGet(base + 'worker.zip' + cacheBust);
      const workerDir = path.join(__dirname, 'worker', 'dist');
      new AdmZip(workerZip).extractAllTo(workerDir, true);

      // 버전 기록
      config.currentVersion = remote.version;
      try { fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf-8'); } catch(e) {}

      console.log('  [업데이트] ✅ 완료! 최신 버전 ' + remote.version + ' 적용됨');
      console.log('  [업데이트] 브라우저를 새로고침하세요.');
      updateStatus = { updated: true, version: remote.version, at: new Date().toISOString() };
    } else {
      console.log('  [업데이트] 이미 최신 버전 (' + localVer + ')');
      updateStatus = { updated: false, version: localVer, at: new Date().toISOString() };
    }
  } catch(e) {
    console.log('  [업데이트] 확인 실패 (오프라인이거나 저장소 없음): ' + e.message);
    updateStatus = { updated: false, error: e.message, at: new Date().toISOString() };
  }
}

let updateStatus = { checking: true };

// 업데이트 상태 조회 API
app.get('/api/update-status', (req, res) => res.json(updateStatus));

// 수동 업데이트 확인 API
app.post('/api/check-update', async (req, res) => {
  await checkAndUpdate();
  res.json(updateStatus);
});

const startServer = () => {
  const portStr = PORT === 80 ? '' : ':' + PORT;
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n  ========================================');
    console.log('   ABIBI - Local Network Server');
    console.log('  ========================================\n');
    console.log('  Admin:  http://' + displayIP + portStr);
    console.log('  Worker: http://' + displayIP + portStr + '/worker\n');
    if (FIXED_IP) console.log('  * Fixed IP: ' + FIXED_IP + ' (config.json에 고정됨)');
    console.log('  ========================================\n');
    // 서버 시작 후 자동 업데이트 확인
    setTimeout(() => checkAndUpdate(), 1000);
    // ★ 3분마다 자동 업데이트 확인 (GitHub에 올리면 최대 3분 내 자동 적용)
    setInterval(() => checkAndUpdate(), 3 * 60 * 1000);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('\n  [!] 포트 ' + PORT + ' 사용 중 — 기존 서버 종료 시도...');
      killPort();
      setTimeout(() => { console.log('  [!] 재시작 중...\n'); startServer(); }, 1500);
    } else throw err;
  });
};
startServer();
