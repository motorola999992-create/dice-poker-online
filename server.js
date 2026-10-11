const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const port = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.png': 'image/png', '.json': 'application/json', '.pck': 'application/octet-stream'
};
const HIDDEN = ['server.js', 'package.json', 'render.yaml'];

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, path.normalize(p));
  if (!file.startsWith(__dirname) || HIDDEN.includes(path.basename(file))) {
    res.writeHead(403); return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const clients = new Map(); // id -> {ws, name, room}
const rooms = new Map();   // cod -> {code, host, ids, game}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function fail(ws, message) { send(ws, { type: 'error', message }); }
function display(id) { return clients.get(id)?.name || 'Jucător'; }

function makeGame() {
  return { phase: 'lobby', turn: null, champion: null, challenger: null,
           queue: [], duels: 0, lastRoll: null, message: 'Așteptăm jucători.' };
}

function start(room) {
  const g = room.game, ids = [...room.ids];
  g.phase = 'playing';
  g.champion = ids[0];
  g.challenger = ids[1];
  g.queue = ids.slice(2);
  g.turn = g.champion;
  g.duels = 0;
  g.lastRoll = null;
  g.message = `${display(g.champion)} contra ${display(g.challenger)}. Începe ${display(g.turn)}.`;
}

function nextDuel(room, winner, loser) {
  const g = room.game;
  g.queue.push(loser);
  g.champion = winner;
  g.challenger = g.queue.shift();
  g.turn = g.champion;
  g.message = `Urmează ${display(g.champion)} contra ${display(g.challenger)}.`;
}

function broadcast(room) {
  const g = room.game;
  const state = {
    type: 'state',
    roomCode: room.code,
    host: room.host,
    players: room.ids.map(pid => ({ id: pid, name: display(pid) })),
    game: g
  };
  for (const pid of room.ids) {
    const c = clients.get(pid);
    if (c) send(c.ws, { ...state, you: pid });
  }
}

function leave(id) {
  const c = clients.get(id);
  if (!c) return;
  clients.delete(id);
  const room = rooms.get(c.room);
  if (!room) return;
  room.ids = room.ids.filter(x => x !== id);
  if (room.ids.length === 0) { rooms.delete(room.code); return; }
  if (room.host === id) room.host = room.ids[0];
  const g = room.game;
  if (g.phase === 'playing') {
    g.queue = g.queue.filter(x => x !== id);
    if (room.ids.length < 2) {
      room.game = makeGame();
      room.game.message = 'Un jucător a plecat. Așteptăm jucători.';
    } else if (id === g.champion || id === g.challenger) {
      const remaining = [g.champion, g.challenger].filter(x => x !== id);
      g.champion = remaining[0];
      g.challenger = g.queue.shift();
      g.turn = g.champion;
      g.message = `${display(id)} a plecat. Urmează ${display(g.champion)} contra ${display(g.challenger)}.`;
    }
  }
  broadcast(room);
}

wss.on('connection', ws => {
  const id = crypto.randomUUID();
  clients.set(id, { ws, name: 'Jucător', room: null });
  send(ws, { type: 'connected', id });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return fail(ws, 'Mesaj JSON invalid.'); }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return fail(ws, 'Mesaj invalid.');
    const c = clients.get(id);
    if (!c) return;
    const type = String(m.type || '');

    if (type === 'create_room' || type === 'join_room') {
      if (c.room) return fail(ws, 'Ești deja într-o cameră.');
      c.name = String(m.name || 'Jucător').trim().slice(0, 24) || 'Jucător';
      let room;
      if (type === 'create_room') {
        let code;
        do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        room = { code, host: id, ids: [id], game: makeGame() };
        rooms.set(code, room);
      } else {
        room = rooms.get(String(m.roomCode || '').trim().toUpperCase());
        if (!room) return fail(ws, 'Codul camerei nu există.');
        if (room.ids.length >= 6) return fail(ws, 'Camera are deja 6 jucători.');
        if (room.game.phase !== 'lobby') return fail(ws, 'Jocul a început. Intrarea este închisă.');
        room.ids.push(id);
      }
      c.room = room.code;
      send(ws, { type: type === 'create_room' ? 'room_created' : 'joined_room', roomCode: room.code, playerId: id });
      broadcast(room);
      return;
    }

    const room = rooms.get(c.room);
    if (!room) return fail(ws, 'Creează o cameră sau intră într-una.');
    const g = room.game;

    if (type === 'start_game') {
      if (id !== room.host) return fail(ws, 'Doar gazda poate porni jocul.');
      if (g.phase !== 'lobby') return fail(ws, 'Jocul a început deja.');
      if (room.ids.length < 2) return fail(ws, 'Sunt necesari cel puțin doi jucători.');
      start(room);
    } else if (type === 'roll_dice') {
      if (g.phase !== 'playing') return fail(ws, 'Jocul nu este activ.');
      if (g.turn !== id) return fail(ws, 'Nu este rândul tău.');
      const dice = [crypto.randomInt(1, 7), crypto.randomInt(1, 7)];
      const outcome = dice[0] === dice[1] ? ([3, 5, 6].includes(dice[0]) ? 'win' : 'lose') : 'neutral';
      g.lastRoll = { player: id, dice, outcome };
      if (outcome === 'neutral') {
        g.turn = id === g.champion ? g.challenger : g.champion;
        g.message = `${display(id)} a dat ${dice.join('–')}: nu contează. Urmează ${display(g.turn)}.`;
      } else {
        const winner = outcome === 'win' ? id : (id === g.champion ? g.challenger : g.champion);
        const loser = winner === g.champion ? g.challenger : g.champion;
        const explanation = outcome === 'win' ? 'a câștigat' : 'a pierdut';
        g.duels++;
        nextDuel(room, winner, loser);
        g.message = `${display(id)} a dat ${dice.join('–')} și ${explanation}. ${display(winner)} este câștigătorul! ${g.message}`;
      }
    } else if (type === 'chat') {
      const message = String(m.text || '').trim().slice(0, 200);
      if (message) {
        for (const pid of room.ids) {
          const target = clients.get(pid);
          if (target) send(target.ws, { type: 'chat', from: c.name, text: message });
        }
      }
      return;
    } else return fail(ws, 'Acțiune necunoscută.');

    broadcast(room);
  });

  ws.on('close', () => leave(id));
  ws.on('error', () => leave(id));
});

server.listen(port, '0.0.0.0', () => console.log('Dice Poker duel server:', port));
