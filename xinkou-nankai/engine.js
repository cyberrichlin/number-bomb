'use strict';
/**
 * 「心口难开」纯静态 P2P 引擎（零服务端）
 * ------------------------------------------------------------------
 * 架构与「数字炸弹」一致：PeerJS 云信令 + WebRTC DataChannel，房主为星型中枢。
 *   · 房主（建房者）在浏览器内持有权威房间状态，负责全部裁决与发牌；
 *   · 客户端通过 DataChannel 发送「指令」（等价于原 server.js 的 REST 语义），
 *     房主处理后再按观察者定制下发状态（自己的词永不下发给自己）。
 *   · 房主掉线时，按 joinedAt 最早的在线玩家优先接管（复用同一个 PeerJS 房间 ID），
 *     对局中的残局会作废回到大厅（P2P 下无法无损转移「他人词牌」）。
 * 玩法规则、发牌配额、状态字段与原 Node 服务端版本完全一致。
 */
(function (global) {

  /* ------------------------------------------------------------------ */
  /* 常量（与 server.js 对齐）                                           */
  /* ------------------------------------------------------------------ */

  var MIN_PLAYERS = 2;
  var MAX_PLAYERS = 10;
  var HEARTBEAT_TIMEOUT = 25 * 1000;        // 心跳超时 → 视为掉线（仅在数据通道已不可用时生效）
  var HEARTBEAT_HARD_TIMEOUT = 90 * 1000;   // 数据通道仍 open 时的兜底：超过该时长无任何数据才按失联处理
  var LOBBY_GHOST_TIMEOUT = 3 * 60 * 1000;  // 大厅内掉线玩家自动移除
  var HOST_LOST_TIMEOUT = 18 * 1000;        // 客户端多久收不到房主消息算掉线
  var HOST_PREFIX = 'xknk-';                // 房主的 PeerJS ID 前缀
  var CALL_TIMEOUT = 12000;

  var CATEGORIES = ['action', 'word'];
  var WORD_LENGTHS = [1, 2, 3, 4];
  var TYPES = ['funny', 'flirty', 'daily'];

  /* ------------------------------------------------------------------ */
  /* 基础工具（移植自 server.js）                                        */
  /* ------------------------------------------------------------------ */

  function nowTs() { return Date.now(); }

  function uid() {
    try {
      var a = new Uint8Array(9);
      (global.crypto || global.msCrypto).getRandomValues(a);
      var s = '';
      for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
      return s;
    } catch (e) {
      return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    }
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function sanitizeName(name, fallback) {
    var n = (typeof name === 'string' ? name : '').trim().replace(/[\u0000-\u001f<>]/g, '');
    if (n.length > 12) n = n.slice(0, 12);
    return n || fallback;
  }

  function validateConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    var category = cfg.category;
    var wordLength = Number(cfg.wordLength);
    var type = cfg.type;
    if (CATEGORIES.indexOf(category) < 0) return null;
    if (WORD_LENGTHS.indexOf(wordLength) < 0) return null;
    if (TYPES.indexOf(type) < 0) return null;
    return { category: category, wordLength: wordLength, type: type };
  }

  function pushLog(room, text) {
    room.log.push({ t: nowTs(), text: text });
    if (room.log.length > 100) room.log.splice(0, room.log.length - 100);
    room.updatedAt = nowTs();
  }

  function bankOf(category) {
    return category === 'action' ? global.XKNK_BANK_ACTION : global.XKNK_BANK_WORD;
  }

  /* ------------------------------------------------------------------ */
  /* 房间生命周期                                                        */
  /* ------------------------------------------------------------------ */

  function createRoom(id) {
    var room = {
      id: id,
      createdAt: nowTs(),
      updatedAt: nowTs(),
      hostId: null,
      players: [],
      config: { category: 'action', wordLength: 2, type: 'daily' },
      phase: 'lobby',   // lobby | playing | result
      round: 0,
      winnerId: null,
      log: []
    };
    pushLog(room, '房间 ' + id + ' 已创建');
    return room;
  }

  function addPlayer(room, name) {
    var p = {
      id: uid(),
      token: uid(),
      name: name,
      joinedAt: nowTs(),
      lastSeen: nowTs(),
      connected: true,
      alive: true,
      selfRevealed: false,
      word: null
    };
    room.players.push(p);
    if (!room.hostId) room.hostId = p.id;
    pushLog(room, name + ' 加入了房间');
    room.updatedAt = nowTs();
    return p;
  }

  function findPlayer(room, playerId) {
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].id === playerId) return room.players[i];
    }
    return null;
  }

  /**
   * 房主侧：把某条连接对应的玩家标记为在线并刷新心跳时间。
   * 只要数据通道活着（收到 ping / 连接 open），该成员就必须算在线，
   * 否则会出现「正常联机却被标离线、日志反复刷掉线-重连」的静默状态错误（P1/P2）。
   * 返回 true 表示在线状态发生了变化（由离线转为在线），调用方据此决定是否广播。
   */
  function markEntryPlayerOnline(entry) {
    if (!entry || !entry.playerId || E.role !== 'host') return false;
    var room = E.room;
    if (!room) return false;
    var p = findPlayer(room, entry.playerId);
    if (!p) return false;
    var changed = false;
    if (!p.connected) {
      p.connected = true;
      pushLog(room, p.name + ' 重新连接');
      changed = true;
    }
    p.lastSeen = nowTs();
    entry.lastSeen = nowTs();
    if (changed) room.updatedAt = nowTs();
    return changed;
  }

  function maintain(room) {
    var now = nowTs();
    var changed = false;

    room.players.forEach(function (p) {
      // 房主本机进程活着即代表房主在线：绝不参与心跳超时判定，
      // 否则房主会被自己清理出玩家列表（P2：配置面板与自身角色消失、人数变 0）
      if (p.id === room.hostId) {
        if (!p.connected) { p.connected = true; changed = true; }
        p.lastSeen = now;
        return;
      }
      if (p.connected && now - p.lastSeen > HEARTBEAT_TIMEOUT) {
        p.connected = false;
        changed = true;
        pushLog(room, p.name + ' 掉线了');
      }
    });

    if (room.phase === 'lobby') {
      var ghosts = room.players.filter(function (p) {
        return !p.connected && now - p.lastSeen > LOBBY_GHOST_TIMEOUT;
      });
      if (ghosts.length) {
        room.players = room.players.filter(function (p) { return ghosts.indexOf(p) < 0; });
        ghosts.forEach(function (g) { pushLog(room, g.name + ' 长时间未回来，已移出房间'); });
        changed = true;
      }
    }

    var host = findPlayer(room, room.hostId);
    if (!host && room.players.length) {
      room.hostId = room.players[0].id;
      pushLog(room, '房主已离开，' + room.players[0].name + ' 成为新房主');
      changed = true;
    }

    if (changed) room.updatedAt = now;
    return changed;
  }

  function concedeHost(room, leavingId) {
    var cand = room.players
      .filter(function (p) { return p.id !== leavingId && p.connected; })
      .sort(function (a, b) { return a.joinedAt - b.joinedAt; })[0]
      || room.players.filter(function (p) { return p.id !== leavingId; })[0];
    if (cand) {
      room.hostId = cand.id;
      pushLog(room, cand.name + ' 成为新房主');
    } else {
      room.hostId = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 游戏逻辑                                                            */
  /* ------------------------------------------------------------------ */

  function dealWords(room) {
    var cfg = room.config;
    var bank = bankOf(cfg.category);
    var pool = (bank && bank[cfg.wordLength] && bank[cfg.wordLength][cfg.type]) || [];
    if (!pool.length) throw new Error('词库为空，无法发牌');
    var picked = shuffle(pool);
    room.players.forEach(function (p, i) {
      p.word = picked[i % picked.length];
      p.alive = true;
      p.selfRevealed = false;
    });
    pushLog(room, '第 ' + room.round + ' 局开始：发放词语（类别/字数/类型严格按房主选择）');
  }

  function checkWinner(room) {
    if (room.phase !== 'playing') return;
    var alive = room.players.filter(function (p) { return p.alive; });
    if (alive.length <= 1) {
      room.phase = 'result';
      room.winnerId = alive.length === 1 ? alive[0].id : null;
      if (room.winnerId) {
        room.hostId = room.winnerId;   // 开局权移交给获胜者
        pushLog(room, alive[0].name + ' 撑到最后，本局获胜！并获得下一局的开局权');
      } else {
        pushLog(room, '本局同归于尽，无人获胜');
      }
      room.players.forEach(function (p) { p.selfRevealed = false; });
    }
  }

  function canControlConfig(room, playerId) {
    if (room.phase === 'lobby') return room.hostId === playerId;
    if (room.phase === 'result') {
      if (room.winnerId) return room.winnerId === playerId;
      return room.hostId === playerId;
    }
    return false;
  }

  /** 按观察者定制状态：自己的词永不下发给自己 */
  function buildState(room, viewerId) {
    var me = findPlayer(room, viewerId) || null;
    var isPlaying = room.phase === 'playing';
    return {
      roomId: room.id,
      phase: room.phase,
      round: room.round,
      hostId: room.hostId,
      winnerId: room.winnerId,
      config: room.config,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      canControlConfig: me ? canControlConfig(room, me.id) : false,
      canStart: room.players.length >= MIN_PLAYERS && room.players.length <= MAX_PLAYERS,
      me: me && {
        id: me.id,
        name: me.name,
        isHost: me.id === room.hostId,
        alive: me.alive,
        hasWord: !!me.word,
        wordLength: me.word ? Array.from(me.word).length : 0,
        selfRevealed: me.selfRevealed,
        canControlConfig: canControlConfig(room, me.id)
      },
      players: room.players.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          isHost: p.id === room.hostId,
          alive: p.alive,
          connected: p.connected,
          isSelf: p.id === viewerId,
          hasWord: !!p.word,
          revealedWord: (p.id !== viewerId && isPlaying && p.selfRevealed && p.word) ? p.word : null,
          finalWord: room.phase === 'result' && p.word ? p.word : null
        };
      }),
      log: room.log.slice(-40)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 指令处理：等价于 server.js 的 handleApi                             */
  /* 返回 { ok, error?, data?, broadcast? }                              */
  /* ------------------------------------------------------------------ */

  function handleCommand(room, me, pathname, body) {
    body = body || {};

    if (pathname === '/api/heartbeat') return { ok: true, broadcast: false };

    if (pathname === '/api/config') {
      if (!canControlConfig(room, me.id)) return { ok: false, error: '只有房主（或本局获胜者）可以设置玩法' };
      var cfg = validateConfig(body.config);
      if (!cfg) return { ok: false, error: '配置不合法' };
      room.config = cfg;
      room.updatedAt = nowTs();
      return { ok: true, data: { state: buildState(room, me.id) } };
    }

    if (pathname === '/api/start') {
      if (!canControlConfig(room, me.id)) return { ok: false, error: '只有房主可以开始游戏' };
      if (room.phase === 'playing') return { ok: false, error: '游戏已经开始' };
      if (room.players.length < MIN_PLAYERS) {
        return { ok: false, error: '至少需要 ' + MIN_PLAYERS + ' 名玩家（当前 ' + room.players.length + ' 人）' };
      }
      if (room.players.length > MAX_PLAYERS) return { ok: false, error: '人数超过上限 ' + MAX_PLAYERS + ' 人' };
      var cfg2 = validateConfig(body.config || room.config);
      if (!cfg2) return { ok: false, error: '配置不合法' };
      room.config = cfg2;
      room.round += 1;
      room.winnerId = null;
      dealWords(room);
      room.phase = 'playing';
      room.updatedAt = nowTs();
      return { ok: true, data: { state: buildState(room, me.id) } };
    }

    if (pathname === '/api/peek') {
      if (room.phase !== 'playing') return { ok: false, error: '当前不在对局中' };
      var target = findPlayer(room, body.targetId);
      if (!target) return { ok: false, error: '该玩家不存在' };
      if (target.id === me.id) return { ok: false, error: '不能查看自己的词' };
      if (!target.word) return { ok: false, error: '该玩家暂无词牌' };
      // 只回给请求者，不广播（避免泄露）
      return { ok: true, data: { word: target.word, seconds: 5 }, broadcast: false };
    }

    if (pathname === '/api/self-reveal') {
      if (room.phase !== 'playing') return { ok: false, error: '当前不在对局中' };
      if (!me.word) return { ok: false, error: '你还没有词牌' };
      me.selfRevealed = body.show !== false;
      room.updatedAt = nowTs();
      pushLog(room, me.name + (me.selfRevealed ? ' 举起了自己的词牌' : ' 放下了词牌'));
      return { ok: true, data: { state: buildState(room, me.id) } };
    }

    if (pathname === '/api/eliminate') {
      if (room.phase !== 'playing') return { ok: false, error: '当前不在对局中' };
      if (!me.alive) return { ok: false, error: '你已被淘汰，无法参与裁决' };
      var t1 = findPlayer(room, body.targetId);
      if (!t1) return { ok: false, error: '该玩家不存在' };
      if (!t1.alive) return { ok: false, error: t1.name + ' 已经被淘汰' };
      if (t1.id === me.id) return { ok: false, error: '不能淘汰自己' };
      t1.alive = false;
      t1.selfRevealed = false;
      pushLog(room, me.name + ' 指出 ' + t1.name + ' 已经' + (room.config.category === 'action' ? '做出了' : '说出了') + '词牌，' + t1.name + ' 被淘汰');
      room.updatedAt = nowTs();
      checkWinner(room);
      return { ok: true, data: { state: buildState(room, me.id), phase: room.phase } };
    }

    if (pathname === '/api/revive') {
      if (room.phase !== 'playing') return { ok: false, error: '当前不在对局中' };
      if (room.hostId !== me.id) return { ok: false, error: '只有房主可以撤销淘汰' };
      var t2 = findPlayer(room, body.targetId);
      if (!t2) return { ok: false, error: '该玩家不存在' };
      if (t2.alive) return { ok: false, error: t2.name + ' 并未被淘汰' };
      t2.alive = true;
      pushLog(room, '房主撤销了对 ' + t2.name + ' 的淘汰判定');
      room.updatedAt = nowTs();
      return { ok: true, data: { state: buildState(room, me.id) } };
    }

    if (pathname === '/api/restart') {
      if (room.phase !== 'result') return { ok: false, error: '本局尚未结束' };
      if (!canControlConfig(room, me.id)) return { ok: false, error: '只有本局获胜者（或房主）可以重开' };
      var cfg3 = validateConfig(body.config || room.config);
      if (!cfg3) return { ok: false, error: '配置不合法' };
      room.config = cfg3;
      room.round += 1;
      room.winnerId = null;
      dealWords(room);
      room.phase = 'playing';
      room.updatedAt = nowTs();
      return { ok: true, data: { state: buildState(room, me.id) } };
    }

    if (pathname === '/api/back-to-lobby') {
      if (!canControlConfig(room, me.id)) return { ok: false, error: '只有房主（或本局获胜者）可以操作' };
      room.phase = 'lobby';
      room.winnerId = null;
      room.players.forEach(function (p) { p.word = null; p.alive = true; p.selfRevealed = false; });
      pushLog(room, '已返回大厅');
      room.updatedAt = nowTs();
      return { ok: true, data: { state: buildState(room, me.id) } };
    }

    if (pathname === '/api/leave') {
      var wasHost = room.hostId === me.id;
      room.players = room.players.filter(function (p) { return p.id !== me.id; });
      pushLog(room, me.name + ' 离开了房间');
      if (wasHost) concedeHost(room, me.id);
      if (room.phase === 'playing') checkWinner(room);
      if (!room.players.length) return { ok: true, data: { closed: true }, broadcast: false };
      room.updatedAt = nowTs();
      return { ok: true, data: {} };
    }

    return { ok: false, error: '未知接口: ' + pathname };
  }

  /* ------------------------------------------------------------------ */
  /* 会话单例                                                            */
  /* ------------------------------------------------------------------ */

  var E = {
    role: null,          // 'host' | 'client'
    roomId: null,
    peer: null,
    conn: null,          // 客户端：到房主的连接
    conns: {},           // 房主：peers -> {conn, playerId, lastSeen}
    room: null,          // 房主：权威房间
    session: null,       // { roomId, playerId, token, name }
    onState: null,
    onEvent: null,
    snapshot: null,      // 房主离开时收到的公开房间快照（用于接管）
    lastState: null,     // 最近一次收到的房间状态（房主静默掉线时用于重建房间）
    successorId: null,

    _rid: 0,
    _pending: {},
    _hbTimer: null,
    _tickTimer: null,
    _lastHostMsg: 0,
    _reconnecting: false,
    _takingOver: false,
    _connWait: false,
    _destroyed: false
  };

  function emitEvent(type, detail) {
    if (typeof E.onEvent === 'function') {
      try { E.onEvent(type, detail || {}); } catch (e) { console.warn(e); }
    }
  }

  function pushState(state) {
    if (typeof E.onState === 'function' && state) {
      try { E.onState(state); } catch (e) { console.warn(e); }
    }
  }

  function peerReady() {
    return typeof global.Peer === 'function';
  }

  /* ------------------------------------------------------------------ */
  /* 房主侧                                                              */
  /* ------------------------------------------------------------------ */

  function hostBroadcast() {
    if (E.role !== 'host' || !E.room) return;
    Object.keys(E.conns).forEach(function (pid) {
      var entry = E.conns[pid];
      if (!entry || !entry.playerId) return;
      send(entry.conn, { t: 'state', state: buildState(E.room, entry.playerId) });
    });
    pushState(buildState(E.room, E.room.hostId));
  }

  function send(conn, obj) {
    try {
      if (conn && conn.open) conn.send(obj);
    } catch (e) { /* 连接已断，忽略 */ }
  }

  function bindHostPeer(peer) {
    peer.on('connection', function (conn) {
      conn.on('open', function () {
        if (!E.conns[conn.peer]) E.conns[conn.peer] = { conn: conn, playerId: null, lastSeen: nowTs() };
      });
      if (!E.conns[conn.peer]) E.conns[conn.peer] = { conn: conn, playerId: null, lastSeen: nowTs() };
      conn.on('data', function (data) { hostOnData(conn, data); });
      conn.on('close', function () { hostOnClose(conn, true); });
      conn.on('error', function () { hostOnClose(conn, true); });
    });
    peer.on('disconnected', function () {
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', function (err) {
      console.warn('[host peer error]', err && err.type);
      if (err && err.type === 'unavailable-id') {
        // 房间 ID 被占用（例如他人已接管）：本机降级为客户端
        emitEvent('host-conflict');
      }
    });
  }

  function hostOnData(conn, data) {
    if (!data || typeof data !== 'object') return;
    var entry = E.conns[conn.peer];
    if (!entry) {
      entry = E.conns[conn.peer] = { conn: conn, playerId: null, lastSeen: nowTs() };
    }
    entry.lastSeen = nowTs();

    if (data.t === 'ping') {
      // ping 即刷新该成员在线状态（P1：此前只有 join/req 才刷新，导致正常联机被判离线）
      if (markEntryPlayerOnline(entry)) hostBroadcast();
      send(conn, { t: 'pong' });
      return;
    }
    if (data.t === 'join') { hostOnJoin(conn, entry, data); return; }
    if (data.t === 'req') { hostOnReq(conn, entry, data); return; }
    if (data.t === 'bye') { hostOnClose(conn, !!data.away); return; }
  }

  function hostOnJoin(conn, entry, data) {
    var room = E.room;
    if (!room) { send(conn, { t: 'joinfail', error: '房间已解散' }); return; }

    maintain(room);

    // 身份识别：playerId (+token/name) 命中即视为重连
    var p = null;
    if (data.playerId) {
      var cand = findPlayer(room, data.playerId);
      if (cand && (cand.token === data.token || cand.name === data.name)) p = cand;
    }

    if (p) {
      p.connected = true;
      p.lastSeen = nowTs();
      entry.playerId = p.id;
      pushLog(room, p.name + ' 重新连接');
    } else {
      if (room.phase !== 'lobby') {
        send(conn, { t: 'joinfail', error: '游戏已开始，本局无法中途加入，请等待下一局' });
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        send(conn, { t: 'joinfail', error: '房间已满（上限 ' + MAX_PLAYERS + ' 人）' });
        return;
      }
      var name = sanitizeName(data.name, '玩家' + (room.players.length + 1));
      var same = room.players.filter(function (x) { return x.name === name; })[0];
      if (same) {
        // 房主交接/重启后 token 表可能缺失：同名且离线者按「重连」处理，而非新玩家
        if (same.connected) { send(conn, { t: 'joinfail', error: '昵称已被占用，请换一个' }); return; }
        p = same;
        p.connected = true;
        p.lastSeen = nowTs();
        entry.playerId = p.id;
        pushLog(room, p.name + ' 重新连接');
      } else {
        p = addPlayer(room, name);
        entry.playerId = p.id;
      }
    }

    send(conn, {
      t: 'joined',
      roomId: room.id,
      playerId: p.id,
      token: p.token,
      name: p.name,
      state: buildState(room, p.id)
    });
    hostBroadcast();
  }

  function hostOnReq(conn, entry, data) {
    var room = E.room;
    if (!room) { send(conn, { t: 'res', rid: data.rid, ok: false, error: '房间已解散' }); return; }
    var me = entry.playerId ? findPlayer(room, entry.playerId) : null;
    if (!me) {
      send(conn, { t: 'res', rid: data.rid, ok: false, error: '身份校验失败，请刷新页面重新加入' });
      return;
    }
    me.connected = true;
    me.lastSeen = nowTs();

    var r;
    try {
      r = handleCommand(room, me, data.path, data.body || {});
    } catch (e) {
      r = { ok: false, error: '处理失败：' + e.message };
    }
    send(conn, { t: 'res', rid: data.rid, ok: r.ok, error: r.error || null, data: r.data || null });
    if (r.broadcast !== false) hostBroadcast();

    if (data.path === '/api/leave') {
      try { conn.close(); } catch (e) {}
      delete E.conns[conn.peer];
    }
  }

  function hostOnClose(conn, markOffline) {
    var entry = E.conns[conn.peer];
    if (!entry) return;
    // 陈旧连接保护：同一 peer 已被更新的连接取代时，忽略旧连接的 close/error，
    // 否则会把刚重连成功的玩家误判为掉线（P1：掉线-重连反复横跳）
    if (entry.conn && entry.conn !== conn) return;
    delete E.conns[conn.peer];
    if (!entry.playerId) return;
    var room = E.room;
    if (!room) return;
    var p = findPlayer(room, entry.playerId);
    if (!p) return;
    if (p.id === room.hostId) return;   // 房主自身只由本机进程存亡决定，不由连接事件判定
    // 该玩家可能已通过另一条新连接重连成功（旧连接随后才触发 close）：
    // 只要还有 open 连接指向同一玩家，就保持在线，避免掉线-重连反复横跳（P1）
    var alt = null;
    Object.keys(E.conns).forEach(function (pid) {
      var o = E.conns[pid];
      if (!alt && o && o.playerId === entry.playerId && o.conn && o.conn.open) alt = o;
    });
    if (alt) {
      markEntryPlayerOnline(alt);
      maintain(room);
      hostBroadcast();
      return;
    }
    if (markOffline) {
      p.connected = false;
      p.lastSeen = nowTs() - HEARTBEAT_TIMEOUT - 1;
    }
    maintain(room);
    hostBroadcast();
  }

  /** 房主周期性心跳：维护成员在线状态 + 清理真正失联的连接 */
  function hostTick() {
    if (E.role !== 'host' || !E.room) return;
    var now = nowTs();
    var dirty = false;
    Object.keys(E.conns).forEach(function (pid) {
      var entry = E.conns[pid];
      if (!entry) return;
      var idle = now - entry.lastSeen;
      // 数据通道仍打开 → 视为在线（后台标签定时器被节流、心跳延迟时不误判）
      if (entry.conn && entry.conn.open && idle < HEARTBEAT_HARD_TIMEOUT) {
        if (markEntryPlayerOnline(entry)) dirty = true;
        return;
      }
      if (idle > HEARTBEAT_TIMEOUT) hostOnClose(entry.conn, true);
    });
    if (maintain(E.room)) dirty = true;
    if (dirty) hostBroadcast();
  }

  /** 房主主动退出：把公开房间快照交给最早加入的在线玩家，请其接管 */
  function hostHandOver() {
    if (E.role !== 'host' || !E.room) return;
    var room = E.room;
    var cand = room.players
      .filter(function (p) { return p.id !== room.hostId && p.connected; })
      .sort(function (a, b) { return a.joinedAt - b.joinedAt; })[0] || null;
    var snapshot = publicSnapshot(room);
    var payload = { t: 'host-bye', successorId: cand ? cand.id : null, room: snapshot };
    Object.keys(E.conns).forEach(function (pid) {
      var entry = E.conns[pid];
      if (entry && entry.playerId) send(entry.conn, payload);
    });
  }

  /** 公开房间快照：不含任何人的词与 token */
  function publicSnapshot(room) {
    return {
      id: room.id,
      phase: room.phase,
      round: room.round,
      hostId: room.hostId,
      winnerId: room.winnerId,
      config: JSON.parse(JSON.stringify(room.config)),
      log: room.log.slice(-20),
      players: room.players.map(function (p) {
        return { id: p.id, name: p.name, joinedAt: p.joinedAt, alive: p.alive, selfRevealed: false };
      })
    };
  }

  /* ------------------------------------------------------------------ */
  /* 客户端侧                                                            */
  /* ------------------------------------------------------------------ */

  function clientConnect(roomId, session, allowTakeover) {
    if (!peerReady()) {
      emitEvent('peer-missing');
      return;
    }
    if (!E.peer || E.peer.destroyed) {
      E.peer = new global.Peer(null, { debug: 1 });
      E.peer.on('disconnected', function () { try { E.peer.reconnect(); } catch (e) {} });
      E.peer.on('error', function (err) { console.warn('[client peer error]', err && err.type); });
    }
    // 信令通道（PeerJS socket）必须先 open，否则 offer 没有出口，DataConnection
    // 会永久停在 have-local-offer（表现为「加入超时」）。
    if (!E.peer.open) {
      if (E._connWait) return;            // 已有等待中的连接流程，避免重复发起
      E._connWait = true;
      var waited = 0;
      var finishWait = function () { clearInterval(waitTimer); E._connWait = false; };
      var waitTimer = setInterval(function () {
        if (E._destroyed || E.role !== 'client') { finishWait(); return; }
        if (E.conn && E.conn.open) { finishWait(); return; }
        if (E.peer && !E.peer.destroyed && E.peer.open) {
          finishWait();
          openClientConn(roomId, session, allowTakeover);
          return;
        }
        waited += 200;
        if (waited >= 15000) {          // 信令始终未就绪：丢弃 peer，交由上层重试
          finishWait();
          try { if (E.peer && !E.peer.destroyed) E.peer.destroy(); } catch (e) {}
          E.peer = null;
        }
      }, 200);
      return;
    }
    openClientConn(roomId, session, allowTakeover);
  }

  /** 信令就绪后，真正建立到房主的数据通道 */
  function openClientConn(roomId, session, allowTakeover) {
    if (!E.peer || E.peer.destroyed || !E.peer.open) return;
    if (E.peer.disconnected) { try { E.peer.reconnect(); } catch (e) {} }
    var hostPeerId = HOST_PREFIX + roomId;
    var conn;
    try {
      conn = E.peer.connect(hostPeerId, { reliable: true });
    } catch (e) {
      scheduleReconnect(roomId, session);
      return;
    }
    E.conn = conn;
    E.role = 'client';
    E.roomId = roomId;
    E._lastHostMsg = nowTs();

    conn.on('open', function () {
      E._reconnecting = false;
      conn.send({
        t: 'join',
        name: session.name,
        playerId: session.playerId || null,
        token: session.token || null
      });
      startClientHeartbeat(roomId, session, allowTakeover);
      bindClientLifecycle();
    });
    conn.on('data', function (data) { clientOnData(data, roomId, session, allowTakeover); });
    conn.on('close', function () { onConnLost(roomId, session, allowTakeover); });
    conn.on('error', function () { onConnLost(roomId, session, allowTakeover); });
  }

  /**
   * 客户端页面被关闭 / 刷新 / 离开时，尽量主动告知房主「我走了」。
   * 这样房主能立刻把该成员标记为离线（不等 90s 兜底超时），
   * 同时保留其位置，以便刷新后按同一身份重连。
   */
  function bindClientLifecycle() {
    if (E._lifecycleBound || !global.addEventListener) return;
    E._lifecycleBound = true;
    global.addEventListener('pagehide', function () {
      if (E.role !== 'client') return;
      if (E.conn && E.conn.open) {
        try { send(E.conn, { t: 'bye', away: true }); } catch (e) { /* 页面正在卸载，忽略 */ }
      }
    });
  }

  function clientOnData(data, roomId, session, allowTakeover) {
    if (!data || typeof data !== 'object') return;
    E._lastHostMsg = nowTs();

    if (data.t === 'state') { E.lastState = data.state; pushState(data.state); return; }

    if (data.t === 'pong') return;

    if (data.t === 'joined') {
      E.session = { roomId: data.roomId, playerId: data.playerId, token: data.token, name: data.name };
      E.roomId = data.roomId;
      E._lastHostMsg = nowTs();
      emitEvent('joined', E.session);
      if (data.state) pushState(data.state);
      return;
    }

    if (data.t === 'joinfail') { emitEvent('joinfail', { error: data.error }); return; }

    if (data.t === 'host-bye') {
      E.snapshot = data.room;
      E.successorId = data.successorId;
      emitEvent('host-bye', { successorId: data.successorId });
      var mine = E.session && data.successorId === E.session.playerId;
      setTimeout(function () {
        if (E._destroyed || !allowTakeover || E.role !== 'client') return;
        // 房主已主动离开：先断开本地残留连接，否则 tryTakeover 会误判「房主还活着」而放弃接管
        if (E.conn) { try { E.conn.close(); } catch (e) {} E.conn = null; }
        tryTakeover(E.roomId || roomId, E.session || session);
      }, mine ? 1200 : 6000);
      return;
    }

    if (data.t === 'res') {
      var pend = E._pending[data.rid];
      if (pend) {
        delete E._pending[data.rid];
        clearTimeout(pend.timer);
        pend.resolve({ ok: !!data.ok, error: data.error || null, state: data.data && data.data.state, word: data.data && data.data.word, seconds: data.data && data.data.seconds, phase: data.data && data.data.phase, closed: data.data && data.data.closed });
      }
      return;
    }
  }

  function onConnLost(roomId, session, allowTakeover) {
    if (E._destroyed) return;
    E.conn = null;
    stopClientHeartbeat();
    if (E.role !== 'client') return;
    // 若房主已在交接，等交接逻辑；否则先尝试重连（可能房主只是网络抖动）
    var sess = E.session || session;
    scheduleReconnect(E.roomId || roomId, sess);
    if (allowTakeover) {
      setTimeout(function () {
        if (!E._destroyed && E.role === 'client' && !E.conn) tryTakeover(E.roomId || roomId, E.session || sess);
      }, HOST_LOST_TIMEOUT);
    }
  }

  function scheduleReconnect(roomId, session) {
    if (E._reconnecting || E._destroyed) return;
    E._reconnecting = true;
    var tries = 0;
    var timer = setInterval(function () {
      if (E._destroyed || E.role !== 'client') { clearInterval(timer); E._reconnecting = false; return; }
      if (E.conn && E.conn.open) { clearInterval(timer); E._reconnecting = false; return; }
      tries += 1;
      if (tries > 40) { clearInterval(timer); E._reconnecting = false; emitEvent('room-closed'); return; }
      if (!E.peer || E.peer.destroyed) {
        E.peer = new global.Peer(null, { debug: 1 });
      }
      if (E.peer.disconnected) { try { E.peer.reconnect(); } catch (e) {} }
      clientConnect(roomId, session, true);
    }, 2500);
  }

  /** 立即补发一次心跳（标签页重新可见时使用，尽快恢复房主侧的在线判定） */
  function pingHostNow() {
    if (E.role !== 'client') return;
    if (E.conn && E.conn.open) send(E.conn, { t: 'ping' });
  }

  function startClientHeartbeat(roomId, session, allowTakeover) {
    stopClientHeartbeat();
    if (global.document && !E._hbVisBound) {
      E._hbVisBound = true;
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) pingHostNow();   // 后台被节流后回到前台，立即续上心跳
      });
    }
    E._hbTimer = setInterval(function () {
      if (E.role !== 'client') return;
      pingHostNow();
      // 心跳超时：长时间收不到房主任何消息（ping 无 pong / 无 state）→ 判定房主已掉线
      if (!E._lastHostMsg || E._takingOver) return;
      if (nowTs() - E._lastHostMsg <= HOST_LOST_TIMEOUT) return;
      var rid = E.roomId || roomId;
      var sess = E.session || session;
      if (!rid || !sess) return;
      stopClientHeartbeat();
      // 断开残留（可能仍显示 open）的连接，避免 tryTakeover 误判房主在线
      if (E.conn) { try { E.conn.close(); } catch (e) {} E.conn = null; }
      // 尽量用最近一次房间状态重建，保留其他玩家身份
      if (!(E.snapshot && E.snapshot.players && E.snapshot.players.length)) {
        E.snapshot = E.lastState || E.snapshot;
      }
      emitEvent('host-lost');
      if (allowTakeover) tryTakeover(rid, sess);
      else scheduleReconnect(rid, sess);
    }, 5000);
  }

  function stopClientHeartbeat() {
    if (E._hbTimer) { clearInterval(E._hbTimer); E._hbTimer = null; }
  }

  /* ------------------------------------------------------------------ */
  /* 房主掉线接管（P2P 版「房主移交」）                                  */
  /* ------------------------------------------------------------------ */

  function tryTakeover(roomId, session) {
    if (E._takingOver || E._destroyed) return;
    if (E.conn && E.conn.open) return;   // 房主还活着，不抢
    session = E.session || session;
    roomId = E.roomId || roomId;
    if (!session || !session.playerId) return;  // 身份未就绪时不以空身份重建房间
    E._takingOver = true;
    emitEvent('takeover-try');
    var peer;
    try {
      peer = new global.Peer(HOST_PREFIX + roomId, { debug: 1 });
    } catch (e) {
      E._takingOver = false;
      return;
    }
    var done = false;
    peer.on('open', function () {
      done = true;
      E._takingOver = false;
      // 成为新房主
      stopClientHeartbeat();
      if (E.conn) { try { E.conn.close(); } catch (e) {} E.conn = null; }
      E.role = 'host';
      E.roomId = roomId;
      E.peer = peer;
      E.conns = {};
      E.room = adoptRoom(roomId, session);
      bindHostPeer(peer);
      startHostTick();
      hostBroadcast();
      emitEvent('became-host');
    });
    peer.on('error', function (err) {
      if (done) return;
      var type = err && err.type;
      if (type === 'unavailable-id' || type === 'invalid-id') {
        // 已被别人接管：本机回到客户端重连
        try { peer.destroy(); } catch (e) {}
        E._takingOver = false;
        E.role = 'client';
        E.peer = null;
        scheduleReconnect(roomId, session);
        emitEvent('takeover-lost');
        return;
      }
      try { peer.destroy(); } catch (e) {}
      E._takingOver = false;
      if (type !== 'peer-unavailable') scheduleReconnect(roomId, session);
    });
    setTimeout(function () {
      if (!done && !peer.destroyed) {
        try { peer.destroy(); } catch (e) {}
        E._takingOver = false;
      }
    }, 20000);
  }

  /** 以公开快照重建房间（对局中的残局作废回大厅） */
  function adoptRoom(roomId, session) {
    var snap = E.snapshot || {};
    var room = createRoom(roomId);
    room.config = validateConfig(snap.config) || room.config;
    room.round = snap.round || 0;
    room.phase = 'lobby';
    room.winnerId = null;
    room.hostId = session.playerId;
    room.log = (snap.log || []).map(function (x) { return { t: x.t, text: x.text }; });
    room.players = (snap.players || []).map(function (p) {
      return {
        id: p.id,
        token: p.id === session.playerId ? session.token : uid(),
        name: p.name,
        joinedAt: p.joinedAt || nowTs(),
        lastSeen: nowTs(),
        connected: p.id === session.playerId,
        alive: true,
        selfRevealed: false,
        word: null
      };
    });
    if (!findPlayer(room, session.playerId)) {
      room.players.push({
        id: session.playerId, token: session.token, name: session.name,
        joinedAt: nowTs(), lastSeen: nowTs(), connected: true, alive: true, selfRevealed: false, word: null
      });
    }
    pushLog(room, '房主掉线，' + session.name + ' 接管了房间' + (snap.phase === 'playing' ? '（上一局作废，请重新开始）' : ''));
    return room;
  }

  function startHostTick() {
    stopHostTick();
    E._tickTimer = setInterval(hostTick, 5000);
  }

  function stopHostTick() {
    if (E._tickTimer) { clearInterval(E._tickTimer); E._tickTimer = null; }
  }

  /* ------------------------------------------------------------------ */
  /* 对外 API                                                            */
  /* ------------------------------------------------------------------ */

  function makeRoomId() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  var ENGINE = {
    MIN_PLAYERS: MIN_PLAYERS,
    MAX_PLAYERS: MAX_PLAYERS,

    isHost: function () { return E.role === 'host'; },
    getRole: function () { return E.role; },
    getSession: function () { return E.session; },
    getRoomId: function () { return E.roomId; },

    /** 创建房间（本机成为房主） */
    createHost: function (name) {
      return new Promise(function (resolve) {
        if (!peerReady()) { resolve({ ok: false, error: 'PeerJS 尚未加载完成，请稍候或检查网络' }); return; }
        var attempt = 0;

        function tryCreate() {
          attempt += 1;
          var roomId = makeRoomId();
          var peer;
          try {
            peer = new global.Peer(HOST_PREFIX + roomId, { debug: 1 });
          } catch (e) {
            resolve({ ok: false, error: '无法创建房间：' + e.message });
            return;
          }
          var settled = false;
          peer.on('open', function () {
            if (settled) return;
            settled = true;
            E.role = 'host';
            E.peer = peer;
            E.roomId = roomId;
            E.conns = {};
            E.room = createRoom(roomId);
            var p = addPlayer(E.room, sanitizeName(name, '房主'));
            E.session = { roomId: roomId, playerId: p.id, token: p.token, name: p.name };
            E.snapshot = null;
            bindHostPeer(peer);
            startHostTick();
            resolve({
              ok: true, roomId: roomId, playerId: p.id, token: p.token, name: p.name,
              state: buildState(E.room, p.id)
            });
          });
          peer.on('error', function (err) {
            if (settled) return;
            var type = err && err.type;
            if (type === 'unavailable-id' && attempt < 5) {
              try { peer.destroy(); } catch (e) {}
              setTimeout(tryCreate, 300);
              return;
            }
            settled = true;
            try { peer.destroy(); } catch (e) {}
            resolve({ ok: false, error: '创建房间失败：' + (type || '网络错误') });
          });
        }

        tryCreate();
      });
    },

    /** 加入房间（本机作为客户端连接房主） */
    joinRoom: function (roomId, name, saved) {
      return new Promise(function (resolve) {
        if (!peerReady()) { resolve({ ok: false, error: 'PeerJS 尚未加载完成，请稍候或检查网络' }); return; }
        var session = {
          roomId: roomId,
          playerId: saved && saved.playerId ? saved.playerId : null,
          token: saved && saved.token ? saved.token : null,
          name: sanitizeName(name || (saved && saved.name), '玩家')
        };
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; resolve({ ok: false, error: '加入超时：请确认房号是否正确、房主是否在线' }); }
        }, 15000);

        var prevJoined = ENGINE._onJoined;
        ENGINE._onJoined = function (sess) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: true, roomId: sess.roomId, playerId: sess.playerId, token: sess.token, name: sess.name, state: null });
        };
        var prevFail = ENGINE._onJoinFail;
        ENGINE._onJoinFail = function (msg) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, error: msg });
        };

        if (E.role === 'host') {   // 已是房主时不允许再加入
          done = true; clearTimeout(timer);
          resolve({ ok: false, error: '本机已是房主' });
          return;
        }
        E.role = 'client';
        E.roomId = roomId;
        clientConnect(roomId, session, true);
      });
    },

    /** 断线重连（用本地保存的身份回到房间） */
    reconnect: function (saved) {
      return new Promise(function (resolve) {
        if (!saved || !saved.roomId) { resolve({ ok: false, error: '无本地会话' }); return; }
        ENGINE.joinRoom(saved.roomId, saved.name, saved).then(resolve);
      });
    },

    /** 等价于原 REST 调用：自动按角色本地处理或转发给房主 */
    api: function (pathname, body) {
      return new Promise(function (resolve) {
        body = body || {};
        if (E.role === 'host') {
          var me = E.room && E.session ? findPlayer(E.room, E.session.playerId) : null;
          if (!me) { resolve({ ok: false, error: '身份失效' }); return; }
          var r;
          try {
            r = handleCommand(E.room, me, pathname, body);
          } catch (e) {
            resolve({ ok: false, error: '处理失败：' + e.message });
            return;
          }
          if (pathname === '/api/leave') {
            hostHandOver();
            if (r.broadcast !== false) hostBroadcast();
            teardown(true);
            resolve({ ok: true });
            return;
          }
          if (r.broadcast !== false) hostBroadcast();
          resolve({ ok: r.ok, error: r.error || null, state: r.data && r.data.state, word: r.data && r.data.word, seconds: r.data && r.data.seconds, phase: r.data && r.data.phase });
          return;
        }

        if (E.role === 'client' && pathname === '/api/leave') {
          send(E.conn, { t: 'req', rid: nextRid(), path: pathname, body: body });
          resolve({ ok: true });
          return;
        }

        if (E.role !== 'client' || !E.conn || !E.conn.open) {
          resolve({ ok: false, error: '与房主的连接已断开，正在重连…' });
          return;
        }

        var rid = nextRid();
        var timer = setTimeout(function () {
          if (E._pending[rid]) { delete E._pending[rid]; resolve({ ok: false, error: '请求超时，请重试' }); }
        }, CALL_TIMEOUT);
        E._pending[rid] = {
          resolve: resolve,
          timer: timer
        };
        send(E.conn, { t: 'req', rid: rid, path: pathname, body: body });
      });
    },

    /** 离开房间并释放连接 */
    leave: function () {
      var p;
      if (E.role === 'host') p = ENGINE.api('/api/leave', {});
      else {
        if (E.conn && E.conn.open) send(E.conn, { t: 'bye' });
        p = Promise.resolve({ ok: true });
      }
      return Promise.resolve(p).then(function (r) {
        teardown(true);
        return r;
      });
    },

    onState: function (fn) { E.onState = fn; },
    onEvent: function (fn) { E.onEvent = fn; },
    _onJoined: null,
    _onJoinFail: null
  };

  function nextRid() {
    E._rid += 1;
    return E._rid;
  }

  function teardown(releasePeer) {
    E._destroyed = true;
    stopClientHeartbeat();
    stopHostTick();
    Object.keys(E._pending).forEach(function (k) {
      clearTimeout(E._pending[k].timer);
      E._pending[k].resolve({ ok: false, error: '连接已关闭' });
      delete E._pending[k];
    });
    if (releasePeer) {
      try { if (E.conn) E.conn.close(); } catch (e) {}
      try { if (E.peer && !E.peer.destroyed) E.peer.destroy(); } catch (e) {}
    }
    E.role = null;
    E.conn = null;
    E.peer = null;
    E.conns = {};
    E.room = null;
    E.session = null;
    E.roomId = null;
    setTimeout(function () { E._destroyed = false; }, 300);
  }

  // 事件分发：joined / joinfail 挂到单例上，供 joinRoom 的 Promise 使用
  function dispatchEvent(type, detail) {
    if (type === 'joined' && typeof ENGINE._onJoined === 'function') ENGINE._onJoined(detail);
    if (type === 'joinfail' && typeof ENGINE._onJoinFail === 'function') ENGINE._onJoinFail(detail && detail.error);
    emitEvent(type, detail);
  }

  var rawEmit = emitEvent;
  emitEvent = function (type, detail) {   // 覆盖为统一分发
    if (typeof ENGINE !== 'undefined') {
      if (type === 'joined' && typeof ENGINE._onJoined === 'function') ENGINE._onJoined(detail);
      if (type === 'joinfail' && typeof ENGINE._onJoinFail === 'function') ENGINE._onJoinFail(detail && detail.error);
    }
    rawEmit(type, detail);
  };

  ENGINE._internal = {
    buildState: buildState,
    E: E
  };

  global.XKNK_ENGINE = ENGINE;

})(typeof window !== 'undefined' ? window : this);
