require('dotenv').config();
const express = require('express');
const path = require('path');
const { registerTenko } = require('./automator');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const config = require('./config.json');

// ドライバーごとの保留ジョブ管理
const pendingJobs = new Map();

function log(msg) {
  console.log(`[${new Date().toLocaleString('ja-JP')}] ${msg}`);
}

// QRスキャン受信エンドポイント
app.post('/api/scan', (req, res) => {
  const { qrCode } = req.body;
  if (!qrCode) {
    return res.status(400).json({ success: false, error: 'QRコードが空です' });
  }

  const driver = config.drivers.find(d => d.qrCode === qrCode);
  if (!driver) {
    log(`未登録QRコード: ${qrCode}`);
    return res.status(404).json({ success: false, error: `未登録のQRコードです: ${qrCode}` });
  }

  const scanTime = new Date();
  const offsetMs = (config.delayMinutes || 5) * 60 * 1000;
  const scheduledTime = new Date(scanTime.getTime() + offsetMs);
  const tenkoResponsible = driver.tenkoResponsible || config.defaultTenkoResponsible;

  log(`✅ スキャン受付: ${driver.driverName} → 業務開始予定 ${scheduledTime.toLocaleString('ja-JP')}`);

  // 非同期で即登録
  (async () => {
    try {
      await registerTenko({
        driverName: driver.driverName,
        tenkoResponsible,
        scheduledTime,
        instructions: driver.instructions || config.defaultInstruction || '安全運転をお願いします',
      });
    } catch (err) {
      log(`❌ 登録失敗 [${driver.driverName}]: ${err.message}`);
    }
  })();

  res.json({
    success: true,
    driverName: driver.driverName,
    scheduledTime: scheduledTime.toISOString(),
    tenkoResponsible,
    delayMinutes: config.delayMinutes || 5,
  });
});

// 保留中ジョブの確認
app.get('/api/pending', (req, res) => {
  const jobs = [];
  for (const [qrCode, job] of pendingJobs) {
    jobs.push({
      qrCode,
      driverName: job.driverName,
      scheduledTime: job.scheduledTime,
    });
  }
  res.json({ pending: jobs });
});

// ドライバー一覧（デバッグ用）
app.get('/api/drivers', (req, res) => {
  res.json({ drivers: config.drivers.map(d => ({ qrCode: d.qrCode, driverName: d.driverName })) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  // LAN IPアドレスを表示
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }
  console.log('');
  console.log('🚀 GOドライブ 自動点呼アプリ 起動中');
  console.log('────────────────────────────────');
  console.log(`📱 スマホからアクセス: http://${localIP}:${PORT}`);
  console.log(`💻 PCからアクセス:    http://localhost:${PORT}`);
  console.log('────────────────────────────────');
  console.log('');
});
