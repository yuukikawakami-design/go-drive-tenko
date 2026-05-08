require('dotenv').config();
const express = require('express');
const path = require('path');
const { registerTenko, updateEndTime } = require('./automator');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const config = require('./config.json');

function log(msg) {
  console.log(`[${new Date().toLocaleString('ja-JP')}] ${msg}`);
}

// QRスキャン受信エンドポイント
app.post('/api/scan', (req, res) => {
  const { qrCode, type = 'pre' } = req.body; // type: 'pre'=業務前, 'post'=終業後
  if (!qrCode) {
    return res.status(400).json({ success: false, error: 'QRコードが空です' });
  }

  const driver = config.drivers.find(d => d.qrCode === qrCode);
  if (!driver) {
    log(`未登録QRコード: ${qrCode}`);
    return res.status(404).json({ success: false, error: `未登録のQRコードです: ${qrCode}` });
  }

  const scanTime = new Date();

  if (type === 'post') {
    // 終業後点呼：退勤予定時刻をスキャン時刻に更新
    const endTime = String(scanTime.getHours()).padStart(2, '0') + ':' + String(scanTime.getMinutes()).padStart(2, '0');
    log(`✅ 終業スキャン受付: ${driver.driverName} → 退勤時刻 ${endTime}`);

    (async () => {
      try {
        await updateEndTime({
          driverId: driver.driverId,
          driverName: driver.driverName,
          endTime,
        });
      } catch (err) {
        log(`❌ 終業時刻更新失敗 [${driver.driverName}]: ${err.message}`);
      }
    })();

    return res.json({
      success: true,
      type: 'post',
      driverName: driver.driverName,
      endTime,
      message: `退勤時刻を ${endTime} に設定しました。自動点呼が実施されます。`,
    });
  }

  // 業務前点呼：5分後の時刻で点呼予定を登録
  const offsetMs = (config.delayMinutes || 5) * 60 * 1000;
  const scheduledTime = new Date(scanTime.getTime() + offsetMs);
  const tenkoResponsible = driver.tenkoResponsible || config.defaultTenkoResponsible;

  log(`✅ 業務前スキャン受付: ${driver.driverName} → 業務開始予定 ${scheduledTime.toLocaleString('ja-JP')}`);

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
    type: 'pre',
    driverName: driver.driverName,
    scheduledTime: scheduledTime.toISOString(),
    tenkoResponsible,
    delayMinutes: config.delayMinutes || 5,
  });
});

// ドライバー一覧
app.get('/api/drivers', (req, res) => {
  res.json({ drivers: config.drivers.map(d => ({ qrCode: d.qrCode, driverName: d.driverName })) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) { localIP = iface.address; break; }
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
