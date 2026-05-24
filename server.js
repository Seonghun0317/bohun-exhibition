const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const app = express();
const server = http.createServer(app);

// WebSocket server — /ws 경로 전용
const wss = new WebSocketServer({ server, path: '/ws' });

// 룸코드: 서버 시작 시 1회 생성 (6자리 대문자)
const ROOM_CODE = crypto.randomBytes(3).toString('hex').toUpperCase();

// 전시 상태
let state = {
  phase: 'start',   // 'start' | 'playing' | 'ending'
  scene: 0,
  choiceMade: false,
  memory: { family: 0, help: 0, observe: 0 }
};

const displays     = new Set();   // LED 화면 클라이언트
const controllers  = new Set();   // 모바일 클라이언트

// 메시지 유틸
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(set, msg, except = null) {
  for (const ws of set) {
    if (ws !== except && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
}

// 속도 제한 — 클라이언트당 1초에 최대 5개 메시지
function makeRateLimiter() {
  let count = 0, timer = null;
  return function check() {
    if (!timer) timer = setTimeout(() => { count = 0; timer = null; }, 1000);
    return ++count <= 5;
  };
}

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://x');
  const role   = url.searchParams.get('role');
  const code   = url.searchParams.get('code');
  const limit  = makeRateLimiter();

  // 역할 검증
  if (role === 'display') {
    displays.add(ws);
    send(ws, { type: 'welcome', role: 'display', code: ROOM_CODE, state });
  } else if (role === 'controller') {
    if (code !== ROOM_CODE) {
      send(ws, { type: 'auth_fail', message: '잘못된 룸코드입니다.' });
      ws.close();
      return;
    }
    controllers.add(ws);
    send(ws, { type: 'welcome', role: 'controller', state });
  } else {
    ws.close();
    return;
  }

  ws.on('message', raw => {
    // 속도 제한
    if (!limit()) return;

    // 크기 제한 (1 KB)
    if (raw.length > 1024) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // ── 컨트롤러 명령 ──
    if (role === 'controller') {
      switch (msg.type) {

        case 'start':
          if (state.phase !== 'start') break;
          state.phase = 'playing';
          broadcast(displays, { type: 'cmd_start' });
          break;

        case 'choice': {
          const idx = msg.idx;
          if (typeof idx !== 'number' || idx < 0 || idx > 2) break;
          if (state.choiceMade || state.phase !== 'playing') break;
          state.choiceMade = true;
          broadcast(displays,    { type: 'cmd_choice', idx });
          broadcast(controllers, { type: 'choice_ack', idx });
          break;
        }

        case 'restart':
          state = { phase: 'start', scene: 0, choiceMade: false,
                    memory: { family: 0, help: 0, observe: 0 } };
          broadcast(displays,    { type: 'cmd_restart' });
          broadcast(controllers, { type: 'cmd_restart' });
          break;
      }
    }

    // ── 디스플레이 리포트 (상태 동기화) ──
    if (role === 'display') {
      if (msg.type === 'scene_ready') {
        const s = msg.scene;
        if (typeof s !== 'number' || s < 0 || s > 4) return;
        state.scene = s;
        state.choiceMade = false;
        if (msg.memory && typeof msg.memory === 'object') {
          state.memory = {
            family:  Number(msg.memory.family)  || 0,
            help:    Number(msg.memory.help)    || 0,
            observe: Number(msg.memory.observe) || 0
          };
        }
        broadcast(controllers, { type: 'scene_ready', scene: state.scene });
      }

      if (msg.type === 'ending') {
        state.phase = 'ending';
        broadcast(controllers, { type: 'ending' });
      }
    }
  });

  ws.on('close', () => {
    displays.delete(ws);
    controllers.delete(ws);
  });

  ws.on('error', () => {
    displays.delete(ws);
    controllers.delete(ws);
  });
});

// 보안 헤더 — static보다 먼저 등록해야 정적 파일에도 적용됨
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 정적 파일 서빙 — index.html, controller.html, assets/
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  dotfiles: 'deny',
}));

server.listen(PORT, () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { lanIP = net.address; break; }
    }
    if (lanIP !== 'localhost') break;
  }

  const bar = '═'.repeat(52);
  console.log(`\n╔${bar}╗`);
  console.log(`║  흥남철수 인터랙티브 전시 서버                          ║`);
  console.log(`╠${bar}╣`);
  console.log(`║  LAN IP      ${lanIP.padEnd(38)}║`);
  console.log(`║  룸 코드     ${ROOM_CODE.padEnd(38)}║`);
  console.log(`╠${bar}╣`);
  console.log(`║  ★ LED 디스플레이 (이 PC 브라우저)                      ║`);
  console.log(`║    http://${lanIP}:${PORT}/?role=display`.padEnd(53) + '║');
  console.log(`╠${bar}╣`);
  console.log(`║  ★ 모바일 QR에 담기는 주소 (폰에서 접속 가능)           ║`);
  console.log(`║    http://${lanIP}:${PORT}/controller.html?code=${ROOM_CODE}`.padEnd(53) + '║');
  console.log(`╚${bar}╝`);
  console.log(`\n  ※ LED 화면을 반드시 위의 LAN IP 주소로 여세요.`);
  console.log(`    localhost 로 열면 QR이 폰에서 동작하지 않습니다.\n`);
});
