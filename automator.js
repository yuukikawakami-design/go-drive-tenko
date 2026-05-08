require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const COM_API = 'https://web-api.com.sd.mo-t.com';
const WEB_API = 'https://web-api.fms.sd.mo-t.com';
const COM_API_KEY = 'mots_JpuS8Y5mpDYXmeXMmNdhgeecZ7R6xR3vcSHwrtZIXvQZHdVhVo7DMULFyBY';
const FMS_API_KEY = 'mots_136uDA2Uv7JI9PG8Sasdkocl4v4wNqIWPsSD9YO0QfvOiAaSmSMsLEh1wH1';
const TOKEN_FILE = path.join(__dirname, '.token.json');
const LOG_DIR = path.join(__dirname, 'logs');

function log(msg) {
  const t = new Date().toLocaleString('ja-JP');
  const line = `[${t}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
    fs.appendFileSync(path.join(LOG_DIR, 'run.log'), line + '\n');
  } catch (_) {}
}

function httpRequest(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Cached credentials { authorization, xApiKey, expiresAt, refreshToken, refreshTokenExpiresAt }
let cachedCreds = null;

function loadCachedCreds() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (data.expiresAt > Date.now() + 60 * 1000) {
        return data;
      }
    }
  } catch (_) {}
  return null;
}

function saveCachedCreds(creds) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(creds));
  } catch (_) {}
}

async function loginWithPassword() {
  log('パスワードログイン中...');
  const res = await httpRequest('POST', `${COM_API}/api/noauth/v1/login`, {
    company_code: process.env.GODRIVE_COMPANY,
    user_code: process.env.GODRIVE_USERNAME,
    password: process.env.GODRIVE_PASSWORD,
  }, { 'x-api-key': COM_API_KEY });

  if (res.status !== 200) {
    throw new Error(`ログイン失敗: ${res.status} ${res.body}`);
  }

  const data = JSON.parse(res.body);
  const token = data.token;
  const expiresAt = new Date(token.access_token_expired).getTime();
  const refreshTokenExpiresAt = new Date(token.refresh_token_expired).getTime();

  return {
    authorization: `Bearer ${token.access_token}`,
    xApiKey: FMS_API_KEY,
    expiresAt,
    refreshToken: token.refresh_token,
    refreshTokenExpiresAt,
  };
}

async function refreshWithToken(refreshToken) {
  log('リフレッシュトークンで更新中...');
  const res = await httpRequest('POST', `${COM_API}/api/noauth/v1/token/refresh`, {
    refresh_token: refreshToken,
  }, { 'x-api-key': COM_API_KEY });

  if (res.status !== 200) {
    return null;
  }

  try {
    const data = JSON.parse(res.body);
    const token = data.token;
    const expiresAt = new Date(token.access_token_expired).getTime();
    const refreshTokenExpiresAt = new Date(token.refresh_token_expired).getTime();
    return {
      authorization: `Bearer ${token.access_token}`,
      xApiKey: FMS_API_KEY,
      expiresAt,
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt,
    };
  } catch (_) {
    return null;
  }
}

async function getApiCreds() {
  // Use in-memory cache if still valid
  if (cachedCreds && cachedCreds.expiresAt > Date.now() + 60 * 1000) {
    return cachedCreds;
  }

  // Try loading from file
  const loaded = loadCachedCreds();
  if (loaded) {
    cachedCreds = loaded;
    return cachedCreds;
  }

  // Try refresh token from stale file
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const stale = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (stale.refreshToken && stale.refreshTokenExpiresAt > Date.now() + 60 * 1000) {
        const refreshed = await refreshWithToken(stale.refreshToken);
        if (refreshed) {
          cachedCreds = refreshed;
          saveCachedCreds(cachedCreds);
          log(`トークン更新成功 (有効期限: ${new Date(cachedCreds.expiresAt).toLocaleString('ja-JP')})`);
          return cachedCreds;
        }
      }
    }
  } catch (_) {}

  // Fall back to password login
  cachedCreds = await loginWithPassword();
  saveCachedCreds(cachedCreds);
  log(`ログイン成功 (有効期限: ${new Date(cachedCreds.expiresAt).toLocaleString('ja-JP')})`);
  return cachedCreds;
}

function buildApiHeaders(creds) {
  return {
    'Authorization': creds.authorization,
    'x-api-key': creds.xApiKey,
    'Origin': 'https://web.console.go-drive-management.com',
    'Referer': 'https://web.console.go-drive-management.com/',
  };
}

async function getDrivers(headers) {
  const res = await httpRequest('GET', `${WEB_API}/api/v1/drivers?office_ids=100461&pre_auto_roll_call_enabled=true`, null, headers);
  if (res.status !== 200) throw new Error(`ドライバー一覧取得失敗: ${res.status} ${res.body}`);
  return JSON.parse(res.body).drivers || [];
}

async function getManagers(headers) {
  const res = await httpRequest('GET', `${WEB_API}/api/v1/managers?office_ids=100461&pre_auto_roll_call_enabled=true`, null, headers);
  if (res.status !== 200) throw new Error(`責任者一覧取得失敗: ${res.status} ${res.body}`);
  return JSON.parse(res.body).managers || [];
}

async function registerTenko({ driverName, tenkoResponsible, scheduledTime, instructions }) {
  log('========================================');
  log(`点呼予定登録開始: ${driverName}`);
  log(`業務開始予定: ${scheduledTime.toLocaleString('ja-JP')}`);
  log(`点呼責任者: ${tenkoResponsible || '(デフォルト)'}`);

  const creds = await getApiCreds();
  const headers = buildApiHeaders(creds);

  const [drivers, managers] = await Promise.all([getDrivers(headers), getManagers(headers)]);

  const driver = drivers.find(d => d.user?.name === driverName);
  if (!driver) {
    throw new Error(`ドライバーが見つかりません: ${driverName}\n利用可能: ${drivers.map(d => d.user?.name).join(', ')}`);
  }
  log(`ドライバーID: ${driver.id} (${driverName})`);

  const managerName = tenkoResponsible || managers.find(m => m.name !== driverName)?.name || managers[0]?.name;
  const manager = managers.find(m => m.name === managerName);
  if (!manager) {
    throw new Error(`点呼責任者が見つかりません: ${managerName}\n利用可能: ${managers.map(m => m.name).join(', ')}`);
  }
  log(`責任者ID: ${manager.id} (${manager.name})`);

  const body = {
    driver_id: driver.id,
    manager_id: manager.id,
    start_at: scheduledTime.toISOString(),
    instruction: instructions || '安全運転をお願いします',
    is_repeatable: false,
  };

  log(`API POST: driver_id=${body.driver_id}, start_at=${body.start_at}`);
  const res = await httpRequest('POST', `${WEB_API}/api/v1/pre_auto_roll_call_schedules`, body, headers);

  if (res.status >= 300) {
    throw new Error(`点呼予定登録失敗: ${res.status} ${res.body}`);
  }

  const result = JSON.parse(res.body);
  log(`✅ 点呼予定登録完了: ID=${result.id}, ${driverName} @ ${scheduledTime.toLocaleString('ja-JP')}`);
  return result;
}

async function updateEndTime({ driverId, driverName, endTime }) {
  log('========================================');
  log(`終業時刻更新: ${driverName}`);
  log(`退勤予定時刻: ${endTime}`);

  const creds = await getApiCreds();
  const headers = buildApiHeaders(creds);

  const body = {
    driver_id: driverId,
    driving_estimated_end: { type: 1, time: endTime },
    auto_roll_call_enabled: true,
  };

  log(`API POST: driver_id=${driverId}, time=${endTime}`);
  const res = await httpRequest('POST', `${WEB_API}/api/v1/driver_roll_call_settings`, body, headers);

  if (res.status >= 300) {
    throw new Error(`終業時刻更新失敗: ${res.status} ${res.body}`);
  }

  const result = JSON.parse(res.body);
  log(`✅ 終業時刻更新完了: ${driverName} @ ${endTime} (id=${result.id})`);
  return result;
}

module.exports = { registerTenko, updateEndTime };
