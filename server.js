const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {"content-type":"application/json"});
    return res.end(JSON.stringify({ok:true, service:"dice-poker-ws"}));
  }
  res.writeHead(200, {"content-type":"text/plain"});
  res.end("Dice Poker WebSocket server is running. Connect to /ws\n");
});
const wss = new WebSocketServer({server, path:"/ws"});
const rooms = new Map();
const clients = new Map();

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  for (const id of room.members) {
    const c = clients.get(id);
    if (c) send(c.ws, msg);
  }
}
function roomSnapshot(room) {
  return {type:"room_state", roomCode:room.code, players:[...room.members].map(id => {
    const c=clients.get(id); return {id, name:c?.name || "Jucător", balance:room.balances[id] ?? 1000};
  }), maxPlayers:6, game:room.game};
}
function leave(ws) {
  const id=ws.clientId; if (!id) return;
  const c=clients.get(id); const room=c?.room ? rooms.get(c.room) : null;
  clients.delete(id); ws.clientId=null;
  if (room) {
    room.members=room.members.filter(x=>x!==id);
    if (!room.members.length) rooms.delete(room.code);
    else { if (room.host===id) room.host=room.members[0]; broadcast(room, roomSnapshot(room)); }
  }
}
function error(ws, message) { send(ws,{type:"error",message}); }
wss.on("connection", ws => {
  const id=crypto.randomUUID();
  ws.clientId=id; clients.set(id,{ws,name:"Jucător",room:null});
  send(ws,{type:"connected",id});
  ws.on("message", raw => {
    let m; try { m=JSON.parse(raw.toString()); } catch { return error(ws,"Mesaj JSON invalid."); }
    const c=clients.get(id); if (!c) return;
    if (m.type==="create_room") {
      if (c.room) return error(ws,"Ești deja într-o cameră.");
      let code; do { code=crypto.randomBytes(3).toString("hex").toUpperCase(); } while(rooms.has(code));
      const room={code,host:id,members:[id],balances:{[id]:1000},game:{started:false,turn:0,opponent:1,stake:0,pot:0,dice:[1,1],status:"Așteaptă jucători"}};
      rooms.set(code,room); c.room=code; c.name=String(m.name||"Gazdă").slice(0,24);
      send(ws,{type:"room_created",roomCode:code,playerId:id}); broadcast(room,roomSnapshot(room));
    } else if (m.type==="join_room") {
      const code=String(m.roomCode||"").toUpperCase(); const room=rooms.get(code);
      if (!room) return error(ws,"Camera nu există.");
      if (room.members.length>=6) return error(ws,"Camera este plină (maxim 6).");
      if (c.room) return error(ws,"Ești deja într-o cameră.");
      c.room=code; c.name=String(m.name||"Jucător").slice(0,24); room.members.push(id); room.balances[id]=1000;
      send(ws,{type:"joined_room",roomCode:code,playerId:id}); broadcast(room,roomSnapshot(room));
    } else {
      const room=c.room && rooms.get(c.room); if (!room) return error(ws,"Intră într-o cameră mai întâi.");
      if (m.type==="start_game" || m.type==="propose_stake" || m.type==="accept_stake" || m.type==="roll_dice") {
        if (id!==room.host) return error(ws,"În această versiune de bază, doar gazda poate executa acțiuni de joc.");
        if (m.type==="start_game") { room.game.started=true; room.game.status="Joc pornit"; }
        if (m.type==="propose_stake") {
          const amount=Math.floor(Number(m.amount));
          if (!Number.isFinite(amount)||amount<1||amount>100000) return error(ws,"Miza trebuie să fie între 1 și 100000.");
          room.game.stake=amount; room.game.pot=amount*2; room.game.status="Miză propusă: "+amount;
        }
        if (m.type==="accept_stake") room.game.status="Miza acceptată";
        if (m.type==="roll_dice") {
          room.game.dice=[1+Math.floor(Math.random()*6),1+Math.floor(Math.random()*6)];
          room.game.status="Zaruri: "+room.game.dice.join(" + ");
        }
        broadcast(room,roomSnapshot(room));
      } else if (m.type==="chat") {
        broadcast(room,{type:"chat",from:c.name,text:String(m.text||"").slice(0,300)});
      } else error(ws,"Tip de mesaj necunoscut.");
    }
  });
  ws.on("close",()=>leave(ws));
  ws.on("error",()=>leave(ws));
});
server.listen(PORT,"0.0.0.0",()=>console.log("Listening on "+PORT));
