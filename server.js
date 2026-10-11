
wss.on('connection', ws=>{
  const id=crypto.randomUUID();clients.set(id,{ws,name:'Jucător',room:null});send(ws,{type:'connected',id});
  ws.on('message', raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch{return fail(ws,'Mesaj JSON invalid.');}
    if(!m || typeof m!=='object' || Array.isArray(m))return fail(ws,'Mesaj invalid.');
    const c=clients.get(id);if(!c)return;
    const type=String(m.type||'');
    if(type==='create_room' || type==='join_room') {
      if(c.room)return fail(ws,'Ești deja într-o cameră.');
      c.name=String(m.name||'Jucător').trim().slice(0,24)||'Jucător';
      let room;
      if(type==='create_room') {
        let code;do{code=crypto.randomBytes(3).toString('hex').toUpperCase();}while(rooms.has(code));
        room={code,host:id,ids:[id],game:makeGame()};rooms.set(code,room);
      } else {
        room=rooms.get(String(m.roomCode||'').trim().toUpperCase());
        if(!room)return fail(ws,'Codul camerei nu există.');
        if(room.ids.length>=6)return fail(ws,'Camera are deja 6 jucători.');
        if(room.game.phase!=='lobby')return fail(ws,'Jocul a început. Intrarea este închisă.');
        room.ids.push(id);
      }
      c.room=room.code;
      send(ws,{type:type==='create_room'?'room_created':'joined_room',roomCode:room.code,playerId:id});
      broadcast(room);return;
    }
    const room=rooms.get(c.room);if(!room)return fail(ws,'Creează o cameră sau intră într-una.');
    const g=room.game;
    if(type==='start_game') {
      if(id!==room.host)return fail(ws,'Doar gazda poate porni jocul.');
      if(g.phase!=='lobby')return fail(ws,'Jocul a început deja.');
      if(room.ids.length<2)return fail(ws,'Sunt necesari cel puțin doi jucători.');
      start(room);
    } else if(type==='roll_dice') {
      if(g.phase!=='playing')return fail(ws,'Jocul nu este activ.');
      if(g.turn!==id)return fail(ws,'Nu este rândul tău.');
      const dice=[crypto.randomInt(1,7),crypto.randomInt(1,7)];
      const outcome=dice[0]===dice[1] ? ([3,5,6].includes(dice[0])?'win':'lose') : 'neutral';
      g.lastRoll={player:id,dice,outcome};
      if(outcome==='neutral') {
        g.turn=id===g.champion?g.challenger:g.champion;
        g.message=`${display(id)} a dat ${dice.join('–')}: nu contează. Urmează ${display(g.turn)}.`;
      } else {
        const winner=outcome==='win'?id:(id===g.champion?g.challenger:g.champion);
        const loser=winner===g.champion?g.challenger:g.champion;
        const explanation=outcome==='win'?'a câștigat':'a pierdut';
        g.duels++;
        nextDuel(room,winner,loser);
        g.message=`${display(id)} a dat ${dice.join('–')} și ${explanation}. ${display(winner)} este câștigătorul! ${g.message}`;
      }
    } else if(type==='chat') {
      const message=String(m.text||'').trim().slice(0,200);
      if(message)for(const pid of room.ids){const target=clients.get(pid);if(target)send(target.ws,{type:'chat',from:c.name,text:message});}
      return;
    } else return fail(ws,'Acțiune necunoscută.');
    broadcast(room);
  });
  ws.on('close',()=>leave(id));ws.on('error',()=>leave(id));
});
server.listen(port,'0.0.0.0',()=>console.log('Dice Poker duel server:',port));
