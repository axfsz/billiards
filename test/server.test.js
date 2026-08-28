import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { WebSocket } from 'ws';
import { createGameServer } from '../server.js';

let app;
let base;

beforeEach(async () => {
  app = createGameServer({ persistence: false, inviteTtlMs: 80, reconnectGraceMs: 100, cleanupIntervalMs: 20 });
  const address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => app.close());

async function request(path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { response, json, cookie: response.headers.get('set-cookie')?.match(/user_id=[^;]+/)?.[0] || cookie };
}

async function createPlayer(nickname = 'One', mode = 'eight') {
  const session = await request('/api/session');
  const created = await request('/api/rooms', { cookie: session.cookie, method: 'POST', body: { mode, nickname } });
  return { cookie: session.cookie, room: created.json.room };
}

async function join(invite, nickname = 'Two', cookie) {
  if (!cookie) cookie = (await request('/api/session')).cookie;
  const result = await request('/api/rooms/join', { cookie, method: 'POST', body: { invite_token: invite, nickname } });
  return { ...result, cookie };
}

function connect(roomId, cookie) {
  const wsUrl = base.replace('http:', 'ws:') + `/ws?room_id=${roomId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie, origin: base } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws, predicate = () => true, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WebSocket message timeout')); }, timeout);
    const listener = (data) => {
      const message = JSON.parse(data);
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', listener); };
    ws.on('message', listener);
  });
}

const EIGHT_IDS = Array.from({ length: 16 }, (_, i) => i);
const SNOOKER_IDS = [0, ...Array.from({ length: 15 }, (_, i) => 100 + i), ...Array.from({ length: 6 }, (_, i) => 200 + i)];
function snapshot(room, shotActionId, overrides = {}) {
  const gameState = overrides.game_state ?? 'aim';
  const turn = overrides.turn ?? 1;
  return {
    schema_version: 1,
    rack_id: room.rack_id,
    shot_action_id: shotActionId,
    mode: room.mode,
    balls: (room.mode === 'snooker' ? SNOOKER_IDS : EIGHT_IDS).map((n, i) => ({ n, x: 100 + i * 20, y: 200, potted: false })),
    players: [{ score: 0, group: null, fouls: 0 }, { score: 0, group: null, fouls: 0 }],
    turn,
    is_break: false,
    snooker_target: 'red',
    clearance_index: -1,
    rack_breaker: 0,
    placement: gameState === 'placement' ? { x: 150, y: 250, scope: 'table' } : null,
    game_state: gameState,
    winner: null,
    kitchen_restriction: false,
    shots: 1,
    next_turn: turn === 0 ? 'PLAYER_1' : 'PLAYER_2',
    ...(gameState === 'over' ? { match_status: 'FINISHED' } : {}),
    ...overrides,
  };
}

async function sendShot(ws, actionId = 'valid-shot-action', payload = { angle: 0, power: 0.5 }) {
  const ack = nextMessage(ws, (m) => m.type === 'ACK' && m.action_id === actionId);
  ws.send(JSON.stringify({ type: 'SHOT', action_id: actionId, payload }));
  await ack;
}

test('creates a stable anonymous identity with forwarded HTTPS cookie security', async () => {
  await app.close();
  app = createGameServer({ persistence: false, trustProxy: true });
  const address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  const first = await request('/api/session', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(first.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax; Path=\//);
  const second = await request('/api/session', { cookie: first.cookie, headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(second.response.headers.get('set-cookie'), null);
  assert.equal(second.json.authenticated, true);
});

test('join is atomic, rejects self-join, and reports a full room to a race loser', async () => {
  const p1 = await createPlayer();
  const self = await join(p1.room.invite.token, 'Self', p1.cookie);
  assert.equal(self.response.status, 409);
  assert.equal(self.json.error.code, 'SELF_JOIN');

  const cookies = await Promise.all([request('/api/session'), request('/api/session')]);
  const results = await Promise.all(cookies.map((session, i) => join(p1.room.invite.token, `P${i + 2}`, session.cookie)));
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  assert.equal(results.find((item) => item.response.status === 409).json.error.code, 'ROOM_FULL');
  assert.equal(results.find((item) => item.response.status === 200).json.room.me.role, 'PLAYER_2');
});

test('only supported game modes can be created', async () => {
  const session = await request('/api/session');
  const invalid = await request('/api/rooms', { cookie: session.cookie, method: 'POST', body: { mode: '9-ball', nickname: 'One' } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_MODE');
});

test('invite preview exposes only join context and provides a same-origin QR code', async () => {
  const p1 = await createPlayer('Table Host', 'snooker');
  const preview = await request(`/api/invites/${p1.room.invite.token}`);
  assert.equal(preview.response.status, 200);
  assert.deepEqual(preview.json.invite, {
    inviter_nickname: 'Table Host', mode: 'snooker', status: 'WAITING', expires_at: p1.room.invite.expires_at,
  });
  assert.equal(JSON.stringify(preview.json).includes(p1.room.room_id), false);
  assert.equal(JSON.stringify(preview.json).includes(p1.room.invite.code), false);

  const qr = await fetch(`${base}/api/invites/${p1.room.invite.token}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);
});

test('room state is member-only and does not expose user IDs or invite secrets to Player 2', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const outsider = await request(`/api/rooms/${p1.room.room_id}`);
  assert.equal(outsider.response.status, 404);
  const state = await request(`/api/rooms/${p1.room.room_id}`, { cookie: p2.cookie });
  assert.equal(state.response.status, 200);
  assert.equal(state.json.room.invite, undefined);
  assert.equal(JSON.stringify(state.json).includes('userId'), false);
});

test('relay enforces turn, increments versions, and deduplicates action IDs', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const denied = nextMessage(ws2, (m) => m.type === 'ERROR');
  ws2.send(JSON.stringify({ type: 'SHOT', action_id: 'action-p2-001', payload: { angle: 0, power: 0.5 } }));
  assert.equal((await denied).error.code, 'NOT_YOUR_TURN');

  const peer = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'SHOT');
  ws1.send(JSON.stringify({ type: 'SHOT', action_id: 'action-p1-001', payload: { angle: 0, power: 0.5 } }));
  const relayed = await peer;
  assert.equal(relayed.event.by, 'PLAYER_1');

  const duplicate = nextMessage(ws1, (m) => m.type === 'ACK' && m.action_id === 'action-p1-001' && m.duplicate);
  ws1.send(JSON.stringify({ type: 'SHOT', action_id: 'action-p1-001', payload: { angle: 0, power: 0.9 } }));
  assert.equal((await duplicate).state_version, relayed.event.state_version);

  const snap = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'SNAPSHOT');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'snapshot-p1-01', payload: snapshot(p2.json.room, 'action-p1-001') }));
  await snap;
  const p2Shot = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'SHOT');
  ws2.send(JSON.stringify({ type: 'SHOT', action_id: 'action-p2-002', payload: { angle: 0, power: 0.4 } }));
  assert.equal((await p2Shot).event.by, 'PLAYER_2');
  ws1.close();
  ws2.close();
});

test('disconnect pauses play and reconnect restores presence within grace', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  let ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const paused = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PAUSED');
  ws1.close();
  assert.equal((await paused).room.players.PLAYER_1.present, false);
  const playing = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PLAYING');
  ws1 = await connect(p1.room.room_id, p1.cookie);
  assert.equal((await playing).room.players.PLAYER_1.present, true);
  ws1.close();
  ws2.close();
});

test('strict snapshots reject malformed state without mutation and require the pending shot reference', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const initialVersion = (await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie })).json.room.state_version;
  const noShot = nextMessage(ws1, (m) => m.type === 'ERROR' && m.action_id === 'snapshot-without-shot');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'snapshot-without-shot', payload: snapshot(p2.json.room, 'missing-shot-action') }));
  assert.equal((await noShot).error.code, 'SHOT_NOT_PENDING');
  assert.equal((await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie })).json.room.state_version, initialVersion);
  await sendShot(ws1, 'strict-shot-action');
  const before = await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie });
  assert.deepEqual(before.json.room.pending_shot, {
    action_id: 'strict-shot-action', by: 'PLAYER_1', payload: { angle: 0, power: 0.5 },
    pre_snapshot_version: before.json.room.state_version - 1, rack_id: p2.json.room.rack_id,
  });

  for (const [id, payload] of [
    ['bad-schema-snapshot', { ...snapshot(p2.json.room, 'strict-shot-action'), schema_version: 2 }],
    ['bad-balls-snapshot', { ...snapshot(p2.json.room, 'strict-shot-action'), balls: [] }],
    ['bad-reference-snapshot', snapshot(p2.json.room, 'different-shot-action')],
    ['bad-turn-snapshot', { ...snapshot(p2.json.room, 'strict-shot-action'), next_turn: 'PLAYER_1' }],
  ]) {
    const denied = nextMessage(ws1, (m) => m.type === 'ERROR' && m.action_id === id);
    ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: id, payload }));
    assert.equal((await denied).error.code, 'INVALID_SNAPSHOT');
    const unchanged = await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie });
    assert.equal(unchanged.json.room.state_version, before.json.room.state_version);
    assert.equal(unchanged.json.room.turn, 'PLAYER_1');
    assert.equal(unchanged.json.room.pending_shot.action_id, 'strict-shot-action');
    assert.equal(unchanged.json.room.latest_snapshot, null);
  }
  ws1.close(); ws2.close();
});

test('strict snapshot identities support snooker and reject an eight-ball shape', async () => {
  const p1 = await createPlayer('One', 'snooker');
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendShot(ws1, 'snooker-shape-shot');
  const malformed = { ...snapshot(p2.json.room, 'snooker-shape-shot'), balls: EIGHT_IDS.map((n, i) => ({ n, x: 100 + i * 20, y: 200, potted: false })) };
  const denied = nextMessage(ws1, (m) => m.type === 'ERROR' && m.action_id === 'snooker-wrong-balls');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'snooker-wrong-balls', payload: malformed }));
  assert.equal((await denied).error.code, 'INVALID_SNAPSHOT');
  const accepted = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.pending_shot === null && m.room.turn === 'PLAYER_2');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'snooker-valid-snapshot', payload: snapshot(p2.json.room, 'snooker-shape-shot') }));
  assert.equal((await accepted).room.latest_snapshot.balls.length, 22);
  ws1.close(); ws2.close();
});

test('pending shot blocks more gameplay, survives reconnect, and valid settlement clears it and advances turn', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  let ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendShot(ws1, 'locked-shot-action', { angle: 0.25, power: 0.6 });

  for (const [type, id, payload] of [
    ['SHOT', 'second-shot-action', { angle: 0, power: 0.4 }],
    ['PLACEMENT', 'blocked-placement', { x: 200, y: 200, scope: 'table' }],
  ]) {
    const denied = nextMessage(ws1, (m) => m.type === 'ERROR' && m.action_id === id);
    ws1.send(JSON.stringify({ type, action_id: id, payload }));
    assert.equal((await denied).error.code, 'SHOT_PENDING');
  }

  const paused = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PAUSED');
  ws1.close();
  assert.equal((await paused).room.pending_shot.action_id, 'locked-shot-action');
  ws1 = await connect(p1.room.room_id, p1.cookie);
  const recovered = await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie });
  assert.deepEqual(recovered.json.room.pending_shot.payload, { angle: 0.25, power: 0.6 });

  const settled = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.pending_shot === null && m.room.turn === 'PLAYER_2');
  const normalized = snapshot(p2.json.room, 'locked-shot-action', { ignored: 'not stored' });
  normalized.balls[0].ignored = true;
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'locked-shot-snapshot', payload: normalized }));
  const room = (await settled).room;
  assert.equal(room.latest_snapshot.shot_action_id, 'locked-shot-action');
  assert.equal(room.turn, 'PLAYER_2');
  assert.equal(room.latest_snapshot.ignored, undefined);
  assert.equal(room.latest_snapshot.balls[0].ignored, undefined);
  ws1.close(); ws2.close();
});

test('placement persists while playing and during player-disconnect pause, then reconnect resumes updated aim state', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  let ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));

  await sendShot(ws1, 'placement-setup-shot');
  let settled = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.pending_shot === null && m.room.latest_snapshot?.game_state === 'placement');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'placement-setup-snapshot', payload: snapshot(p2.json.room, 'placement-setup-shot', { game_state: 'placement' }) }));
  await settled;

  let placed = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.latest_snapshot?.game_state === 'aim' && m.room.latest_snapshot.balls.find((ball) => ball.n === 0)?.x === 500);
  ws2.send(JSON.stringify({ type: 'PLACEMENT', action_id: 'playing-placement', payload: { x: 500, y: 300, scope: 'table' } }));
  assert.equal((await placed).room.status, 'PLAYING');

  await sendShot(ws2, 'paused-placement-shot');
  settled = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.pending_shot === null && m.room.latest_snapshot?.game_state === 'placement');
  ws2.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'paused-placement-snapshot', payload: snapshot(p2.json.room, 'paused-placement-shot', { game_state: 'placement', turn: 0, next_turn: 'PLAYER_1', shots: 2 }) }));
  await settled;

  const paused = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PAUSED');
  ws2.close();
  assert.equal((await paused).room.reason, 'PLAYER_DISCONNECTED');
  const shotDenied = nextMessage(ws1, (m) => m.type === 'ERROR' && m.action_id === 'paused-shot-denied');
  ws1.send(JSON.stringify({ type: 'SHOT', action_id: 'paused-shot-denied', payload: { angle: 0, power: 0.5 } }));
  assert.equal((await shotDenied).error.code, 'INVALID_STATE');

  placed = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PAUSED' && m.room.latest_snapshot?.game_state === 'aim');
  ws1.send(JSON.stringify({ type: 'PLACEMENT', action_id: 'paused-placement-ok', payload: { x: 600, y: 300, scope: 'table' } }));
  const pausedRoom = (await placed).room;
  assert.equal(pausedRoom.latest_snapshot.balls.find((ball) => ball.n === 0).x, 600);
  assert.equal(pausedRoom.turn, 'PLAYER_1');

  const resumed = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PLAYING' && m.room.latest_snapshot?.balls.find((ball) => ball.n === 0)?.x === 600);
  ws2 = await connect(p1.room.room_id, p2.cookie);
  assert.equal((await resumed).room.latest_snapshot.game_state, 'aim');
  ws1.close(); ws2.close();
});

test('placement scope is authoritative and a rejected kitchen upgrade does not mutate state', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendShot(ws1, 'kitchen-placement-shot');
  const settled = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.latest_snapshot?.game_state === 'placement');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'kitchen-placement-snapshot', payload: snapshot(p2.json.room, 'kitchen-placement-shot', { game_state: 'placement', placement: { x: 150, y: 250, scope: 'kitchen' } }) }));
  await settled;
  const before = (await request(`/api/rooms/${p1.room.room_id}`, { cookie: p2.cookie })).json.room;

  const denied = nextMessage(ws2, (m) => m.type === 'ERROR' && m.action_id === 'kitchen-upgrade-denied');
  ws2.send(JSON.stringify({ type: 'PLACEMENT', action_id: 'kitchen-upgrade-denied', payload: { x: 500, y: 300, scope: 'table' } }));
  assert.equal((await denied).error.code, 'PLACEMENT_SCOPE_MISMATCH');
  const unchanged = (await request(`/api/rooms/${p1.room.room_id}`, { cookie: p2.cookie })).json.room;
  assert.equal(unchanged.state_version, before.state_version);
  assert.equal(unchanged.latest_snapshot.game_state, 'placement');
  assert.equal(unchanged.latest_snapshot.placement.scope, 'kitchen');

  const accepted = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'PLACEMENT');
  ws2.send(JSON.stringify({ type: 'PLACEMENT', action_id: 'kitchen-placement-valid', payload: { x: 200, y: 300, scope: 'kitchen' } }));
  assert.equal((await accepted).event.payload.scope, 'kitchen');
  ws1.close(); ws2.close();
});

test('leave from playing broadcasts terminal state, clears request and sessions, rejects outsiders, and permits retry', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const offered = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'RESTART_REQUEST');
  ws2.send(JSON.stringify({ type: 'RESTART_REQUEST', action_id: 'leave-pending-request', payload: { opener: 'PLAYER_1' } }));
  await offered;

  const outsider = await request(`/api/rooms/${p1.room.room_id}/leave`, { method: 'POST' });
  assert.equal(outsider.response.status, 404);
  const terminal = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'CANCELLED');
  const left = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p1.cookie, method: 'POST' });
  assert.equal(left.response.status, 200);
  const broadcast = (await terminal).room;
  assert.equal(broadcast.reason, 'PLAYER_1_LEFT');
  assert.equal(broadcast.pending_request, null);
  assert.equal(broadcast.pending_shot, null);
  assert.equal((await request('/api/session', { cookie: p1.cookie })).json.room, null);
  assert.equal((await request('/api/session', { cookie: p2.cookie })).json.room, null);
  const retry = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p1.cookie, method: 'POST' });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.json.room.reason, 'PLAYER_1_LEFT');
  ws1.close(); ws2.close();
});

test('Player 2 can leave a paused room and pending shot state is cleared for both users', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendShot(ws1, 'leave-pending-shot');
  const paused = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PAUSED');
  ws1.close(); await paused;
  const left = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p2.cookie, method: 'POST' });
  assert.equal(left.response.status, 200);
  assert.equal(left.json.room.status, 'CANCELLED');
  assert.equal(left.json.room.reason, 'PLAYER_2_LEFT');
  assert.equal(left.json.room.pending_shot, null);
  assert.equal(left.json.room.pending_request, null);
  assert.equal((await request('/api/session', { cookie: p1.cookie })).json.room, null);
  assert.equal((await request('/api/session', { cookie: p2.cookie })).json.room, null);
  ws2.close();
});

test('restart requires acceptance by the other player', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  const offered = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'RESTART_REQUEST');
  ws2.send(JSON.stringify({ type: 'RESTART_REQUEST', action_id: 'restart-request-01', payload: { opener: 'PLAYER_1' } }));
  const requestEvent = await offered;
  const denied = nextMessage(ws2, (m) => m.type === 'ERROR');
  ws2.send(JSON.stringify({ type: 'RESTART_ACCEPT', action_id: 'restart-accept-self', request_id: requestEvent.event.request_id }));
  assert.equal((await denied).error.code, 'BILATERAL_REQUIRED');
  const accepted = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'RESTART_ACCEPT');
  ws1.send(JSON.stringify({ type: 'RESTART_ACCEPT', action_id: 'restart-accept-p1', request_id: requestEvent.event.request_id }));
  assert.equal((await accepted).event.by, 'PLAYER_1');

  await sendShot(ws1, 'restart-finish-shot');
  const finished = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'FINISHED');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'finish-snapshot-01', payload: snapshot((await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie })).json.room, 'restart-finish-shot', { game_state: 'over', winner: 0, turn: 0, next_turn: 'PLAYER_1', match_status: 'FINISHED' }) }));
  await finished;
  const rematchOffered = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'REMATCH_REQUEST');
  ws1.send(JSON.stringify({ type: 'REMATCH_REQUEST', action_id: 'rematch-request-01', payload: { opener: 'PLAYER_1' } }));
  const rematch = await rematchOffered;
  const rematchAccepted = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PLAYING' && m.room.match_id !== p2.json.room.match_id);
  ws2.send(JSON.stringify({ type: 'REMATCH_ACCEPT', action_id: 'rematch-accept-p2', request_id: rematch.event.request_id }));
  assert.equal((await rematchAccepted).room.turn, 'PLAYER_1');
  ws1.close();
  ws2.close();
});

test('bilateral requests preserve opener and can be declined or cancelled', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);

  let offered = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'STALEMATE_REQUEST');
  ws1.send(JSON.stringify({ type: 'STALEMATE_REQUEST', action_id: 'stalemate-request-01', payload: { opener: 'PLAYER_1' } }));
  let requestEvent = (await offered).event;
  assert.equal(requestEvent.request_id.length > 10, true);
  const declined = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'STALEMATE_DECLINE');
  ws2.send(JSON.stringify({ type: 'STALEMATE_DECLINE', action_id: 'stalemate-decline-01', request_id: requestEvent.request_id }));
  await declined;

  offered = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'STALEMATE_REQUEST');
  ws1.send(JSON.stringify({ type: 'STALEMATE_REQUEST', action_id: 'stalemate-request-02', payload: { opener: 'PLAYER_1' } }));
  requestEvent = (await offered).event;
  const cancelled = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'STALEMATE_CANCEL');
  ws1.send(JSON.stringify({ type: 'STALEMATE_CANCEL', action_id: 'stalemate-cancel-01', request_id: requestEvent.request_id }));
  await cancelled;

  offered = nextMessage(ws2, (m) => m.type === 'PEER_EVENT' && m.event.type === 'STALEMATE_REQUEST');
  ws1.send(JSON.stringify({ type: 'STALEMATE_REQUEST', action_id: 'stalemate-request-03', payload: { opener: 'PLAYER_1' } }));
  requestEvent = (await offered).event;
  const accepted = nextMessage(ws1, (m) => m.type === 'ROOM_STATE' && m.room.turn === 'PLAYER_1' && m.room.pending_request === null);
  ws2.send(JSON.stringify({ type: 'STALEMATE_ACCEPT', action_id: 'stalemate-accept-03', request_id: requestEvent.request_id }));
  assert.equal((await accepted).room.turn, 'PLAYER_1');
  ws1.close();
  ws2.close();
});

test('winner opens a rematch and remains the stalemate rack breaker', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await sendShot(ws1, 'winner-two-shot');
  const finished = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'FINISHED');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'winner-two-snapshot', payload: snapshot(p2.json.room, 'winner-two-shot', { game_state: 'over', winner: 1, match_status: 'FINISHED' }) }));
  await finished;

  let offered = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'REMATCH_REQUEST');
  ws2.send(JSON.stringify({ type: 'REMATCH_REQUEST', action_id: 'winner-rematch-request', payload: { opener: 'PLAYER_2' } }));
  let requestEvent = (await offered).event;
  let accepted = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PLAYING' && m.room.turn === 'PLAYER_2');
  ws1.send(JSON.stringify({ type: 'REMATCH_ACCEPT', action_id: 'winner-rematch-accept', request_id: requestEvent.request_id }));
  await accepted;

  offered = nextMessage(ws1, (m) => m.type === 'PEER_EVENT' && m.event.type === 'STALEMATE_REQUEST');
  ws2.send(JSON.stringify({ type: 'STALEMATE_REQUEST', action_id: 'winner-stalemate-request', payload: { opener: 'PLAYER_2' } }));
  requestEvent = (await offered).event;
  accepted = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.turn === 'PLAYER_2' && m.room.pending_request === null);
  ws1.send(JSON.stringify({ type: 'STALEMATE_ACCEPT', action_id: 'winner-stalemate-accept', request_id: requestEvent.request_id }));
  assert.equal((await accepted).room.turn, 'PLAYER_2');
  ws1.close();
  ws2.close();
});

test('waiting invites expire', async () => {
  const p1 = await createPlayer();
  await new Promise((resolve) => setTimeout(resolve, 110));
  const result = await join(p1.room.invite.token);
  assert.equal(result.response.status, 410);
  assert.equal(result.json.error.code, 'INVITE_EXPIRED');
  const session = await request('/api/session', { cookie: p1.cookie });
  assert.equal(session.json.room, null);
  const leave = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p1.cookie, method: 'POST' });
  assert.equal(leave.response.status, 200);
  assert.equal(leave.json.room.status, 'EXPIRED');
});

test('reconnect timeout removes terminal rooms from both sessions', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'CANCELLED');
  ws1.close();
  assert.equal((await cancelled).room.reason, 'RECONNECT_TIMEOUT');
  assert.equal((await request('/api/session', { cookie: p1.cookie })).json.room, null);
  assert.equal((await request('/api/session', { cookie: p2.cookie })).json.room, null);
  const retry1 = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p1.cookie, method: 'POST' });
  const retry2 = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p2.cookie, method: 'POST' });
  assert.equal(retry1.response.status, 200);
  assert.equal(retry2.response.status, 200);
  assert.equal(retry1.json.room.reason, 'RECONNECT_TIMEOUT');
  const outsider = await request(`/api/rooms/${p1.room.room_id}/leave`, { method: 'POST' });
  assert.equal(outsider.response.status, 404);
  ws2.close();
});

test('finished room member can leave safely and release both sessions', async () => {
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendShot(ws1, 'finished-leave-shot');
  const finished = nextMessage(ws2, (m) => m.type === 'ROOM_STATE' && m.room.status === 'FINISHED');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'finished-leave-snapshot', payload: snapshot(p2.json.room, 'finished-leave-shot', { game_state: 'over', winner: 0, turn: 0, next_turn: 'PLAYER_1', match_status: 'FINISHED' }) }));
  await finished;
  const leave = await request(`/api/rooms/${p1.room.room_id}/leave`, { cookie: p2.cookie, method: 'POST' });
  assert.equal(leave.response.status, 200);
  assert.equal(leave.json.room.status, 'CANCELLED');
  assert.equal(leave.json.room.reason, 'PLAYER_2_LEFT');
  assert.equal((await request('/api/session', { cookie: p1.cookie })).json.room, null);
  assert.equal((await request('/api/session', { cookie: p2.cookie })).json.room, null);
  ws1.close(); ws2.close();
});

test('client statically uses placement-aware pointer gates and themed exit confirmation', async () => {
  const html = await readFile(new URL('../billiards.html', import.meta.url), 'utf8');
  assert.match(html, /function onlineCanUseTable\(\) \{ return state === "placement" \? onlineCanPlace\(\) : onlineCanAct\(\); \}/);
  assert.match(html, /function aimAssistRange\(\) \{/);
  assert.match(html, /Math\.hypot\(x - cue\.x, y - cue\.y\)/);
  assert.doesNotMatch(html, /settings\.aimAssist === "short" \? 280 : 560/);
  assert.match(html, /if \(!online\.room\) \{ confirmPlacement\(\); return; \}/);
  assert.match(html, /cv\.addEventListener\("pointermove", e => \{\s+if \(!onlineCanUseTable\(\)\) return;/);
  assert.match(html, /cv\.addEventListener\("pointerdown", e => \{\s+if \(!onlineCanUseTable\(\)\)/);
  assert.match(html, /cv\.addEventListener\("dblclick", e => \{/);
  assert.match(html, /移动白球，双击球桌确认位置/);
  assert.doesNotMatch(html, /placementConfirmHit/);
  assert.match(html, /showDecision\("退出在线对局"/);
  assert.match(html, /online\.pending\.clear\(\); online\.room = null;/);
  assert.match(html, /id="leaveLocalBtn"/);
  assert.match(html, /showDecision\("退出本地双人"/);
  assert.doesNotMatch(html, /confirm\("确定退出在线对局/);
  assert.match(html, /online\.reconnectUntil = 0; online\.pauseUntil = 0;/);
});

test('persists recoverable room metadata and the latest snapshot', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'billiards-test-'));
  await app.close();
  app = createGameServer({ dataDir, persistence: true });
  let address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await sendShot(ws1, 'saved-shot-action');
  const saved = nextMessage(ws1, (m) => m.type === 'ACK' && m.action_id === 'saved-snapshot-01');
  ws1.send(JSON.stringify({ type: 'SNAPSHOT', action_id: 'saved-snapshot-01', payload: snapshot(p2.json.room, 'saved-shot-action') }));
  await saved;
  await sendShot(ws2, 'persisted-pending-shot');
  ws1.close(); ws2.close();
  await app.close();

  app = createGameServer({ dataDir, persistence: true });
  address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  const restored = await request(`/api/rooms/${p1.room.room_id}`, { cookie: p2.cookie });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.json.room.latest_snapshot.balls.length, 16);
  assert.equal(restored.json.room.latest_snapshot.shot_action_id, 'saved-shot-action');
  assert.equal(restored.json.room.pending_shot.action_id, 'persisted-pending-shot');
  assert.equal(restored.json.room.status, 'PAUSED');
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('a playing room resumes after both members reconnect following a service restart', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'billiards-restart-test-'));
  await app.close();
  app = createGameServer({ dataDir, persistence: true });
  let address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  const p1 = await createPlayer();
  const p2 = await join(p1.room.invite.token);
  const ws1 = await connect(p1.room.room_id, p1.cookie);
  const ws2 = await connect(p1.room.room_id, p2.cookie);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const stateFile = path.join(dataDir, 'rooms.json');
  const playingState = await readFile(stateFile, 'utf8');
  ws1.close(); ws2.close();
  await app.close();

  // Preserve the last healthy PLAYING snapshot as it would exist before a process restart.
  await writeFile(stateFile, playingState, { mode: 0o600 });
  app = createGameServer({ dataDir, persistence: true });
  address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  const restored = await request(`/api/rooms/${p1.room.room_id}`, { cookie: p1.cookie });
  assert.equal(restored.json.room.status, 'PAUSED');
  assert.equal(restored.json.room.reason, 'SERVER_RESTART');

  const reconnected1 = await connect(p1.room.room_id, p1.cookie);
  const resumed = nextMessage(reconnected1, (m) => m.type === 'ROOM_STATE' && m.room.status === 'PLAYING');
  const reconnected2 = await connect(p1.room.room_id, p2.cookie);
  assert.equal((await resumed).room.reason, null);
  reconnected1.close(); reconnected2.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});
