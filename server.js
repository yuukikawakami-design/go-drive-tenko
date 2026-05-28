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

// カメラアプリ直接スキャン用URLエンドポイント
// QRコードに https://go-drive-tenko.onrender.com/scan/driver_kawakami?type=pre を埋め込む
app.get('/scan/:qrCode', async (req, res) => {
  const { qrCode } = req.params;
  const type = req.query.type || 'pre';

  const driver = config.drivers.find(d => d.qrCode === qrCode);
  if (!driver) {
    return res.send(resultPage('エラー', `未登録のQRコードです`, '', 'error'));
  }

  const scanTime = new Date();
  const isPre = type === 'pre';

  if (!isPre) {
    // 終業後点呼
    const endTime = String(scanTime.getHours()).padStart(2, '0') + ':' + String(scanTime.getMinutes()).padStart(2, '0');
    log(`✅ 終業URLスキャン: ${driver.driverName} → ${endTime}`);

    updateEndTime({ driverId: driver.driverId, driverName: driver.driverName, endTime })
      .catch(err => log(`❌ 終業時刻更新失敗 [${driver.driverName}]: ${err.message}`));

    return res.send(resultPage(
      driver.driverName,
      `退勤時刻 ${endTime} を登録しました`,
      '業務後自動点呼が実施されます',
      'post'
    ));
  }

  // 業務前点呼
  const offsetMs = (config.delayMinutes || 5) * 60 * 1000;
  const scheduledTime = new Date(scanTime.getTime() + offsetMs);
  const tenkoResponsible = driver.tenkoResponsible || config.defaultTenkoResponsible;
  const timeStr = scheduledTime.toLocaleString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

  log(`✅ 業務前URLスキャン: ${driver.driverName} → ${timeStr}`);

  registerTenko({
    driverName: driver.driverName,
    tenkoResponsible,
    scheduledTime,
    instructions: driver.instructions || config.defaultInstruction || '安全運転をお願いします',
  }).catch(err => log(`❌ 登録失敗 [${driver.driverName}]: ${err.message}`));

  return res.send(resultPage(
    driver.driverName,
    `業務開始予定: ${timeStr}`,
    '業務前自動点呼を登録しました',
    'pre'
  ));
});

function resultPage(name, mainMsg, subMsg, type) {
  const isPre = type === 'pre';
  const isError = type === 'error';
  const color = isError ? '#ef4444' : isPre ? '#38bdf8' : '#f97316';
  const icon = isError ? '❌' : '✅';
  const badge = isError ? '' : isPre ? '業務前点呼' : '終業後点呼';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isPre ? '業務前点呼' : '終業後点呼'} 完了</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, 'Hiragino Sans', sans-serif;
      background: #0f172a; color: #f1f5f9;
      min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 24px;
    }
    .card {
      background: #1e293b; border-radius: 20px;
      padding: 36px 28px; width: 100%; max-width: 360px; text-align: center;
    }
    .icon { font-size: 56px; margin-bottom: 12px; }
    .badge {
      display: inline-block; padding: 4px 16px; border-radius: 999px;
      font-size: 12px; font-weight: 700; margin-bottom: 14px;
      background: ${isPre ? '#0c4a6e' : '#431407'}; color: ${color};
    }
    .name { font-size: 28px; font-weight: 800; color: ${color}; margin-bottom: 6px; }
    .main { font-size: 15px; color: #e2e8f0; margin-bottom: 6px; }
    .sub { font-size: 13px; color: #64748b; }
    .close-hint { margin-top: 28px; font-size: 12px; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    ${badge ? `<div class="badge">${badge}</div>` : ''}
    <div class="name">${name}</div>
    <div class="main">${mainMsg}</div>
    <div class="sub">${subMsg}</div>
    <div class="close-hint">このページを閉じてください</div>
  </div>
</body>
</html>`;
}

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
