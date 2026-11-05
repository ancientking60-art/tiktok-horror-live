'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn('Could not persist config.json (ephemeral disk?):', err.message);
  }
}

let config = loadConfig();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());

// Render / uptime health check (keep-alive friendly)
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    connection: getConnectionStatus().state
  });
});

app.use(express.static(path.join(ROOT, 'public')));

// Helpful Range support is built into express.static for video seeking.

app.get('/api/config', (_req, res) => {
  res.json({
    ...config,
    connection: getConnectionStatus()
  });
});

app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (typeof body.tiktokUsername === 'string') {
    config.tiktokUsername = body.tiktokUsername.replace(/^@/, '').trim();
  }
  if (typeof body.showCaption === 'boolean') config.showCaption = body.showCaption;
  if (typeof body.instantCooldownMs === 'number') config.instantCooldownMs = body.instantCooldownMs;
  if (typeof body.joinThrottleMs === 'number') config.joinThrottleMs = body.joinThrottleMs;
  if (typeof body.roseMaxCoins === 'number') config.roseMaxCoins = body.roseMaxCoins;
  if (typeof body.idleVolume === 'number') config.idleVolume = body.idleVolume;
  if (typeof body.scareVolume === 'number') config.scareVolume = body.scareVolume;
  if (typeof body.idleVolumeDuringScare === 'number') {
    config.idleVolumeDuringScare = body.idleVolumeDuringScare;
  }
  saveConfig(config);
  io.emit('config', publicConfig());
  res.json({ ok: true, config: publicConfig() });
});

app.post('/api/simulate/:kind', (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  const body = req.body || {};
  const user = {
    uniqueId: body.uniqueId || body.username || 'test_user',
    nickname: body.nickname || body.name || 'Test Viewer',
    profilePictureUrl: body.profilePictureUrl || body.avatar || ''
  };

  let result;
  if (kind === 'join') {
    result = enqueueScare({ type: 'instant', reason: 'join', user, priority: 1 });
  } else if (kind === 'rose') {
    result = enqueueScare({
      type: 'instant',
      reason: 'rose',
      user,
      giftName: 'Rose',
      coins: 1,
      priority: 3
    });
  } else if (kind === 'gift' || kind === 'biggift' || kind === 'buildup') {
    result = enqueueScare({
      type: 'buildup',
      reason: 'gift',
      user,
      giftName: body.giftName || 'Universe',
      coins: body.coins || 1000,
      priority: 5
    });
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown kind. Use join, rose, or gift.' });
  }
  res.json({ ok: true, ...result, queue: queueSnapshot() });
});

app.post('/api/connect', async (req, res) => {
  const username = (req.body && req.body.username) || config.tiktokUsername;
  if (!username) {
    return res.status(400).json({ ok: false, error: 'Set a TikTok username first.' });
  }
  config.tiktokUsername = String(username).replace(/^@/, '').trim();
  saveConfig(config);
  try {
    await connectTikTok(config.tiktokUsername);
    res.json({ ok: true, connection: getConnectionStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
      connection: getConnectionStatus()
    });
  }
});

app.post('/api/disconnect', async (_req, res) => {
  try {
    await disconnectTikTok();
    res.json({ ok: true, connection: getConnectionStatus() });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
      connection: getConnectionStatus()
    });
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    connection: getConnectionStatus(),
    queue: queueSnapshot(),
    config: publicConfig()
  });
});

function publicConfig() {
  return {
    tiktokUsername: config.tiktokUsername,
    port: config.port,
    showCaption: config.showCaption,
    instantCooldownMs: config.instantCooldownMs,
    joinThrottleMs: config.joinThrottleMs,
    roseMaxCoins: config.roseMaxCoins,
    idleVolume: config.idleVolume,
    scareVolume: config.scareVolume,
    idleVolumeDuringScare: config.idleVolumeDuringScare
  };
}

// ---------- Scare queue ----------
const scareQueue = [];
let playing = null; // current scare payload
let lastInstantAt = 0;
let lastJoinScareAt = 0;

function queueSnapshot() {
  return {
    playing: playing
      ? { type: playing.type, reason: playing.reason, user: playing.user && playing.user.uniqueId }
      : null,
    length: scareQueue.length,
    items: scareQueue.map((s) => ({
      type: s.type,
      reason: s.reason,
      user: s.user && s.user.uniqueId
    }))
  };
}

function enqueueScare(scare) {
  const now = Date.now();

  // Join throttle: at most one join-scare per joinThrottleMs
  if (scare.reason === 'join') {
    if (now - lastJoinScareAt < (config.joinThrottleMs || 20000)) {
      const skipped = { queued: false, skipped: 'join_throttle' };
      io.emit('log', { level: 'info', message: `Join scare throttled (@${scare.user.uniqueId})` });
      return skipped;
    }
  }

  // Instant cooldown: don't fire another instant while cooldown is active,
  // unless a higher-priority gift (buildup) arrives.
  if (scare.type === 'instant') {
    if (playing && playing.type === 'buildup') {
      // Do not interrupt a buildup with an instant; skip join/rose during buildup
      // (gifts already handled as buildup). Joins/roses during buildup are dropped
      // to avoid a long backlog of short scares.
      if (scare.reason === 'join') {
        return { queued: false, skipped: 'busy_buildup' };
      }
      // Rose during buildup: queue after current buildup finishes
      scareQueue.push(scare);
      io.emit('queue', queueSnapshot());
      return { queued: true, position: scareQueue.length };
    }
    if (playing && playing.type === 'instant') {
      // Queue rose; drop extra joins
      if (scare.reason === 'join') {
        return { queued: false, skipped: 'busy_instant' };
      }
      scareQueue.push(scare);
      io.emit('queue', queueSnapshot());
      return { queued: true, position: scareQueue.length };
    }
    if (now - lastInstantAt < (config.instantCooldownMs || 8000) && scare.reason === 'join') {
      return { queued: false, skipped: 'instant_cooldown' };
    }
    // Rose can still queue during cooldown if nothing is playing — play after cooldown via timer,
    // but simpler: if cooldown active and idle, still allow rose (gifts priority).
    if (
      now - lastInstantAt < (config.instantCooldownMs || 8000) &&
      scare.reason === 'rose' &&
      !playing
    ) {
      // Allow rose through even during cooldown (gift priority over join cooldown)
    } else if (
      now - lastInstantAt < (config.instantCooldownMs || 8000) &&
      scare.reason === 'join'
    ) {
      return { queued: false, skipped: 'instant_cooldown' };
    }
  }

  // Buildup: never interrupt; always queue if busy
  if (scare.type === 'buildup') {
    if (playing) {
      // Prefer buildups: insert ahead of pending instants
      const firstInstantIdx = scareQueue.findIndex((s) => s.type === 'instant');
      if (firstInstantIdx === -1) scareQueue.push(scare);
      else scareQueue.splice(firstInstantIdx, 0, scare);
      io.emit('queue', queueSnapshot());
      return { queued: true, position: scareQueue.indexOf(scare) + 1 };
    }
  }

  if (playing) {
    scareQueue.push(scare);
    io.emit('queue', queueSnapshot());
    return { queued: true, position: scareQueue.length };
  }

  startScare(scare);
  return { queued: false, started: true };
}

let scareWatchdog = null;

function startScare(scare) {
  playing = scare;
  if (scare.type === 'instant') {
    lastInstantAt = Date.now();
    if (scare.reason === 'join') lastJoinScareAt = Date.now();
  }
  const payload = {
    type: scare.type, // 'instant' | 'buildup'
    reason: scare.reason,
    user: scare.user,
    giftName: scare.giftName || null,
    coins: scare.coins || null,
    showCaption: config.showCaption,
    video: scare.type === 'buildup' ? '/videos/scare_buildup_20s.mp4' : '/videos/scare_instant.mp4',
    startedAt: Date.now()
  };
  io.emit('scare', payload);
  io.emit('queue', queueSnapshot());
  io.emit('log', {
    level: 'scare',
    message: `${scare.type} (${scare.reason}) from @${scare.user.uniqueId}`
  });
  // Advance queue even if no player page is open / never sends scare_finished
  if (scareWatchdog) clearTimeout(scareWatchdog);
  const maxMs = scare.type === 'buildup' ? 22000 : 5000;
  scareWatchdog = setTimeout(() => {
    if (playing === scare) onScareFinished();
  }, maxMs);
}

function onScareFinished() {
  if (scareWatchdog) {
    clearTimeout(scareWatchdog);
    scareWatchdog = null;
  }
  if (!playing) {
    pumpQueue();
    return;
  }
  playing = null;
  io.emit('scare_end', {});
  io.emit('queue', queueSnapshot());
  pumpQueue();
}

function pumpQueue() {
  if (playing) return;
  if (!scareQueue.length) return;
  const next = scareQueue.shift();
  startScare(next);
}

io.on('connection', (socket) => {
  socket.emit('config', publicConfig());
  socket.emit('status', {
    connection: getConnectionStatus(),
    queue: queueSnapshot()
  });

  socket.on('scare_finished', () => {
    onScareFinished();
  });

  socket.on('request_status', () => {
    socket.emit('status', {
      connection: getConnectionStatus(),
      queue: queueSnapshot()
    });
  });

  // Player/control can ask the server to connect using ?user=
  socket.on('connect_tiktok', async (payload, ack) => {
    const username = String((payload && payload.username) || '')
      .replace(/^@/, '')
      .trim();
    if (!username) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Missing username' });
      return;
    }
    config.tiktokUsername = username;
    try {
      saveConfig(config);
    } catch (_e) {
      /* Render disk may be ephemeral — ignore */
    }
    try {
      // Avoid reconnect spam if already on same user
      if (
        tiktokStatus.state === 'connected' &&
        tiktokStatus.username === username
      ) {
        if (typeof ack === 'function') ack({ ok: true, connection: getConnectionStatus() });
        return;
      }
      await connectTikTok(username);
      if (typeof ack === 'function') ack({ ok: true, connection: getConnectionStatus() });
    } catch (err) {
      if (typeof ack === 'function') {
        ack({
          ok: false,
          error: err && err.message ? err.message : String(err),
          connection: getConnectionStatus()
        });
      }
    }
  });
});

// ---------- TikTok connection ----------
let tiktok = null;
let tiktokStatus = {
  state: 'disconnected', // disconnected | connecting | connected | error
  username: '',
  roomId: '',
  error: null,
  connectedAt: null
};

function getConnectionStatus() {
  return { ...tiktokStatus };
}

function broadcastStatus() {
  io.emit('status', {
    connection: getConnectionStatus(),
    queue: queueSnapshot()
  });
}

function extractAvatar(user) {
  if (!user) return '';
  if (user.profilePictureUrl) return user.profilePictureUrl;
  if (user.userProfile && user.userProfile.avatarThumb) {
    const a = user.userProfile.avatarThumb;
    if (typeof a === 'string') return a;
    if (a.urlList && a.urlList[0]) return a.urlList[0];
    if (a.url_list && a.url_list[0]) return a.url_list[0];
  }
  if (user.profilePicture) {
    const p = user.profilePicture;
    if (typeof p === 'string') return p;
    if (p.url && p.url[0]) return p.url[0];
    if (p.urls && p.urls[0]) return p.urls[0];
    if (p.urlList && p.urlList[0]) return p.urlList[0];
  }
  if (user.avatarThumb) {
    const a = user.avatarThumb;
    if (typeof a === 'string') return a;
    if (a.urlList && a.urlList[0]) return a.urlList[0];
  }
  return '';
}

function normalizeUser(user) {
  return {
    uniqueId: (user && (user.uniqueId || user.displayId || user.nickName)) || 'unknown',
    nickname: (user && (user.nickname || user.nickName || user.uniqueId)) || 'Viewer',
    profilePictureUrl: extractAvatar(user)
  };
}

function giftCoinValue(data) {
  // Prefer diamondCount fields commonly present on gift events
  const details = data.giftDetails || data.extendedGiftInfo || {};
  const candidates = [
    data.diamondCount,
    details.diamondCount,
    details.diamond_count,
    details.diamondCost,
    data.gift && data.gift.diamond_count,
    data.gift && data.gift.diamondCount
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && !Number.isNaN(c)) return c;
  }
  // Fallback: Rose gift id is often 5655; treat unknown as big if name isn't Rose
  const name = (details.giftName || details.name || data.giftName || '').toLowerCase();
  if (name === 'rose') return 1;
  return 999;
}

function isRoseGift(data, coins) {
  const details = data.giftDetails || data.extendedGiftInfo || {};
  const name = String(details.giftName || details.name || data.giftName || '').toLowerCase();
  if (name === 'rose') return true;
  if (coins <= (config.roseMaxCoins || 1)) return true;
  // Common Rose giftId
  if (Number(data.giftId) === 5655) return true;
  return false;
}

async function connectTikTok(username) {
  await disconnectTikTok();

  let TikTokLiveConnection;
  let WebcastEvent;
  let ControlEvent;
  try {
    const mod = require('tiktok-live-connector');
    TikTokLiveConnection = mod.TikTokLiveConnection;
    WebcastEvent = mod.WebcastEvent;
    ControlEvent = mod.ControlEvent;
  } catch (err) {
    tiktokStatus = {
      state: 'error',
      username,
      roomId: '',
      error: 'tiktok-live-connector not installed. Run npm install.',
      connectedAt: null
    };
    broadcastStatus();
    throw err;
  }

  tiktokStatus = {
    state: 'connecting',
    username,
    roomId: '',
    error: null,
    connectedAt: null
  };
  broadcastStatus();
  io.emit('log', { level: 'info', message: `Connecting to @${username}...` });

  const connection = new TikTokLiveConnection(username, {
    processInitialData: false,
    enableExtendedGiftInfo: true,
    fetchRoomInfoOnConnect: true
  });

  connection.on(ControlEvent.CONNECTED, (state) => {
    tiktokStatus = {
      state: 'connected',
      username,
      roomId: state.roomId || connection.roomId || '',
      error: null,
      connectedAt: Date.now()
    };
    broadcastStatus();
    io.emit('log', {
      level: 'info',
      message: `Connected to @${username} (room ${tiktokStatus.roomId})`
    });
  });

  connection.on(ControlEvent.DISCONNECTED, () => {
    if (tiktokStatus.state !== 'disconnected') {
      tiktokStatus = {
        state: 'disconnected',
        username,
        roomId: '',
        error: null,
        connectedAt: null
      };
      broadcastStatus();
      io.emit('log', { level: 'info', message: 'Disconnected from TikTok Live' });
    }
  });

  connection.on(ControlEvent.ERROR, ({ info, exception }) => {
    const msg =
      (exception && exception.message) ||
      (typeof info === 'string' ? info : JSON.stringify(info)) ||
      'Unknown TikTok error';
    tiktokStatus.error = msg;
    io.emit('log', { level: 'error', message: msg });
    broadcastStatus();
  });

  connection.on(WebcastEvent.MEMBER, (data) => {
    const user = normalizeUser(data.user);
    enqueueScare({ type: 'instant', reason: 'join', user, priority: 1 });
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    // Streakable gifts fire many times; only act on streak end / non-streakable
    const giftType = data.giftDetails && data.giftDetails.giftType;
    if (giftType === 1 && !data.repeatEnd) {
      return;
    }
    const user = normalizeUser(data.user);
    const coins = giftCoinValue(data);
    const giftName =
      (data.giftDetails && data.giftDetails.giftName) ||
      (data.extendedGiftInfo && data.extendedGiftInfo.name) ||
      data.giftName ||
      'Gift';
    const repeat = Number(data.repeatCount) || 1;
    const totalCoins = coins * (repeat > 0 ? repeat : 1);

    if (isRoseGift(data, coins) || totalCoins <= (config.roseMaxCoins || 1)) {
      enqueueScare({
        type: 'instant',
        reason: 'rose',
        user,
        giftName,
        coins: totalCoins,
        priority: 3
      });
    } else {
      enqueueScare({
        type: 'buildup',
        reason: 'gift',
        user,
        giftName,
        coins: totalCoins,
        priority: 5
      });
    }
  });

  try {
    const state = await connection.connect();
    tiktok = connection;
    if (tiktokStatus.state !== 'connected') {
      tiktokStatus = {
        state: 'connected',
        username,
        roomId: state.roomId || connection.roomId || '',
        error: null,
        connectedAt: Date.now()
      };
      broadcastStatus();
    }
    return state;
  } catch (err) {
    tiktok = null;
    tiktokStatus = {
      state: 'error',
      username,
      roomId: '',
      error: err && err.message ? err.message : String(err),
      connectedAt: null
    };
    broadcastStatus();
    io.emit('log', { level: 'error', message: tiktokStatus.error });
    throw err;
  }
}

async function disconnectTikTok() {
  if (tiktok) {
    try {
      await tiktok.disconnect();
    } catch (_e) {
      /* ignore */
    }
    tiktok = null;
  }
  tiktokStatus = {
    state: 'disconnected',
    username: config.tiktokUsername || '',
    roomId: '',
    error: null,
    connectedAt: null
  };
  broadcastStatus();
}

const PORT = Number(process.env.PORT) || Number(config.port) || 3847;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  TikTok Horror Live player is running');
  console.log('========================================');
  console.log(`  Port:    ${PORT}`);
  console.log(`  Health:  /health`);
  console.log(`  Player:  /player.html?user=YOUR_TIKTOK_NAME`);
  console.log(`  Control: /control.html?user=YOUR_TIKTOK_NAME`);
  console.log('========================================');
  console.log('');
});
