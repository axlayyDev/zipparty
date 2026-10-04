'use strict';

/**
 * ZipParty server
 * - Express serves the static frontend from /public
 * - Socket.io handles rooms, asset sync, board state, audio triggers and chat
 * - All room state lives in memory (rooms vanish when the server restarts)
 */

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const LIMITS = {
  maxPlayers: 12,
  maxAssets: 150,
  maxAssetBytes: 8 * 1024 * 1024, // per image / audio file
  maxDataBytes: 1024 * 1024, // per json / text file
  maxRoomBytes: 40 * 1024 * 1024, // all assets in one room
  maxItems: 80, // items on the board
  initialItems: 40, // items auto-placed after an import
  chatLength: 200,
  emptyRoomTtlMs: 10 * 60 * 1000,
};

// File extension -> [kind, mime]. The server decides the type, never the client.
const FILE_TYPES = {
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  svg: ['image', 'image/svg+xml'],
  bmp: ['image', 'image/bmp'],
  mp3: ['audio', 'audio/mpeg'],
  ogg: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg'],
  wav: ['audio', 'audio/wav'],
  m4a: ['audio', 'audio/mp4'],
  flac: ['audio', 'audio/flac'],
  json: ['data', 'application/json'],
  txt: ['data', 'text/plain'],
  md: ['data', 'text/plain'],
  csv: ['data', 'text/plain'],
  ini: ['data', 'text/plain'],
  cfg: ['data', 'text/plain'],
};

const PLAYER_COLORS = [
  '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#3bc9db',
  '#4dabf7', '#748ffc', '#9775fa', '#da77f2', '#f783ac', '#adb5bd',
];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.type('text').send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 12 * 1024 * 1024, // a bit above the biggest single asset
  pingTimeout: 60000, // big uploads can delay pongs on slow connections
});

/** @type {Map<string, Room>} */
const rooms = new Map();

// ---------------------------------------------------------------- helpers

const ack = (cb, payload) => {
  if (typeof cb === 'function') cb(payload);
};

function cleanText(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const cleanName = (raw) => cleanText(raw, 20);
const cleanCode = (raw) => String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function clamp01(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

function makeCode() {
  for (let len = 4; len <= 6; len++) {
    for (let tries = 0; tries < 40; tries++) {
      let code = '';
      for (let i = 0; i < len; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(code)) return code;
    }
  }
  throw new Error('Could not allocate a room code');
}

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(), // socket.id -> { id, name, color }
    assets: new Map(), // id -> { id, name, kind, mime, size, data }
    items: new Map(), // id -> { id, assetId, x, y, z, scale }
    bytes: 0,
    assetSeq: 0,
    itemSeq: 0,
    zCounter: 0,
    packName: '',
    deleteTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function scheduleDelete(room) {
  clearTimeout(room.deleteTimer);
  room.deleteTimer = setTimeout(() => {
    if (room.players.size === 0) rooms.delete(room.code);
  }, LIMITS.emptyRoomTtlMs);
  if (room.deleteTimer.unref) room.deleteTimer.unref();
}

const publicPlayers = (room) => [...room.players.values()];

function roomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    items: [...room.items.values()],
    packName: room.packName,
  };
}

const assetMeta = (a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size });
const assetPayload = (a) => ({ ...assetMeta(a), data: a.data });

function systemMessage(target, text) {
  target.emit('chat:message', { system: true, text, ts: Date.now() });
}

function pickColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
}

function joinRoom(socket, room, name) {
  clearTimeout(room.deleteTimer);
  if (room.players.size === 0) room.hostId = socket.id; // first one in (or back in) hosts
  room.players.set(socket.id, { id: socket.id, name, color: pickColor(room) });
  socket.join(room.code);
  socket.data.code = room.code;
  socket.to(room.code).emit('room:players', { hostId: room.hostId, players: publicPlayers(room) });
  systemMessage(socket.to(room.code), `${name} joined`);
}

function leaveRoom(socket) {
  const code = socket.data.code;
  const room = code ? rooms.get(code) : null;
  socket.data.code = null;
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(room.code);
  if (room.players.size === 0) {
    room.hostId = null;
    scheduleDelete(room);
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
    const newHost = room.players.get(room.hostId);
    systemMessage(io.to(room.code), `${newHost.name} is now the host`);
  }
  if (player) systemMessage(io.to(room.code), `${player.name} left`);
  io.to(room.code).emit('room:players', { hostId: room.hostId, players: publicPlayers(room) });
}

const inRoom = (socket) => (socket.data.code ? rooms.get(socket.data.code) || null : null);

function hostRoom(socket, cb) {
  const room = inRoom(socket);
  if (!room) {
    ack(cb, { ok: false, error: 'You are not in a room.' });
    return null;
  }
  if (room.hostId !== socket.id) {
    ack(cb, { ok: false, error: 'Only the host can do that.' });
    return null;
  }
  return room;
}

function addItem(room, assetId, x, y) {
  const item = { id: `i${++room.itemSeq}`, assetId, x, y, z: ++room.zCounter, scale: 1 };
  room.items.set(item.id, item);
  return item;
}

// -------------------------------------------------------------- connection

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.tokens = 100;
  socket.data.last = Date.now();

  // Simple token bucket: ~60 events/second sustained, bursts up to 100.
  socket.use((packet, next) => {
    const now = Date.now();
    const d = socket.data;
    d.tokens = Math.min(100, d.tokens + ((now - d.last) / 1000) * 60);
    d.last = now;
    if (d.tokens < 1) return next(new Error('rate limited'));
    d.tokens -= 1;
    next();
  });
  socket.on('error', () => {}); // swallow middleware errors (rate limit)

  // ---- rooms

  socket.on('room:create', (payload, cb) => {
    leaveRoom(socket);
    const room = createRoom();
    joinRoom(socket, room, cleanName(payload && payload.name) || 'Host');
    ack(cb, { ok: true, you: socket.id, state: roomState(room) });
  });

  socket.on('room:join', (payload, cb) => {
    const code = cleanCode(payload && payload.code);
    const room = rooms.get(code);
    if (!room) return ack(cb, { ok: false, error: `No room with code "${code || '?'}". Check the code and try again.` });
    leaveRoom(socket);
    if (room.players.size >= LIMITS.maxPlayers) return ack(cb, { ok: false, error: 'That room is full.' });
    joinRoom(socket, room, cleanName(payload && payload.name) || `Player ${room.players.size + 1}`);
    ack(cb, { ok: true, you: socket.id, state: roomState(room) });
  });

  socket.on('room:leave', (payload, cb) => {
    leaveRoom(socket);
    ack(cb, { ok: true });
  });

  // A client asks for the stored assets after it has applied the room state.
  socket.on('assets:request', () => {
    const room = inRoom(socket);
    if (!room) return;
    for (const asset of room.assets.values()) socket.emit('asset:added', assetPayload(asset));
  });

  // ---- host: asset import

  socket.on('assets:reset', (payload, cb) => {
    const room = hostRoom(socket, cb);
    if (!room) return;
    room.assets.clear();
    room.items.clear();
    room.bytes = 0;
    room.packName = '';
    socket.to(room.code).emit('assets:cleared');
    ack(cb, { ok: true });
  });

  socket.on('asset:add', (payload, cb) => {
    const room = hostRoom(socket, cb);
    if (!room) return;
    if (!payload || typeof payload.name !== 'string' || !Buffer.isBuffer(payload.data)) {
      return ack(cb, { ok: false, error: 'Malformed asset.' });
    }
    const name = payload.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const type = FILE_TYPES[ext];
    if (!type) return ack(cb, { ok: false, error: `Unsupported file type: ${name}` });
    const [kind, mime] = type;
    const size = payload.data.length;
    if (size === 0) return ack(cb, { ok: false, error: `${name} is empty.` });
    if (size > (kind === 'data' ? LIMITS.maxDataBytes : LIMITS.maxAssetBytes)) {
      return ack(cb, { ok: false, error: `${name} is too large.` });
    }
    if (room.assets.size >= LIMITS.maxAssets) return ack(cb, { ok: false, error: 'Too many files in this room.' });
    if (room.bytes + size > LIMITS.maxRoomBytes) return ack(cb, { ok: false, error: 'Room storage limit reached.' });

    const asset = { id: `a${++room.assetSeq}`, name, kind, mime, size, data: payload.data };
    room.assets.set(asset.id, asset);
    room.bytes += size;
    socket.to(room.code).emit('asset:added', assetPayload(asset));
    ack(cb, { ok: true, asset: assetMeta(asset) });
  });

  socket.on('assets:done', (payload, cb) => {
    const room = hostRoom(socket, cb);
    if (!room) return;
    room.packName = cleanText(payload && payload.packName, 80);
    room.items.clear();

    const images = [...room.assets.values()].filter((a) => a.kind === 'image').slice(0, LIMITS.initialItems);
    const n = images.length;
    if (n > 0) {
      const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 1.6))));
      const rows = Math.ceil(n / cols);
      images.forEach((asset, i) => {
        addItem(room, asset.id, ((i % cols) + 0.5) / cols, (Math.floor(i / cols) + 0.5) / rows);
      });
    }
    io.to(room.code).emit('pack:ready', { packName: room.packName, items: [...room.items.values()] });
    ack(cb, { ok: true, items: room.items.size });
  });

  // ---- board items (everyone can play)

  socket.on('item:spawn', (payload) => {
    const room = inRoom(socket);
    if (!room || !payload) return;
    const asset = room.assets.get(payload.assetId);
    if (!asset || asset.kind !== 'image' || room.items.size >= LIMITS.maxItems) return;
    const item = addItem(room, asset.id, 0.25 + Math.random() * 0.5, 0.25 + Math.random() * 0.5);
    io.to(room.code).emit('item:added', item);
  });

  socket.on('item:grab', (payload) => {
    const room = inRoom(socket);
    const item = room && payload && room.items.get(payload.id);
    if (!item) return;
    item.z = ++room.zCounter;
    io.to(room.code).emit('item:z', { id: item.id, z: item.z });
  });

  const moveHandler = (reliable) => (payload) => {
    const room = inRoom(socket);
    const item = room && payload && room.items.get(payload.id);
    if (!item) return;
    const x = clamp01(payload.x);
    const y = clamp01(payload.y);
    if (x === null || y === null) return;
    item.x = x;
    item.y = y;
    const out = socket.to(room.code);
    (reliable ? out : out.volatile).emit('item:moved', { id: item.id, x, y });
  };
  socket.on('item:move', moveHandler(false));
  socket.on('item:drop', moveHandler(true));

  socket.on('item:scale', (payload) => {
    const room = inRoom(socket);
    const item = room && payload && room.items.get(payload.id);
    if (!item || typeof payload.scale !== 'number' || !Number.isFinite(payload.scale)) return;
    item.scale = Math.min(4, Math.max(0.4, payload.scale));
    socket.to(room.code).emit('item:scaled', { id: item.id, scale: item.scale });
  });

  socket.on('item:remove', (payload) => {
    const room = inRoom(socket);
    if (!room || !payload || !room.items.delete(payload.id)) return;
    io.to(room.code).emit('item:removed', { id: payload.id });
  });

  // ---- audio, pings, chat

  socket.on('audio:play', (payload) => {
    const room = inRoom(socket);
    const asset = room && payload && room.assets.get(payload.assetId);
    if (!asset || asset.kind !== 'audio') return;
    const player = room.players.get(socket.id);
    io.to(room.code).emit('audio:play', { assetId: asset.id, by: player ? player.name : '' });
  });

  socket.on('audio:stop', () => {
    const room = inRoom(socket);
    if (room) io.to(room.code).emit('audio:stop');
  });

  socket.on('board:ping', (payload) => {
    const room = inRoom(socket);
    const player = room && room.players.get(socket.id);
    const x = payload && clamp01(payload.x);
    const y = payload && clamp01(payload.y);
    if (!player || x === null || y === null || x === undefined || y === undefined) return;
    io.to(room.code).emit('board:ping', { x, y, by: player.name, color: player.color });
  });

  socket.on('chat:message', (payload) => {
    const room = inRoom(socket);
    const player = room && room.players.get(socket.id);
    const text = cleanText(payload && payload.text, LIMITS.chatLength);
    if (!player || !text) return;
    io.to(room.code).emit('chat:message', { name: player.name, color: player.color, text, ts: Date.now() });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZipParty listening on port ${PORT}`);
});
