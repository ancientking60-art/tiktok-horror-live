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

const eventStats = {
  chat: 0,
  like: 0,
  member: 0,
  gift: 0,
  social: 0,
  follow: 0,
  share: 0,
  roomUser: 0,
  lastLikeAt: 0,
  likeTotalSession: 0
};

function bumpEvent(kind, detail) {
  if (Object.prototype.hasOwnProperty.call(eventStats, kind)) eventStats[kind] += 1;
  const msg = detail ? `[event] ${kind} ${detail}` : `[event] ${kind}`;
  console.log(msg);
  io.emit('log', { level: 'event', message: msg });
}


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());

// Render / uptime health check (keep-alive friendly)
const APP_VERSION = '1.4.0-livefix';

app.get('/health', (_req, res) => {
  const conn = getConnectionStatus();
  res.status(200).json({
    ok: true,
    version: APP_VERSION,
    uptime: process.uptime(),
    connection: conn.state,
    username: conn.username || null,
    events: {
      chat: eventStats.chat,
      like: eventStats.like,
      member: eventStats.member,
      gift: eventStats.gift,
      likeTotalSession: eventStats.likeTotalSession
    }
  });
});


// Proxy TikTok avatars (browser CORS often blocks them)
app.get('/api/avatar', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    if (!raw) {
      res.status(400).type('text/plain').send('missing url');
      return;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_e) {
      res.status(400).type('text/plain').send('bad url');
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      res.status(400).type('text/plain').send('bad protocol');
      return;
    }
    const host = parsed.hostname.toLowerCase();
    const allowed =
      host.endsWith('tiktokcdn.com') ||
      host.endsWith('tiktokcdn-us.com') ||
      host.endsWith('tiktokv.com') ||
      host.endsWith('byteoversea.com') ||
      host.endsWith('ibyteimg.com') ||
      host.endsWith('ttlivecdn.com') ||
      host === 'p16-sign-va.tiktokcdn.com' ||
      host.includes('tiktok');
    if (!allowed) {
      res.status(403).type('text/plain').send('host not allowed');
      return;
    }
    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://www.tiktok.com/'
      },
      redirect: 'follow'
    });
    if (!upstream.ok) {
      res.status(upstream.status).type('text/plain').send('avatar fetch failed');
      return;
    }
    const ctype = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', ctype);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (err) {
    res.status(502).type('text/plain').send('avatar proxy error');
  }
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
  if (typeof body.likeFlashCooldownMs === 'number') config.likeFlashCooldownMs = body.likeFlashCooldownMs;
  if (typeof body.likesPerScare === 'number') config.likesPerScare = body.likesPerScare;
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
    result = enqueueJoinSequence(user);
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
  } else if (kind === 'like' || kind === 'likes') {
    const batch = Math.max(1, Number(body.count || body.likes || 1));
    eventStats.likeTotalSession += batch;
    bumpEvent('like', '@' + user.uniqueId + ' +' + batch + ' (sim session ' + eventStats.likeTotalSession + ')');
    handleLikes(user, batch);
    result = { simulated: true, batch, sessionTotal: eventStats.likeTotalSession };
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown kind. Use join, rose, gift, or like.' });
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
    await ensureWatching(config.tiktokUsername);
    res.json({ ok: true, connection: getConnectionStatus() });
  } catch (err) {
    // Offline / retrying is normal — still return current status
    res.json({
      ok: true,
      connection: getConnectionStatus(),
      note: err && err.message ? err.message : String(err)
    });
  }
});

app.post('/api/disconnect', async (_req, res) => {
  try {
    await stopWatching();
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
    idleVolumeDuringScare: config.idleVolumeDuringScare,
    likeFlashCooldownMs: config.likeFlashCooldownMs ?? 3000,
    likesPerScare: config.likesPerScare ?? 100
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

const MAX_PENDING_WELCOMES = 3;

function countPendingWelcomes() {
  let n = 0;
  if (playing && playing.type === 'welcome') n += 1;
  for (const s of scareQueue) {
    if (s.type === 'welcome') n += 1;
  }
  return n;
}

/** Join = instant scare, then welcome poster (if room in queue). */
function enqueueJoinSequence(user) {
  const instant = enqueueScare({
    type: 'instant',
    reason: 'join',
    user,
    priority: 1,
    thenWelcome: true
  });
  if (instant.skipped) {
    return instant;
  }
  if (countPendingWelcomes() >= MAX_PENDING_WELCOMES) {
    return { ...instant, welcomeQueued: false, welcomeSkipped: 'welcome_cap' };
  }
  // Welcome is queued to run right after this join's instant (gifts can still jump ahead of pending instants)
  const welcome = {
    type: 'welcome',
    reason: 'join_welcome',
    user,
    priority: 2
  };
  // Insert welcome immediately after the matching join instant if that instant is still queued;
  // if instant already started, push welcome near front (after any buildup already prioritized).
  if (playing && playing.type === 'instant' && playing.reason === 'join' && playing.thenWelcome) {
    // Playing join instant now — put welcome at front of queue (before other pending instants)
    const firstBuildup = scareQueue.findIndex((s) => s.type === 'buildup');
    if (firstBuildup === 0) {
      // keep buildups first
      let i = 0;
      while (i < scareQueue.length && scareQueue[i].type === 'buildup') i += 1;
      scareQueue.splice(i, 0, welcome);
    } else if (firstBuildup > 0) {
      scareQueue.splice(0, 0, welcome);
    } else {
      scareQueue.unshift(welcome);
    }
    io.emit('queue', queueSnapshot());
    return { ...instant, welcomeQueued: true };
  }
  // Instant was queued: place welcome right after the last join instant in queue
  let lastJoinIdx = -1;
  for (let i = scareQueue.length - 1; i >= 0; i -= 1) {
    if (scareQueue[i].type === 'instant' && scareQueue[i].reason === 'join') {
      lastJoinIdx = i;
      break;
    }
  }
  if (lastJoinIdx >= 0) {
    scareQueue.splice(lastJoinIdx + 1, 0, welcome);
  } else {
    scareQueue.push(welcome);
  }
  io.emit('queue', queueSnapshot());
  return { ...instant, welcomeQueued: true };
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
  let video = null;
  if (scare.type === 'buildup') video = '/videos/scare_buildup_20s.mp4';
  else if (scare.type === 'instant') video = '/videos/scare_instant.mp4';
  // welcome has no video — player renders the poster overlay

  const payload = {
    type: scare.type, // 'instant' | 'buildup' | 'welcome'
    reason: scare.reason,
    user: scare.user,
    giftName: scare.giftName || null,
    coins: scare.coins || null,
    showCaption: scare.type === 'welcome' ? false : config.showCaption,
    video,
    avatarProxy: (() => {
      const url = scare.user && scare.user.profilePictureUrl;
      if (!url) return null;
      if (String(url).startsWith('/')) return String(url);
      return '/api/avatar?url=' + encodeURIComponent(url);
    })(),
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
  const maxMs =
    scare.type === 'buildup' ? 22000 : scare.type === 'welcome' ? 6500 : 5000;
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

  // Player/control can ask the server to watch a username (?user=)
  socket.on('connect_tiktok', async (payload, ack) => {
    const username = String((payload && payload.username) || '')
      .replace(/^@/, '')
      .trim();
    if (!username) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Missing username' });
      return;
    }
    config.tiktokUsername = username;
    saveConfig(config);
    try {
      await ensureWatching(username);
      if (typeof ack === 'function') ack({ ok: true, connection: getConnectionStatus() });
    } catch (err) {
      if (typeof ack === 'function') {
        ack({
          ok: true,
          connection: getConnectionStatus(),
          note: err && err.message ? err.message : String(err)
        });
      }
    }
  });
});

// ---------- TikTok connection (single watcher + auto-retry) ----------
const RETRY_MS = 10000;

let tiktok = null;
let desiredUsername = null; // null => not watching (manual disconnect)
let intentionallyStopped = true;
let reconnectTimer = null;
let connectInFlight = null;
let lastLoggedKey = '';

let tiktokStatus = {
  state: 'disconnected', // disconnected | waiting | connecting | reconnecting | connected
  username: '',
  roomId: '',
  error: null,
  connectedAt: null,
  attempt: 0,
  retrying: false
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

function logOnce(key, level, message) {
  if (key === lastLoggedKey) return;
  lastLoggedKey = key;
  console.log(`[tiktok] ${message}`);
  io.emit('log', { level, message });
}

function clearRetryTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleRetry() {
  if (intentionallyStopped || !desiredUsername) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (intentionallyStopped || !desiredUsername) return;
    attemptConnect(desiredUsername).catch(() => {});
  }, RETRY_MS);
}

function setStatus(partial) {
  tiktokStatus = { ...tiktokStatus, ...partial };
  broadcastStatus();
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
    uniqueId: (user && (user.uniqueId || user.displayId || user.username || user.nickName)) || 'unknown',
    nickname: (user && (user.nickname || user.nickName || user.uniqueId || user.displayId)) || 'Viewer',
    profilePictureUrl: extractAvatar(user)
  };
}

function handleLikes(user, batch) {
  const now = Date.now();
  const cooldown = Number(config.likeFlashCooldownMs) || 3000;
  const perScare = Number(config.likesPerScare) || 100;

  // Rate-limited lightning flash for every like batch
  if (now - eventStats.lastLikeAt >= cooldown) {
    eventStats.lastLikeAt = now;
    io.emit('like_flash', {
      user,
      count: batch,
      sessionTotal: eventStats.likeTotalSession
    });
  }

  // Every N cumulative likes -> short instant scare (ghost glimpse)
  const prevMilestone = Math.floor((eventStats.likeTotalSession - batch) / perScare);
  const nextMilestone = Math.floor(eventStats.likeTotalSession / perScare);
  if (nextMilestone > prevMilestone) {
    enqueueScare({
      type: 'instant',
      reason: 'likes',
      user,
      priority: 2
    });
  }
}

function giftCoinValue(data) {
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
  const name = (details.giftName || details.name || data.giftName || '').toLowerCase();
  if (name === 'rose') return 1;
  return 999;
}

function isRoseGift(data, coins) {
  const details = data.giftDetails || data.extendedGiftInfo || {};
  const name = String(details.giftName || details.name || data.giftName || '').toLowerCase();
  if (name === 'rose') return true;
  if (coins <= (config.roseMaxCoins || 1)) return true;
  if (Number(data.giftId) === 5655) return true;
  return false;
}

function isOfflineError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  const name = String((err && err.name) || '');
  if (name === 'UserOfflineError') return true;
  if (
    msg.includes('offline') ||
    msg.includes('not live') ||
    msg.includes("isn't live") ||
    msg.includes('is not live') ||
    msg.includes('failed to retrieve room id') ||
    msg.includes('room id')
  ) {
    return true;
  }
  return false;
}

function isBusinessPlanError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return msg.includes('business plan') || msg.includes('eulerstream.com/pricing');
}

async function tearDownSocket() {
  const conn = tiktok;
  tiktok = null;
  if (!conn) return;
  try {
    conn.removeAllListeners && conn.removeAllListeners();
  } catch (_e) {}
  try {
    await conn.disconnect();
  } catch (_e) {}
}

/** Start or keep watching a username. Safe to call from player + control together. */
async function ensureWatching(username) {
  const u = String(username || '').replace(/^@/, '').trim();
  if (!u) throw new Error('Missing username');

  // Already managing this user — do not open a second connection
  if (desiredUsername === u && !intentionallyStopped) {
    if (['connected', 'connecting', 'waiting', 'reconnecting'].includes(tiktokStatus.state)) {
      // Keep the retry loop alive if we are only waiting
      if (tiktokStatus.state === 'waiting' || tiktokStatus.state === 'reconnecting') {
        scheduleRetry();
      }
      return getConnectionStatus();
    }
  }

  // Switch user cleanly
  if (desiredUsername && desiredUsername !== u) {
    clearRetryTimer();
    await tearDownSocket();
    lastLoggedKey = '';
  }

  desiredUsername = u;
  intentionallyStopped = false;
  config.tiktokUsername = u;
  return attemptConnect(u);
}

/** Manual Disconnect — stop retries. */
async function stopWatching() {
  intentionallyStopped = true;
  desiredUsername = null;
  clearRetryTimer();
  connectInFlight = null;
  await tearDownSocket();
  lastLoggedKey = '';
  setStatus({
    state: 'disconnected',
    username: config.tiktokUsername || '',
    roomId: '',
    error: null,
    connectedAt: null,
    attempt: 0,
    retrying: false
  });
  logOnce('stopped', 'info', 'Stopped watching TikTok Live (manual disconnect)');
  return getConnectionStatus();
}

async function attemptConnect(username) {
  if (intentionallyStopped || desiredUsername !== username) {
    return getConnectionStatus();
  }
  if (tiktokStatus.state === 'connected' && tiktokStatus.username === username && tiktok) {
    return getConnectionStatus();
  }
  if (connectInFlight) {
    return connectInFlight;
  }

  connectInFlight = (async () => {
    let TikTokLiveConnection;
    let WebcastEvent;
    let ControlEvent;
    try {
      const mod = require('tiktok-live-connector');
      TikTokLiveConnection = mod.TikTokLiveConnection;
      WebcastEvent = mod.WebcastEvent;
      ControlEvent = mod.ControlEvent;
      var WebcastHttpClient = mod.WebcastHttpClient;
      var getRandomPresets = mod.getRandomPresets;
    } catch (err) {
      setStatus({
        state: 'waiting',
        username,
        roomId: '',
        error: 'tiktok-live-connector missing',
        connectedAt: null,
        retrying: true
      });
      scheduleRetry();
      throw err;
    }

    const wasConnected = tiktokStatus.state === 'connected';
    const attempt = (tiktokStatus.attempt || 0) + 1;
    const nextState = wasConnected || attempt > 1 ? 'reconnecting' : 'connecting';
    // Prefer "waiting" UI when we already know they are offline
    const uiState =
      tiktokStatus.state === 'waiting' || (tiktokStatus.error && isOfflineError({ message: tiktokStatus.error }))
        ? 'waiting'
        : nextState;

    setStatus({
      state: uiState === 'waiting' ? 'waiting' : nextState,
      username,
      roomId: '',
      error: tiktokStatus.error,
      connectedAt: null,
      attempt,
      retrying: true
    });

    if (attempt === 1) {
      logOnce(`watch:${username}`, 'info', `Watching @${username} — will retry every ${RETRY_MS / 1000}s until live`);
    }

    await tearDownSocket();

    if (intentionallyStopped || desiredUsername !== username) {
      return getConnectionStatus();
    }

    // Match stickfight-game: HTTPS fix + lean options (extended gift info hits Euler Business routes)
    if (typeof WebcastHttpClient !== 'undefined' && WebcastHttpClient?.prototype && !WebcastHttpClient.prototype.__httpsFix) {
      WebcastHttpClient.prototype.getBaseUrl = function (host) {
        return /^(localhost|127\.|\[?::1)/.test(host) ? `http://${host}` : `https://${host}`;
      };
      WebcastHttpClient.prototype.__httpsFix = true;
    }

    const signKey =
      process.env.EULER_API_KEY ||
      process.env.SIGN_API_KEY ||
      config.signApiKey ||
      '';
    const options = {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: false
    };
    if (signKey) options.signApiKey = String(signKey).trim();
    if (typeof getRandomPresets === 'function') {
      try { options.clientPresets = getRandomPresets(); } catch (_e) {}
    }

    const connection = new TikTokLiveConnection(username, options);

    connection.on(ControlEvent.CONNECTED, (state) => {
      if (desiredUsername !== username || intentionallyStopped) return;
      lastLoggedKey = '';
      setStatus({
        state: 'connected',
        username,
        roomId: state.roomId || connection.roomId || '',
        error: null,
        connectedAt: Date.now(),
        retrying: false
      });
      eventStats.likeTotalSession = 0;
      eventStats.chat = 0; eventStats.like = 0; eventStats.member = 0; eventStats.gift = 0;
      logOnce(`connected:${username}:${state.roomId || ''}`, 'info', `Connected to @${username} (room ${state.roomId || connection.roomId || '?'})`);
    });

    connection.on(ControlEvent.DISCONNECTED, () => {
      if (intentionallyStopped || desiredUsername !== username) return;
      if (tiktokStatus.state === 'connected') {
        setStatus({
          state: 'reconnecting',
          username,
          roomId: '',
          error: null,
          connectedAt: null,
          retrying: true
        });
        logOnce(`drop:${username}`, 'info', `Connection to @${username} dropped — retrying`);
      }
      scheduleRetry();
    });

    connection.on(ControlEvent.ERROR, ({ info, exception }) => {
      // Quiet: do not spam control log on every error while retrying
      const msg =
        (exception && exception.message) ||
        (typeof info === 'string' ? info : '') ||
        '';
      if (msg && intentionallyStopped === false) {
        // keep latest error on status for control panel, without log spam
        tiktokStatus.error = msg;
      }
    });

    if (WebcastEvent.STREAM_END) {
      connection.on(WebcastEvent.STREAM_END, () => {
        if (intentionallyStopped || desiredUsername !== username) return;
        setStatus({
          state: 'waiting',
          username,
          roomId: '',
          error: 'stream ended',
          connectedAt: null,
          retrying: true
        });
        logOnce(`ended:${username}`, 'info', `Live ended for @${username} — waiting to go live again`);
        scheduleRetry();
      });
    }

    connection.on(WebcastEvent.MEMBER, (data) => {
      const user = normalizeUser(data.user);
      bumpEvent('member', '@' + user.uniqueId);
      enqueueJoinSequence(user);
    });

    connection.on(WebcastEvent.CHAT, (data) => {
      const user = normalizeUser(data.user);
      const comment = String(data.comment || data.content || '').slice(0, 80);
      bumpEvent('chat', '@' + user.uniqueId + ' ' + comment);
    });

    connection.on(WebcastEvent.LIKE, (data) => {
      const user = normalizeUser(data.user);
      const batch = Math.max(1, Number(data.likeCount || data.count || 1));
      eventStats.likeTotalSession += batch;
      bumpEvent('like', '@' + user.uniqueId + ' +' + batch + ' (session ' + eventStats.likeTotalSession + ')');
      handleLikes(user, batch);
    });

    connection.on(WebcastEvent.FOLLOW, (data) => {
      const user = normalizeUser(data.user);
      bumpEvent('follow', '@' + user.uniqueId);
    });

    connection.on(WebcastEvent.SHARE, (data) => {
      const user = normalizeUser(data.user);
      bumpEvent('share', '@' + user.uniqueId);
    });

    connection.on(WebcastEvent.ROOM_USER, (data) => {
      eventStats.roomUser += 1;
      // quiet — high frequency
    });

    connection.on(WebcastEvent.GIFT, (data) => {
      const giftType =
        (data.giftDetails && data.giftDetails.giftType) ||
        (data.gift && data.gift.type) ||
        data.giftType;
      if (giftType === 1 && !data.repeatEnd) return;
      const user = normalizeUser(data.user);
      const coins = giftCoinValue(data);
      const giftName =
        (data.giftDetails && data.giftDetails.giftName) ||
        (data.gift && data.gift.name) ||
        (data.extendedGiftInfo && data.extendedGiftInfo.name) ||
        data.giftName ||
        'Gift';
      const repeat = Number(data.repeatCount) || 1;
      const totalCoins = coins * (repeat > 0 ? repeat : 1);
      bumpEvent('gift', '@' + user.uniqueId + ' ' + giftName + ' x' + repeat + ' (' + totalCoins + ' coins)');
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
      if (intentionallyStopped || desiredUsername !== username) {
        try { await connection.disconnect(); } catch (_e) {}
        return getConnectionStatus();
      }
      tiktok = connection;
      setStatus({
        state: 'connected',
        username,
        roomId: state.roomId || connection.roomId || '',
        error: null,
        connectedAt: Date.now(),
        attempt,
        retrying: false
      });
      lastLoggedKey = '';
      logOnce(
        `connected:${username}:${state.roomId || connection.roomId || ''}`,
        'info',
        `Connected to @${username} (room ${state.roomId || connection.roomId || '?'})`
      );
      return getConnectionStatus();
    } catch (err) {
      if (intentionallyStopped || desiredUsername !== username) {
        return getConnectionStatus();
      }
      tiktok = null;
      const offline = isOfflineError(err);
      const business = isBusinessPlanError(err);
      const msg = err && err.message ? err.message : String(err);
      setStatus({
        state: offline ? 'waiting' : 'reconnecting',
        username,
        roomId: '',
        error: offline ? 'offline' : (business ? 'euler_business_or_rate_limit' : msg),
        connectedAt: null,
        attempt,
        retrying: true
      });
      if (offline) {
        logOnce(
          `waiting:${username}`,
          'info',
          `Waiting for @${username} to go live… (retrying every ${RETRY_MS / 1000}s)`
        );
      } else if (business) {
        logOnce(
          `euler:${username}`,
          'info',
          `Euler signing blocked (Business/rate). Retrying with fresh device… Set free EULER_API_KEY env var if this persists.`
        );
      } else {
        logOnce(`retry:${username}:${msg.slice(0, 40)}`, 'info', `Retrying @${username}: ${msg}`);
      }
      scheduleRetry();
      return getConnectionStatus();
    }
  })();

  try {
    return await connectInFlight;
  } finally {
    connectInFlight = null;
  }
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
