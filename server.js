import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROLES = ['PLAYER_1', 'PLAYER_2'];
const TERMINAL = new Set(['FINISHED', 'CANCELLED', 'EXPIRED']);
const DECISIONS = new Set(['RESTART', 'STALEMATE', 'REMATCH']);
const MODES = new Set(['eight', 'snooker']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_BODY = 32 * 1024;
const MAX_SNAPSHOT = 64 * 1024;
const USER_RE = /^[A-Za-z0-9_-]{32}$/;
const ACTION_RE = /^[A-Za-z0-9_-]{8,80}$/;
const SNAPSHOT_SCHEMA_VERSION = 1;
const EIGHT_BALL_IDS = [0, 1, 9, 2, 10, 8, 3, 11, 7, 14, 4, 5, 13, 15, 6, 12].sort((a, b) => a - b);
const SNOOKER_BALL_IDS = [0, ...Array.from({ length: 15 }, (_, i) => 100 + i), ...Array.from({ length: 6 }, (_, i) => 200 + i)];
const SNOOKER_TARGETS = new Set(['red', 'color', 'yellow', 'green', 'brown', 'blue', 'pink', 'black']);

function opaque(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function shortCode() {
  const bytes = randomBytes(8);
  let result = '';
  for (let i = 0; i < 8; i += 1) result += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return result;
}

function cleanText(value, field, max) {
  if (typeof value !== 'string') throw apiError(400, 'INVALID_INPUT', `${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
    throw apiError(400, 'INVALID_INPUT', `${field} must be 1-${max} printable characters`);
  }
  return result;
}

function cleanMode(value) {
  if (typeof value !== 'string' || !MODES.has(value)) throw apiError(400, 'INVALID_MODE', 'mode must be eight or snooker');
  return value;
}

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    try {
      cookies.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
    } catch {
      // Ignore malformed cookies rather than rejecting an otherwise valid request.
    }
  }
  return cookies;
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw apiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw apiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function mimeType(file) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function createGameServer(options = {}) {
  const config = {
    port: Number(options.port ?? process.env.PORT ?? 8088),
    publicDir: path.resolve(options.publicDir ?? process.env.PUBLIC_DIR ?? HERE),
    dataDir: path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(HERE, 'data')),
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === 'true',
    allowedOrigins: String(options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '')
      .split(',').map((item) => item.trim()).filter(Boolean),
    inviteTtlMs: options.inviteTtlMs ?? 15 * 60_000,
    reconnectGraceMs: options.reconnectGraceMs ?? 90_000,
    cleanupIntervalMs: options.cleanupIntervalMs ?? 30_000,
    persistence: options.persistence ?? true,
  };
  const rooms = new Map();
  const userRooms = new Map();
  const sockets = new Map();
  const reconnectTimers = new Map();
  const rateBuckets = new Map();
  const auditSalt = opaque(16);
  const stateFile = path.join(config.dataDir, 'rooms.json');
  let persistTimer;
  let persistQueue = Promise.resolve();
  let closePromise;
  let closed = false;

  function protocol(req) {
    if (req.socket.encrypted) return 'https';
    if (config.trustProxy) return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
    return 'http';
  }

  function requestOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
    return origin === `${protocol(req)}://${req.headers.host}`;
  }

  function clientKey(req) {
    let address = req.socket.remoteAddress || 'unknown';
    if (config.trustProxy && req.headers['x-forwarded-for']) address = String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return createHash('sha256').update(auditSalt).update(address).digest('base64url').slice(0, 24);
  }

  function rateLimit(key, limit, windowMs = 60_000) {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.until <= now) {
      rateBuckets.set(key, { count: 1, until: now + windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > limit) throw apiError(429, 'RATE_LIMITED', 'Too many requests');
  }

  function identity(req, res) {
    let userId = parseCookies(req.headers.cookie).get('user_id');
    let fresh = false;
    if (!USER_RE.test(userId || '')) {
      userId = opaque(24);
      fresh = true;
    }
    if (fresh && res) {
      const secure = protocol(req) === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `user_id=${userId}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=31536000`);
    }
    return userId;
  }

  function roleFor(room, userId) {
    if (room.players.PLAYER_1?.userId === userId) return 'PLAYER_1';
    if (room.players.PLAYER_2?.userId === userId) return 'PLAYER_2';
    return null;
  }

  function roomForMember(roomId, userId) {
    const room = rooms.get(roomId);
    if (!room || !roleFor(room, userId)) throw apiError(404, 'ROOM_NOT_FOUND', 'Room was not found');
    return room;
  }

  function publicRoom(room, userId) {
    const role = roleFor(room, userId);
    const result = {
      room_id: room.roomId,
      match_id: room.matchId,
      rack_id: room.rackId,
      match_code: room.matchCode,
      mode: room.mode,
      status: room.status,
      reason: room.reason || null,
      state_version: room.stateVersion,
      turn: room.turn,
      rack_breaker: room.rackBreaker,
      me: { role },
      players: Object.fromEntries(ROLES.map((item) => [item, room.players[item] ? {
        nickname: room.players[item].nickname,
        present: Boolean(room.players[item].present),
      } : null])),
      pending_request: room.pendingRequest ? {
        request_id: room.pendingRequest.requestId,
        kind: room.pendingRequest.kind,
        requested_by: room.pendingRequest.role,
        opener: room.pendingRequest.opener,
      } : null,
      pending_shot: room.pendingShot ? {
        action_id: room.pendingShot.actionId,
        by: room.pendingShot.role,
        payload: room.pendingShot.payload,
        pre_snapshot_version: room.pendingShot.preSnapshotVersion,
        rack_id: room.pendingShot.rackId,
      } : null,
      latest_snapshot: room.latestSnapshot,
      updated_at: room.updatedAt,
    };
    if (role === 'PLAYER_1' && room.status === 'WAITING') {
      result.invite = { token: room.inviteToken, code: room.inviteCode, expires_at: room.inviteExpiresAt };
    }
    return result;
  }

  function touch(room) {
    room.updatedAt = new Date().toISOString();
    schedulePersist();
  }

  function serializableRoom(room) {
    return {
      roomId: room.roomId, matchId: room.matchId, rackId: room.rackId,
      inviteToken: room.inviteToken, inviteCode: room.inviteCode,
      matchCode: room.matchCode, inviteExpiresAt: room.inviteExpiresAt,
      mode: room.mode, status: room.status, reason: room.reason,
      stateVersion: room.stateVersion, turn: room.turn, rackBreaker: room.rackBreaker, players: room.players,
      pendingRequest: room.pendingRequest, pendingShot: room.pendingShot, latestSnapshot: room.latestSnapshot,
      createdAt: room.createdAt, updatedAt: room.updatedAt,
    };
  }

  function schedulePersist() {
    if (!config.persistence || persistTimer || closed) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      queuePersist().catch((error) => console.error('Persistence failed:', error.message));
    }, 750);
    persistTimer.unref();
  }

  async function persist() {
    if (!config.persistence) return;
    await mkdir(config.dataDir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, rooms: [...rooms.values()].map(serializableRoom) }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, stateFile);
  }

  function queuePersist() {
    persistQueue = persistQueue.then(persist, persist);
    return persistQueue;
  }

  async function restore() {
    if (!config.persistence) return;
    await mkdir(config.dataDir, { recursive: true });
    let parsed;
    try {
      parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`Cannot load ${stateFile}: ${error.message}`);
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.rooms)) throw new Error('Unsupported rooms.json format');
    for (const saved of parsed.rooms) {
      const room = { ...saved, actions: new Map() };
      if (!ROLES.includes(room.rackBreaker)) room.rackBreaker = 'PLAYER_1';
      if (room.pendingRequest && (!DECISIONS.has(room.pendingRequest.kind) || !ROLES.includes(room.pendingRequest.role) || !ROLES.includes(room.pendingRequest.opener))) room.pendingRequest = null;
      if (room.pendingShot && (!ACTION_RE.test(room.pendingShot.actionId || '') || !ROLES.includes(room.pendingShot.role) || room.pendingShot.rackId !== room.rackId || !Number.isFinite(room.pendingShot.payload?.angle) || !Number.isFinite(room.pendingShot.payload?.power) || !Number.isInteger(room.pendingShot.preSnapshotVersion))) room.pendingShot = null;
      for (const role of ROLES) if (room.players[role]) room.players[role].present = false;
      if (room.status === 'PLAYING' || room.status === 'READY') {
        room.status = 'PAUSED';
        room.reason = 'SERVER_RESTART';
      }
      rooms.set(room.roomId, room);
      for (const role of ROLES) if (room.players[role] && !TERMINAL.has(room.status)) userRooms.set(room.players[role].userId, room.roomId);
    }
  }

  function uniqueCode(field) {
    let code;
    do code = shortCode(); while ([...rooms.values()].some((room) => room[field] === code));
    return code;
  }

  function createRoom(userId, body) {
    const existing = rooms.get(userRooms.get(userId));
    if (existing && !TERMINAL.has(existing.status)) throw apiError(409, 'ACTIVE_ROOM_EXISTS', 'Leave or cancel the current room first');
    const now = new Date().toISOString();
    const room = {
      roomId: randomUUID(), matchId: null, rackId: null,
      inviteToken: opaque(32), inviteCode: uniqueCode('inviteCode'), matchCode: uniqueCode('matchCode'),
      inviteExpiresAt: new Date(Date.now() + config.inviteTtlMs).toISOString(),
      mode: cleanMode(body.mode), status: 'WAITING', reason: null,
      stateVersion: 1, turn: null, rackBreaker: 'PLAYER_1',
      players: { PLAYER_1: { userId, nickname: cleanText(body.nickname, 'nickname', 32), present: false }, PLAYER_2: null },
      pendingRequest: null, pendingShot: null, latestSnapshot: null, actions: new Map(), createdAt: now, updatedAt: now,
    };
    rooms.set(room.roomId, room);
    userRooms.set(userId, room.roomId);
    schedulePersist();
    return room;
  }

  function expireWaiting(room) {
    if (room.status !== 'WAITING' || Date.parse(room.inviteExpiresAt) > Date.now()) return false;
    room.status = 'EXPIRED';
    room.reason = 'INVITE_EXPIRED';
    room.stateVersion += 1;
    userRooms.delete(room.players.PLAYER_1.userId);
    touch(room);
    broadcast(room);
    return true;
  }

  function roomForInvite(token) {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token || '')) throw apiError(404, 'INVITE_NOT_FOUND', 'Invite was not found');
    const room = [...rooms.values()].find((item) => item.inviteToken === token);
    if (!room) throw apiError(404, 'INVITE_NOT_FOUND', 'Invite was not found');
    if (room.status === 'EXPIRED' || expireWaiting(room)) throw apiError(410, 'INVITE_EXPIRED', 'Invite has expired');
    if (room.status !== 'WAITING' || room.players.PLAYER_2) throw apiError(409, 'ROOM_FULL', 'Room already has two players');
    return room;
  }

  function joinRoom(userId, body) {
    const token = typeof body.invite_token === 'string' ? body.invite_token : null;
    const code = typeof body.invite_code === 'string' ? body.invite_code.trim().toUpperCase() : null;
    if (!token && !code) throw apiError(400, 'INVALID_INPUT', 'invite_token or invite_code is required');
    if (code && (code.length !== 8 || [...code].some((character) => !CODE_ALPHABET.includes(character)))) throw apiError(400, 'INVALID_INPUT', 'invite_code must be an 8-character code');
    const room = [...rooms.values()].find((item) => token ? item.inviteToken === token : item.inviteCode === code);
    if (!room) throw apiError(404, 'INVITE_NOT_FOUND', 'Invite was not found');
    if (room.players.PLAYER_1.userId === userId) throw apiError(409, 'SELF_JOIN', 'The inviter cannot join as Player 2');
    if (room.status === 'EXPIRED' && room.reason === 'INVITE_EXPIRED') throw apiError(410, 'INVITE_EXPIRED', 'Invite has expired');
    if (expireWaiting(room)) throw apiError(410, 'INVITE_EXPIRED', 'Invite has expired');
    if (room.players.PLAYER_2 || room.status !== 'WAITING') throw apiError(409, 'ROOM_FULL', 'Room already has two players');
    const existing = rooms.get(userRooms.get(userId));
    if (existing && !TERMINAL.has(existing.status)) throw apiError(409, 'ACTIVE_ROOM_EXISTS', 'Leave the current room first');
    room.players.PLAYER_2 = { userId, nickname: cleanText(body.nickname, 'nickname', 32), present: false };
    room.matchId = randomUUID();
    room.rackId = randomUUID();
    room.status = 'PLAYING';
    room.turn = 'PLAYER_1';
    room.stateVersion += 1;
    userRooms.set(userId, room.roomId);
    touch(room);
    broadcast(room);
    return room;
  }

  function cancelRoom(room) {
    if (room.status !== 'WAITING') throw apiError(409, 'INVALID_STATE', 'Only a waiting room can be cancelled');
    room.status = 'CANCELLED';
    room.reason = 'INVITER_CANCELLED';
    room.stateVersion += 1;
    userRooms.delete(room.players.PLAYER_1.userId);
    touch(room);
    broadcast(room);
  }

  function leaveRoom(room, role) {
    if (room.status === 'CANCELLED' || room.status === 'EXPIRED') return;
    if (room.status === 'WAITING') {
      if (role !== 'PLAYER_1') throw apiError(403, 'FORBIDDEN', 'Only Player 1 belongs to a waiting room');
      cancelRoom(room);
      return;
    }
    if (!['PLAYING', 'PAUSED', 'FINISHED'].includes(room.status)) throw apiError(409, 'INVALID_STATE', 'The room cannot be left in its current state');
    room.status = 'CANCELLED';
    room.reason = `${role}_LEFT`;
    room.turn = null;
    room.pendingShot = null;
    room.pendingRequest = null;
    room.stateVersion += 1;
    for (const playerRole of ROLES) if (room.players[playerRole]) userRooms.delete(room.players[playerRole].userId);
    touch(room);
    broadcast(room);
  }

  function regenerate(room) {
    if (room.status !== 'WAITING') throw apiError(409, 'INVALID_STATE', 'Only a waiting invite can be regenerated');
    room.inviteToken = opaque(32);
    room.inviteCode = uniqueCode('inviteCode');
    room.inviteExpiresAt = new Date(Date.now() + config.inviteTtlMs).toISOString();
    room.stateVersion += 1;
    touch(room);
  }

  function socketsFor(roomId, role) {
    return sockets.get(`${roomId}:${role}`) || new Set();
  }

  function emit(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcast(room, extra) {
    for (const role of ROLES) {
      for (const ws of socketsFor(room.roomId, role)) {
        emit(ws, { type: 'ROOM_STATE', room: publicRoom(room, ws.userId) });
        if (extra) emit(ws, extra);
      }
    }
  }

  function rememberAction(room, key, event) {
    room.actions.set(key, event);
    if (room.actions.size > 256) room.actions.delete(room.actions.keys().next().value);
  }

  function requireAction(message) {
    if (!ACTION_RE.test(message.action_id || '')) throw apiError(400, 'INVALID_ACTION_ID', 'A valid action_id is required');
  }

  function normalizeSnapshot(room, payload, pending) {
    const invalid = (message) => { throw apiError(400, 'INVALID_SNAPSHOT', message); };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || jsonSize(payload) > MAX_SNAPSHOT) invalid('Snapshot must be an object no larger than 64 KiB');
    if (payload.schema_version !== SNAPSHOT_SCHEMA_VERSION) invalid('Unsupported snapshot schema version');
    if (payload.mode !== room.mode || payload.rack_id !== room.rackId) invalid('Snapshot mode or rack does not match the room');
    if (payload.shot_action_id !== pending.actionId) invalid('Snapshot does not reference the pending shot');

    const expectedIds = room.mode === 'eight' ? EIGHT_BALL_IDS : SNOOKER_BALL_IDS;
    if (!Array.isArray(payload.balls) || payload.balls.length !== expectedIds.length) invalid('Snapshot has an invalid ball count');
    const balls = payload.balls.map((ball) => {
      if (!ball || typeof ball !== 'object' || !Number.isInteger(ball.n) || !Number.isFinite(ball.x) || ball.x < 30 || ball.x > 1070 || !Number.isFinite(ball.y) || ball.y < 30 || ball.y > 610 || typeof ball.potted !== 'boolean' || (ball.vx !== undefined && ball.vx !== 0) || (ball.vy !== undefined && ball.vy !== 0)) invalid('Snapshot contains an invalid or moving ball');
      return { n: ball.n, x: ball.x, y: ball.y, potted: ball.potted };
    }).sort((a, b) => a.n - b.n);
    if (!expectedIds.every((id, index) => balls[index].n === id)) invalid('Snapshot ball identities do not match the mode');

    if (!Array.isArray(payload.players) || payload.players.length !== 2) invalid('Snapshot must contain two players');
    const players = payload.players.map((player) => {
      if (!player || typeof player !== 'object' || !Number.isInteger(player.score) || player.score < 0 || player.score > 1000 || !Number.isInteger(player.fouls) || player.fouls < 0 || player.fouls > 3 || ![null, 'solid', 'stripe'].includes(player.group)) invalid('Snapshot contains invalid player state');
      return { score: player.score, group: player.group, fouls: player.fouls };
    });
    if (room.mode === 'snooker' && players.some((player) => player.group !== null)) invalid('Snooker players cannot have pool groups');

    if (![0, 1].includes(payload.turn) || payload.next_turn !== ROLES[payload.turn]) invalid('Snapshot turn and next_turn are inconsistent');
    if (payload.rack_breaker !== ROLES.indexOf(room.rackBreaker)) invalid('Snapshot rack breaker does not match the room');
    if (typeof payload.is_break !== 'boolean' || typeof payload.kitchen_restriction !== 'boolean') invalid('Snapshot rule flags are invalid');
    if (!SNOOKER_TARGETS.has(payload.snooker_target) || !Number.isInteger(payload.clearance_index) || payload.clearance_index < -1 || payload.clearance_index > 5) invalid('Snapshot snooker rule state is invalid');
    if (!Number.isInteger(payload.shots) || payload.shots < 0 || payload.shots > 10_000) invalid('Snapshot shot count is invalid');
    if (!['aim', 'placement', 'over'].includes(payload.game_state) || ![null, 0, 1].includes(payload.winner)) invalid('Snapshot game state or winner is invalid');

    let placement = null;
    if (payload.placement !== null) {
      const value = payload.placement;
      if (!value || typeof value !== 'object' || !Number.isFinite(value.x) || value.x < 30 || value.x > 1070 || !Number.isFinite(value.y) || value.y < 30 || value.y > 610 || !['table', 'kitchen'].includes(value.scope)) invalid('Snapshot placement is invalid');
      placement = { x: value.x, y: value.y, scope: value.scope };
    }
    if ((payload.game_state === 'placement') !== Boolean(placement)) invalid('Snapshot placement does not match game state');
    const finished = payload.game_state === 'over';
    if (finished !== (payload.match_status === 'FINISHED')) invalid('Only an over game may declare FINISHED');
    if (!finished && payload.winner !== null) invalid('An unfinished game cannot have a winner');

    return {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      rack_id: room.rackId,
      shot_action_id: pending.actionId,
      mode: room.mode,
      balls,
      players,
      turn: payload.turn,
      is_break: payload.is_break,
      snooker_target: payload.snooker_target,
      clearance_index: payload.clearance_index,
      rack_breaker: payload.rack_breaker,
      placement,
      game_state: payload.game_state,
      winner: payload.winner,
      kitchen_restriction: payload.kitchen_restriction,
      shots: payload.shots,
      next_turn: payload.next_turn,
      ...(finished ? { match_status: 'FINISHED' } : {}),
    };
  }

  function handleGameMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      throw apiError(400, 'INVALID_MESSAGE', 'Message must be a JSON object');
    }
    const room = roomForMember(ws.roomId, ws.userId);
    const role = roleFor(room, ws.userId);
    requireAction(message);
    const actionKey = `${role}:${message.action_id}`;
    if (room.actions.has(actionKey)) {
      emit(ws, { type: 'ACK', action_id: message.action_id, duplicate: true, state_version: room.stateVersion });
      return;
    }
    if (jsonSize(message) > MAX_SNAPSHOT + 2048) throw apiError(413, 'PAYLOAD_TOO_LARGE', 'WebSocket message is too large');

    let event;
    if (message.type === 'SHOT' || message.type === 'PLACEMENT') {
      if (room.turn !== role) throw apiError(403, 'NOT_YOUR_TURN', 'It is not your turn');
      if (message.type === 'SHOT') {
        if (room.status !== 'PLAYING') throw apiError(409, 'INVALID_STATE', 'The match is not playing');
        if (!ROLES.every((item) => room.players[item]?.present)) throw apiError(409, 'PEER_OFFLINE', 'Both players must be connected');
      } else {
        const allowedDuringPause = room.status === 'PAUSED' && room.reason === 'PLAYER_DISCONNECTED';
        if (room.status !== 'PLAYING' && !allowedDuringPause) throw apiError(409, 'PLACEMENT_UNAVAILABLE', 'Placement is not available in the current room state');
        if (!room.players[role]?.present) throw apiError(409, 'PLAYER_OFFLINE', 'The placing player must be connected');
      }
      if (room.pendingShot) throw apiError(409, 'SHOT_PENDING', 'The accepted shot has not settled');
      if (message.type === 'SHOT' && room.latestSnapshot?.game_state === 'placement') throw apiError(409, 'PLACEMENT_REQUIRED', 'Ball placement must be confirmed before shooting');
      if (message.type === 'PLACEMENT' && room.latestSnapshot?.game_state !== 'placement') throw apiError(409, 'PLACEMENT_NOT_ALLOWED', 'Ball placement is not available');
      if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload) || jsonSize(message.payload) > 16_384) {
        throw apiError(400, 'INVALID_PAYLOAD', 'Action payload must be an object no larger than 16 KiB');
      }
      if (message.type === 'SHOT' && (!Number.isFinite(message.payload.angle) || message.payload.angle < -Math.PI || message.payload.angle > Math.PI || !Number.isFinite(message.payload.power) || message.payload.power < 0.05 || message.payload.power > 1)) {
        throw apiError(400, 'INVALID_PAYLOAD', 'Shot angle or power is outside the allowed range');
      }
      if (message.type === 'PLACEMENT' && (!Number.isFinite(message.payload.x) || message.payload.x < 0 || message.payload.x > 1100 || !Number.isFinite(message.payload.y) || message.payload.y < 0 || message.payload.y > 640 || !['table', 'kitchen'].includes(message.payload.scope))) {
        throw apiError(400, 'INVALID_PAYLOAD', 'Placement is outside the table or has an invalid scope');
      }
      if (message.type === 'PLACEMENT') {
        const authoritativeScope = room.latestSnapshot.placement.scope;
        if (message.payload.scope !== authoritativeScope) throw apiError(409, 'PLACEMENT_SCOPE_MISMATCH', 'Placement scope does not match the awarded ball in hand');
        const { x, y } = message.payload;
        const scope = authoritativeScope;
        const pockets = [[75, 75], [1025, 75], [75, 565], [1025, 565], [550, 71], [550, 569]];
        const overlaps = room.latestSnapshot.balls.some((ball) => ball.n !== 0 && !ball.potted && Math.hypot(x - ball.x, y - ball.y) < 26);
        if (x < 92 || x > 1008 || y < 92 || y > 548 || (scope === 'kitchen' && x > 286.8) || pockets.some(([px, py]) => Math.hypot(x - px, y - py) < 42) || overlaps) {
          throw apiError(400, 'INVALID_PAYLOAD', 'Placement is not legal on the current table');
        }
      }
      const payload = message.type === 'SHOT'
        ? { angle: message.payload.angle, power: message.payload.power }
        : { x: message.payload.x, y: message.payload.y, scope: room.latestSnapshot.placement.scope };
      if (message.type === 'SHOT') room.pendingShot = { actionId: message.action_id, role, payload, preSnapshotVersion: room.stateVersion, rackId: room.rackId };
      if (message.type === 'PLACEMENT' && room.latestSnapshot?.game_state === 'placement') {
        room.latestSnapshot = {
          ...room.latestSnapshot,
          balls: room.latestSnapshot.balls.map((ball) => ball.n === 0 ? { ...ball, x: payload.x, y: payload.y, potted: false } : ball),
          placement: null,
          game_state: 'aim',
          kitchen_restriction: payload.scope === 'kitchen',
        };
      }
      room.stateVersion += 1;
      event = { type: message.type, action_id: message.action_id, by: role, payload, state_version: room.stateVersion };
    } else if (message.type === 'SNAPSHOT') {
      if (room.status !== 'PLAYING') throw apiError(409, 'INVALID_STATE', 'The match cannot accept a snapshot');
      const pending = room.pendingShot;
      if (!pending) throw apiError(409, 'SHOT_NOT_PENDING', 'No accepted shot is awaiting settlement');
      if (pending.role !== role) throw apiError(403, 'NOT_SHOT_AUTHORITY', 'Only the accepted shot origin may publish its snapshot');
      const snapshot = normalizeSnapshot(room, message.payload, pending);
      room.latestSnapshot = snapshot;
      room.pendingShot = null;
      if (snapshot.match_status === 'FINISHED') {
        room.status = 'FINISHED';
        room.reason = 'MATCH_FINISHED';
        room.turn = null;
      } else room.turn = snapshot.next_turn;
      room.stateVersion += 1;
      event = { type: 'SNAPSHOT', action_id: message.action_id, by: role, payload: snapshot, state_version: room.stateVersion };
    } else if (typeof message.type === 'string' && message.type.endsWith('_REQUEST')) {
      const kind = message.type.slice(0, -8);
      if (!DECISIONS.has(kind)) throw apiError(400, 'UNKNOWN_EVENT', 'Unknown request type');
      if (room.pendingRequest) throw apiError(409, 'REQUEST_PENDING', 'Another bilateral request is pending');
      if (room.pendingShot) throw apiError(409, 'SHOT_PENDING', 'Wait for the accepted shot to settle');
      if (kind === 'REMATCH' && room.status !== 'FINISHED') throw apiError(409, 'INVALID_STATE', 'Rematch is available after a finished match');
      if (kind !== 'REMATCH' && !['PLAYING', 'PAUSED'].includes(room.status)) throw apiError(409, 'INVALID_STATE', 'Request is not valid in the current state');
      const opener = message.payload?.opener;
      if (!ROLES.includes(opener)) throw apiError(400, 'INVALID_OPENER', 'A valid requested opener is required');
      const winner = room.latestSnapshot?.winner;
      const expectedOpener = kind === 'RESTART' ? 'PLAYER_1' : kind === 'STALEMATE' ? room.rackBreaker : winner === 1 ? 'PLAYER_2' : 'PLAYER_1';
      if (opener !== expectedOpener) throw apiError(400, 'INVALID_OPENER', 'Requested opener does not match the game result');
      room.pendingRequest = { requestId: randomUUID(), kind, role, opener };
      room.stateVersion += 1;
      event = { type: message.type, action_id: message.action_id, request_id: room.pendingRequest.requestId, by: role, state_version: room.stateVersion };
    } else if (typeof message.type === 'string' && message.type.endsWith('_ACCEPT')) {
      const kind = message.type.slice(0, -7);
      const pending = room.pendingRequest;
      if (!DECISIONS.has(kind)) throw apiError(400, 'UNKNOWN_EVENT', 'Unknown acceptance type');
      if (!pending || pending.kind !== kind || pending.requestId !== message.request_id) throw apiError(409, 'REQUEST_NOT_FOUND', 'Matching request was not found');
      if (pending.role === role) throw apiError(403, 'BILATERAL_REQUIRED', 'The other player must accept');
      room.pendingRequest = null;
      room.pendingShot = null;
      room.latestSnapshot = null;
      room.rackId = randomUUID();
      if (kind === 'REMATCH') room.matchId = randomUUID();
      room.status = 'PLAYING';
      room.reason = kind === 'STALEMATE' ? 'STALEMATE_ACCEPTED' : null;
      room.turn = pending.opener;
      room.rackBreaker = pending.opener;
      room.stateVersion += 1;
      event = { type: message.type, action_id: message.action_id, request_id: message.request_id, by: role, opener: pending.opener, rack_id: room.rackId, match_id: room.matchId, state_version: room.stateVersion };
    } else if (typeof message.type === 'string' && (message.type.endsWith('_DECLINE') || message.type.endsWith('_CANCEL'))) {
      const cancel = message.type.endsWith('_CANCEL');
      const kind = message.type.slice(0, cancel ? -7 : -8);
      const pending = room.pendingRequest;
      if (!DECISIONS.has(kind)) throw apiError(400, 'UNKNOWN_EVENT', 'Unknown decision type');
      if (!pending || pending.kind !== kind || pending.requestId !== message.request_id) throw apiError(409, 'REQUEST_NOT_FOUND', 'Matching request was not found');
      if (cancel ? pending.role !== role : pending.role === role) {
        throw apiError(403, cancel ? 'REQUESTER_REQUIRED' : 'BILATERAL_REQUIRED', cancel ? 'Only the requester may cancel' : 'Only the other player may decline');
      }
      room.pendingRequest = null;
      room.stateVersion += 1;
      event = { type: message.type, action_id: message.action_id, request_id: message.request_id, by: role, state_version: room.stateVersion };
    } else {
      throw apiError(400, 'UNKNOWN_EVENT', 'Unsupported WebSocket event type');
    }
    rememberAction(room, actionKey, event);
    touch(room);
    broadcast(room, { type: 'PEER_EVENT', event });
    emit(ws, { type: 'ACK', action_id: message.action_id, duplicate: false, state_version: room.stateVersion });
  }

  function addSocket(ws, room, role) {
    const key = `${room.roomId}:${role}`;
    if (!sockets.has(key)) sockets.set(key, new Set());
    sockets.get(key).add(ws);
    const timer = reconnectTimers.get(key);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(key);
    room.players[role].present = true;
    if (room.status === 'PAUSED' && ROLES.every((item) => room.players[item]?.present)) {
      room.status = 'PLAYING';
      room.reason = null;
      room.stateVersion += 1;
    }
    touch(room);
    broadcast(room, { type: 'PRESENCE', role, present: true });
  }

  function removeSocket(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const role = roleFor(room, ws.userId);
    const key = `${room.roomId}:${role}`;
    const set = sockets.get(key);
    set?.delete(ws);
    if (set?.size) return;
    sockets.delete(key);
    room.players[role].present = false;
    if (room.status === 'PLAYING') {
      room.status = 'PAUSED';
      room.reason = 'PLAYER_DISCONNECTED';
      room.stateVersion += 1;
    }
    touch(room);
    broadcast(room, { type: 'PRESENCE', role, present: false, grace_ms: config.reconnectGraceMs });
    const timer = setTimeout(() => {
      reconnectTimers.delete(key);
      if (room.players[role]?.present || room.status !== 'PAUSED' || room.reason !== 'PLAYER_DISCONNECTED') return;
      room.status = 'CANCELLED';
      room.reason = 'RECONNECT_TIMEOUT';
      room.turn = null;
      room.pendingShot = null;
      room.pendingRequest = null;
      room.stateVersion += 1;
      for (const playerRole of ROLES) if (room.players[playerRole]) userRooms.delete(room.players[playerRole].userId);
      touch(room);
      broadcast(room);
    }, config.reconnectGraceMs);
    timer.unref();
    reconnectTimers.set(key, timer);
  }

  async function serveStatic(req, res, pathname) {
    let file;
    if (pathname === '/') file = path.join(config.publicDir, 'billiards.html');
    else if (pathname.startsWith('/assets/')) {
      let relative;
      try { relative = decodeURIComponent(pathname.slice(8)); } catch { throw apiError(400, 'INVALID_PATH', 'Invalid asset path'); }
      if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
        throw apiError(404, 'NOT_FOUND', 'Asset was not found');
      }
      const root = path.join(config.publicDir, 'assets');
      file = path.resolve(root, relative);
      let actual;
      try { actual = await realpath(file); } catch { throw apiError(404, 'NOT_FOUND', 'Asset was not found'); }
      const actualRoot = await realpath(root).catch(() => root);
      if (!actual.startsWith(`${actualRoot}${path.sep}`)) throw apiError(404, 'NOT_FOUND', 'Asset was not found');
      file = actual;
    } else return false;
    const details = await stat(file).catch(() => null);
    if (!details?.isFile()) throw apiError(404, 'NOT_FOUND', 'File was not found');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': pathname === '/' ? 'text/html; charset=utf-8' : mimeType(file),
      'Content-Length': data.length,
      'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    });
    if (req.method === 'HEAD') res.end(); else res.end(data);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const url = new URL(req.url, 'http://internal');
      if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, url.pathname)) return;
      if (url.pathname === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', uptime_seconds: Math.floor(process.uptime()), rooms: rooms.size });
      }
      if (!url.pathname.startsWith('/api/')) throw apiError(404, 'NOT_FOUND', 'Route was not found');
      if (!requestOriginAllowed(req)) throw apiError(403, 'ORIGIN_DENIED', 'Origin is not allowed');
      const userId = identity(req, res);
      rateLimit(`ip:${clientKey(req)}`, 180);
      rateLimit(`user:${userId}`, 90);
      if (url.pathname === '/api/session' && req.method === 'GET') {
        const room = rooms.get(userRooms.get(userId));
        return sendJson(res, 200, { authenticated: true, room: room && roleFor(room, userId) ? publicRoom(room, userId) : null });
      }
      const inviteMatch = url.pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]{32,64})(?:\/(qr\.svg))?$/);
      if (inviteMatch && req.method === 'GET') {
        rateLimit(`invite-preview:${clientKey(req)}`, 60);
        const room = roomForInvite(inviteMatch[1]);
        if (!inviteMatch[2]) return sendJson(res, 200, { invite: { inviter_nickname: room.players.PLAYER_1.nickname, mode: room.mode, status: room.status, expires_at: room.inviteExpiresAt } });
        const inviteUrl = `${protocol(req)}://${req.headers.host}/?invite=${encodeURIComponent(room.inviteToken)}`;
        const svg = await QRCode.toString(inviteUrl, { type: 'svg', margin: 1, width: 220, color: { dark: '#101713', light: '#ffffff' } });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(svg), 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        res.end(svg);
        return;
      }
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        rateLimit(`create:${userId}`, 10, 15 * 60_000);
        const room = createRoom(userId, await readJson(req));
        return sendJson(res, 201, { room: publicRoom(room, userId) });
      }
      if (url.pathname === '/api/rooms/join' && req.method === 'POST') {
        rateLimit(`join:${userId}`, 30, 15 * 60_000);
        const room = joinRoom(userId, await readJson(req));
        return sendJson(res, 200, { room: publicRoom(room, userId) });
      }
      const match = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]+)(?:\/(cancel|invite|leave))?$/i);
      if (!match) throw apiError(404, 'NOT_FOUND', 'Route was not found');
      const room = roomForMember(match[1], userId);
      const role = roleFor(room, userId);
      if (!match[2] && req.method === 'GET') return sendJson(res, 200, { room: publicRoom(room, userId) });
      if (match[2] === 'leave' && req.method === 'POST') {
        leaveRoom(room, role);
        return sendJson(res, 200, { room: publicRoom(room, userId) });
      }
      if (role !== 'PLAYER_1') throw apiError(403, 'FORBIDDEN', 'Only Player 1 can manage the invite');
      if (match[2] === 'cancel' && req.method === 'POST') {
        cancelRoom(room);
        return sendJson(res, 200, { room: publicRoom(room, userId) });
      }
      if (match[2] === 'invite' && req.method === 'POST') {
        regenerate(room);
        return sendJson(res, 200, { room: publicRoom(room, userId) });
      }
      throw apiError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed');
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error('Request failed:', error);
      if (!res.headersSent) sendJson(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status === 500 ? 'Internal server error' : error.message } });
      else res.destroy();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SNAPSHOT + 2048 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://internal');
      if (url.pathname !== '/ws') throw apiError(404, 'NOT_FOUND', 'WebSocket route was not found');
      if (!requestOriginAllowed(req)) throw apiError(403, 'ORIGIN_DENIED', 'Origin is not allowed');
      rateLimit(`ws-ip:${clientKey(req)}`, 40);
      const userId = identity(req);
      const roomId = url.searchParams.get('room_id') || userRooms.get(userId);
      const room = roomForMember(roomId, userId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = userId;
        ws.roomId = room.roomId;
        ws.alive = true;
        wss.emit('connection', ws, room);
      });
    } catch (error) {
      const status = error.status || 401;
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    }
  });

  wss.on('connection', (ws, room) => {
    const role = roleFor(room, ws.userId);
    addSocket(ws, room, role);
    emit(ws, { type: 'CONNECTED', room: publicRoom(room, ws.userId) });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      try { handleGameMessage(ws, raw); }
      catch (error) {
        let actionId;
        try { actionId = JSON.parse(raw.toString())?.action_id; } catch {}
        emit(ws, { type: 'ERROR', ...(ACTION_RE.test(actionId || '') ? { action_id: actionId } : {}), error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : 'Internal server error' } });
      }
    });
    ws.on('close', () => removeSocket(ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 30_000);
  heartbeat.unref();

  const cleanup = setInterval(() => {
    const now = Date.now();
    let removed = false;
    for (const room of rooms.values()) {
      expireWaiting(room);
      if (TERMINAL.has(room.status) && Date.parse(room.updatedAt) < now - 24 * 60 * 60_000) {
        rooms.delete(room.roomId);
        removed = true;
      }
    }
    if (removed) schedulePersist();
    for (const [key, bucket] of rateBuckets) if (bucket.until < now) rateBuckets.delete(key);
  }, config.cleanupIntervalMs);
  cleanup.unref();

  return {
    server,
    async listen(port = config.port, host = '0.0.0.0') {
      await restore();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return server.address();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        clearInterval(heartbeat);
        clearInterval(cleanup);
        clearTimeout(persistTimer);
        for (const timer of reconnectTimers.values()) clearTimeout(timer);
        for (const ws of wss.clients) ws.terminate();
        if (config.persistence) await queuePersist();
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createGameServer();
  app.listen().then((address) => {
    console.log(`Billiards service listening on ${typeof address === 'object' ? address.port : address}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  const shutdown = () => app.close().finally(() => process.exit());
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
