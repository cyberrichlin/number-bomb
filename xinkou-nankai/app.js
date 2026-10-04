'use strict';
/**
 * 「心口难开」前端逻辑（纯静态 P2P 版，原生 JS，无框架）
 * ------------------------------------------------------------------
 * 与 Node 服务端版的差异：网络层由 HTTP + SSE 换成 PeerJS DataChannel
 * （房主为星型中枢，逻辑见 engine.js）；渲染与交互逻辑保持一致。
 */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const app = $('#app');
  const toastEl = $('#toast');
  const ENG = window.XKNK_ENGINE;

  const LS_KEY = 'xknk_session_v1';

  const CATEGORY_CN = { action: '动作类', word: '词汇类' };
  const LEN_CN = { 1: '1字', 2: '2字', 3: '3字', 4: '4字' };
  const TYPE_CN = { funny: '搞笑型', flirty: '暧昧型', daily: '日常型' };

  const S = {
    session: null,   // { roomId, playerId, token, name }
    snap: null,
    reveal: {},      // targetId -> { word, until }（临时查看）
    draft: null,     // 未提交的配置
    conn: 'idle'     // idle | online | reconnecting
  };

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  /**
   * 会话持久化：sessionStorage 优先（按标签页隔离，同源多标签互不覆盖），
   * localStorage 仅作兜底（旧数据迁移 / sessionStorage 不可用时）。
   */
  function saveSession() {
    const payload = S.session ? JSON.stringify(S.session) : '';
    try {
      if (payload) sessionStorage.setItem(LS_KEY, payload);
      else sessionStorage.removeItem(LS_KEY);
    } catch (e) { /* sessionStorage 不可用：走下方 localStorage 兜底 */ }
    try {
      // 不再把会话写入 localStorage：同源多标签共享会互相覆盖（P3 根因），顺手清理历史残留
      if (localStorage.getItem(LS_KEY)) localStorage.removeItem(LS_KEY);
    } catch (e) { /* 隐私模式下忽略 */ }
    if (!payload) return;
    let stored = false;
    try { stored = sessionStorage.getItem(LS_KEY) === payload; } catch (e) { stored = false; }
    if (!stored) {
      try { localStorage.setItem(LS_KEY, payload); } catch (e) { /* 隐私模式下忽略 */ }
    }
  }

  function loadSession() {
    let raw = null;
    try { raw = sessionStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (!raw) {
      // 兼容旧版本写在 localStorage 的会话：一次性迁移到本标签页并清理，避免多标签串号
      try {
        raw = localStorage.getItem(LS_KEY);
        if (raw) {
          try { sessionStorage.setItem(LS_KEY, raw); } catch (e) { /* ignore */ }
          localStorage.removeItem(LS_KEY);
        }
      } catch (e) { raw = null; }
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function setUrlRoom(roomId) {
    try {
      if (history.replaceState) history.replaceState(null, '', location.pathname + '?room=' + roomId);
    } catch (e) { /* 忽略 */ }
  }

  /** 统一指令入口：房主本地处理，客户端转发给房主（见 engine.js） */
  async function api(pathname, body) {
    if (!ENG) return { ok: false, error: '引擎未加载，请刷新页面' };
    return ENG.api(pathname, body);
  }

  function applyState(state) {
    if (!state) return;
    const prevPhase = S.snap && S.snap.phase;
    S.snap = state;
    if (prevPhase !== state.phase) {
      S.reveal = {};
      S.draft = null;
    }
    if (state.canControlConfig && !S.draft) {
      S.draft = Object.assign({}, state.config);
    }
    if (!state.canControlConfig) S.draft = null;
    render();
  }

  function leaveLocal() {
    S.session = null;
    S.snap = null;
    S.reveal = {};
    S.draft = null;
    S.conn = 'idle';
    saveSession();
    render();
  }

  /* ------------------------------------------------------------------ */
  /* 引擎事件                                                            */
  /* ------------------------------------------------------------------ */

  function setupEngine() {
    if (!ENG) {
      toast('引擎脚本加载失败，请刷新页面');
      return;
    }
    ENG.onState((state) => applyState(state));
    ENG.onEvent((type, detail) => {
      if (type === 'joined') {
        S.conn = 'online';
        if (ENG.getSession()) {
          S.session = Object.assign({}, ENG.getSession());
          saveSession();
        }
        render();
        return;
      }
      if (type === 'joinfail') { toast((detail && detail.error) || '加入房间失败'); return; }
      if (type === 'host-bye') {
        S.conn = 'reconnecting';
        toast('房主已离开，正在把房主身份移交出去…');
        render();
        return;
      }
      if (type === 'takeover-try') { S.conn = 'reconnecting'; render(); return; }
      if (type === 'became-host') {
        S.conn = 'online';
        toast('你已接管房间，成为新房主');
        render();
        return;
      }
      if (type === 'takeover-lost') {
        S.conn = 'reconnecting';
        toast('其他玩家已接管房间，正在重新连接…');
        render();
        return;
      }
      if (type === 'room-closed') {
        toast('与房主的连接已断开，房间可能已解散');
        leaveLocal();
        return;
      }
      if (type === 'peer-missing') {
        toast('PeerJS 加载失败，请检查网络后刷新页面');
        return;
      }
      if (type === 'host-conflict') {
        toast('房间号被占用，正在切换身份…');
        return;
      }
    });
  }

  // 临时查看计时清理
  setInterval(() => {
    if (!S.session) return;
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(S.reveal)) {
      if (S.reveal[k] && S.reveal[k].until <= now) { delete S.reveal[k]; changed = true; }
    }
    if (changed) render();
  }, 500);

  /* ------------------------------------------------------------------ */
  /* 视图：首页                                                          */
  /* ------------------------------------------------------------------ */

  function viewHome() {
    const wrap = el('div');

    const hero = el('div', 'hero');
    hero.appendChild(el('div', 'logo', '心口难开'));
    hero.appendChild(el('div', 'tag', '头环猜词 · 2-10 人 · 手机电脑都能玩 · 无需服务器'));
    wrap.appendChild(hero);

    const card = el('div', 'card mt');

    const nameLabel = el('label', 'small muted', '你的昵称');
    const nameInput = el('input');
    nameInput.id = 'in-name';
    nameInput.maxLength = 12;
    nameInput.placeholder = '例如：小明';
    nameInput.value = (S.session && S.session.name) || '';
    nameInput.style.marginTop = '6px';

    const btnCreate = el('button', 'primary wide mt', '创建房间');
    btnCreate.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) return toast('请先输入昵称');
      btnCreate.disabled = true;
      btnCreate.textContent = '正在创建…';
      try {
        const r = await ENG.createHost(name);
        if (!r.ok) { toast(r.error || '创建失败'); return; }
        S.session = { roomId: r.roomId, playerId: r.playerId, token: r.token, name: r.name };
        saveSession();
        setUrlRoom(r.roomId);
        applyState(r.state);
        toast(`房间创建成功：${r.roomId}`);
      } catch (e) {
        toast('创建失败，请重试');
      } finally {
        btnCreate.disabled = false;
        btnCreate.textContent = '创建房间';
      }
    };

    card.appendChild(nameLabel);
    card.appendChild(nameInput);
    card.appendChild(btnCreate);
    card.appendChild(el('div', 'divider', '或者加入别人的房间'));

    const roomInput = el('input');
    roomInput.id = 'in-room';
    roomInput.inputMode = 'numeric';
    roomInput.maxLength = 6;
    roomInput.placeholder = '输入 6 位房号';
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (urlRoom) roomInput.value = urlRoom;

    const btnJoin = el('button', 'wide mt', '加入房间');
    const doJoin = async () => {
      const roomId = roomInput.value.trim();
      const name = nameInput.value.trim();
      if (!/^\d{6}$/.test(roomId)) return toast('房号应为 6 位数字');
      if (!name) return toast('请先输入昵称');
      btnJoin.disabled = true;
      btnJoin.textContent = '正在连接…';
      try {
        const r = await ENG.joinRoom(roomId, name, null);
        if (!r.ok) { toast(r.error || '加入失败'); return; }
        S.session = { roomId: r.roomId, playerId: r.playerId, token: r.token, name: r.name };
        saveSession();
        setUrlRoom(r.roomId);
        toast('已加入房间');
      } catch (e) {
        toast('加入失败，请重试');
      } finally {
        btnJoin.disabled = false;
        btnJoin.textContent = '加入房间';
      }
    };
    btnJoin.onclick = doJoin;
    roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

    card.appendChild(roomInput);
    card.appendChild(btnJoin);

    const tips = el('div', 'hint');
    tips.innerHTML = '玩法：每人头上有一个词牌，只有别人看得见。用聊天引导对方说出或做出他的词，谁中招谁淘汰，最后剩下的人获胜。';
    card.appendChild(tips);

    wrap.appendChild(card);
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* 配置面板                                                            */
  /* ------------------------------------------------------------------ */

  let configTimer = null;
  /** 房主/获胜者切换选项时，实时把配置同步给房间内其他玩家（防抖） */
  function syncConfig() {
    if (!S.session || !S.snap || !S.snap.canControlConfig) return;
    clearTimeout(configTimer);
    configTimer = setTimeout(async () => {
      try {
        const r = await api('/api/config', {
          roomId: S.session.roomId, playerId: S.session.playerId, token: S.session.token, config: S.draft
        });
        if (!r.ok && r.error) toast(r.error);
      } catch (e) { /* 网络抖动忽略：开始/重开时仍会以最终配置提交 */ }
    }, 300);
  }

  function configPanel() {
    const cur = S.draft || (S.snap && S.snap.config) || { category: 'action', wordLength: 2, type: 'daily' };
    S.draft = Object.assign({}, cur);

    const box = el('div', 'config');

    const segs = [
      { key: 'category', label: '① 选择类别', opts: [['action', '动作类'], ['word', '词汇类']] },
      { key: 'wordLength', label: '② 选择字数', opts: [[1, '1 字'], [2, '2 字'], [3, '3 字'], [4, '4 字']] },
      { key: 'type', label: '③ 选择类型', opts: [['funny', '搞笑型'], ['flirty', '暧昧型'], ['daily', '日常型']] }
    ];

    segs.forEach((seg) => {
      box.appendChild(el('h4', null, seg.label));
      const row = el('div', 'seg');
      seg.opts.forEach(([val, text]) => {
        const b = el('button', String(S.draft[seg.key]) === String(val) ? 'on' : '', text);
        b.onclick = () => {
          S.draft[seg.key] = val;
          S.snap.config = Object.assign({}, S.draft);
          syncConfig();
          render();
        };
        row.appendChild(b);
      });
      box.appendChild(row);
    });

    const tipText = S.snap.phase === 'result' ? '你是本局获胜者，重新选择玩法后开始下一局' : '只有房主可以设置玩法';
    box.appendChild(el('div', 'hint', tipText));
    const preview = el('div', 'small muted');
    preview.textContent = `当前配置：${CATEGORY_CN[S.draft.category]} · ${LEN_CN[S.draft.wordLength]} · ${TYPE_CN[S.draft.type]}`;
    box.appendChild(preview);

    return box;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：大厅                                                          */
  /* ------------------------------------------------------------------ */

  function copyText(text, okMsg) {
    const done = () => toast(okMsg);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      toast('复制失败，请手动复制：' + text);
    }
  }

  function shareLink(roomId) {
    return `${location.origin}${location.pathname}?room=${roomId}`;
  }

  function connBar() {
    if (S.conn !== 'reconnecting') return null;
    const bar = el('div', 'conn-bar', '与房主的连接中断，正在自动重连…');
    return bar;
  }

  function viewLobby() {
    const snap = S.snap;
    const wrap = el('div');

    const top = el('div', 'topbar');
    const code = el('div', 'room-code');
    code.innerHTML = '房间号 ';
    const b = el('b', null, snap.roomId);
    code.appendChild(b);
    top.appendChild(code);

    const btns = el('div', 'row');
    const btnLink = el('button', 'sm', '复制邀请链接');
    btnLink.onclick = () => copyText(shareLink(snap.roomId), '邀请链接已复制，发给朋友吧');
    const btnCode = el('button', 'sm', '复制房号');
    btnCode.onclick = () => copyText(snap.roomId, '房号已复制');
    btns.appendChild(btnLink);
    btns.appendChild(btnCode);
    top.appendChild(btns);
    wrap.appendChild(top);

    const cb = connBar();
    if (cb) wrap.appendChild(cb);

    // 玩家列表
    const pl = el('div', 'players');
    snap.players.forEach((p) => {
      const chip = el('div', 'p-chip' + (p.connected ? '' : ' off'));
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(el('span', 'nm', p.name));
      if (p.isHost) chip.appendChild(el('span', 'badge', '房主'));
      pl.appendChild(chip);
    });
    wrap.appendChild(pl);

    const cnt = el('div', 'hint', `当前 ${snap.players.length} / ${snap.maxPlayers} 人，至少需要 ${snap.minPlayers} 人才能开始`);
    wrap.appendChild(cnt);

    if (snap.canControlConfig) {
      const card = el('div', 'card mt');
      card.appendChild(configPanel());
      const btnStart = el('button', 'primary wide mt', '开始游戏');
      btnStart.disabled = snap.players.length < snap.minPlayers;
      btnStart.onclick = async () => {
        btnStart.disabled = true;
        const r = await api('/api/start', Object.assign({ roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token }, { config: S.draft }));
        if (!r.ok) { toast(r.error || '开始失败'); btnStart.disabled = false; return; }
        if (r.state) applyState(r.state);
      };
      card.appendChild(btnStart);
      if (snap.players.length < snap.minPlayers) {
        card.appendChild(el('div', 'hint', `还差 ${snap.minPlayers - snap.players.length} 人，先分享链接邀请朋友吧`));
      }
      wrap.appendChild(card);
    } else {
      const card = el('div', 'card mt center');
      card.appendChild(el('div', null, '等待房主开始游戏…'));
      card.appendChild(el('div', 'hint', `房主当前配置：${CATEGORY_CN[snap.config.category]} · ${LEN_CN[snap.config.wordLength]} · ${TYPE_CN[snap.config.type]}`));
      wrap.appendChild(card);
    }

    wrap.appendChild(leaveButton());
    return wrap;
  }

  function leaveButton() {
    const btn = el('button', 'danger wide mt', '离开房间');
    btn.onclick = async () => {
      if (!confirm('确定要离开房间吗？')) return;
      try {
        await (ENG ? ENG.leave() : Promise.resolve());
      } catch (e) { /* ignore */ }
      leaveLocal();
      toast('已离开房间');
    };
    return btn;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：对局                                                          */
  /* ------------------------------------------------------------------ */

  function viewGame() {
    const snap = S.snap;
    const me = snap.me;
    const wrap = el('div');

    const top = el('div', 'game-top');
    const p1 = el('span', 'pill');
    p1.innerHTML = '第 <b>' + snap.round + '</b> 局';
    const p2 = el('span', 'pill');
    p2.innerHTML = '房间 <b>' + snap.roomId + '</b>';
    const p3 = el('span', 'pill');
    p3.innerHTML = CATEGORY_CN[snap.config.category] + ' · ' + LEN_CN[snap.config.wordLength] + ' · ' + TYPE_CN[snap.config.type];
    const p4 = el('span', 'pill');
    p4.innerHTML = '存活 <b>' + snap.players.filter((p) => p.alive).length + '</b> / ' + snap.players.length;
    top.appendChild(p1); top.appendChild(p2); top.appendChild(p3); top.appendChild(p4);
    wrap.appendChild(top);

    const cb = connBar();
    if (cb) wrap.appendChild(cb);

    // 自己的卡片
    const self = el('div', 'self-card');
    self.appendChild(el('div', 'title', '我的词牌（只有别人能看到）'));
    self.appendChild(el('div', 'name', (me ? me.name : '') + ' · 你'));
    if (me && me.alive) {
      if (me.selfRevealed) {
        const w = el('div', 'masked revealed-word', '已举起词牌 ✅');
        self.appendChild(w);
        self.appendChild(el('div', 'small', '你的词牌正对所有人公开，点击下方按钮放下'));
      } else {
        self.appendChild(el('div', 'masked', '头环保密中'));
        self.appendChild(el('div', 'small muted', '想知道自己是什么词？把手机举给别人看吧'));
      }
      const btn = el('button', me.selfRevealed ? '' : 'pink', me.selfRevealed ? '放下我的词牌' : '举起我的词牌');
      btn.classList.add('wide', 'mt');
      btn.onclick = async () => {
        const r = await api('/api/self-reveal', {
          roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token, show: !me.selfRevealed
        });
        if (!r.ok) return toast(r.error);
        if (r.state) applyState(r.state);
      };
      self.appendChild(btn);
    } else {
      self.appendChild(el('div', 'masked', '已淘汰'));
      self.appendChild(el('div', 'small', '你已被淘汰，等待本局结束'));
    }
    wrap.appendChild(self);

    wrap.appendChild(el('div', 'hint', '点击其他玩家的卡片可临时偷看他的词牌（5 秒后自动遮挡）'));

    // 其他玩家
    const grid = el('div', 'grid-players');
    snap.players.filter((p) => !p.isSelf).forEach((p) => {
      grid.appendChild(playerCard(p));
    });
    wrap.appendChild(grid);

    // 事件日志
    if (snap.log && snap.log.length) {
      const logBox = el('div', 'log');
      snap.log.slice(-6).reverse().forEach((item) => {
        logBox.appendChild(el('div', null, '· ' + item.text));
      });
      wrap.appendChild(logBox);
    }

    wrap.appendChild(leaveButton());
    return wrap;
  }

  function playerCard(p) {
    const snap = S.snap;
    const card = el('div', 'pcard' + (p.alive ? '' : ' out'));

    const head = el('div', 'head');
    const nm = el('div', 'nm', p.name);
    head.appendChild(nm);
    if (!p.connected) head.appendChild(el('span', 'st', '离线'));
    head.appendChild(el('span', 'st', p.alive ? '存活' : '已淘汰'));
    card.appendChild(head);

    const wordBox = el('div', 'word');
    let openWord = null;
    if (p.revealedWord) {
      openWord = p.revealedWord;
      wordBox.classList.add('open');
      card.classList.add('viewing');
    } else if (S.reveal[p.id]) {
      openWord = S.reveal[p.id].word;
      wordBox.classList.add('open');
      card.classList.add('viewing');
    }

    if (openWord) {
      wordBox.textContent = openWord;
    } else if (p.alive && p.hasWord) {
      wordBox.textContent = '●'.repeat(Math.max(1, snap.config.wordLength));
    } else if (!p.alive) {
      wordBox.textContent = '已淘汰';
      wordBox.classList.add('dead');
    } else {
      wordBox.textContent = '—';
    }
    card.appendChild(wordBox);

    if (p.revealedWord) {
      card.appendChild(el('div', 'st', '🙌 正在举牌给大家看'));
    }

    if (snap.phase === 'playing' && p.alive) {
      const acts = el('div', 'acts');
      const btnOut = el('button', 'sm danger', snap.config.category === 'action' ? '已做出' : '已说出');
      btnOut.onclick = async (ev) => {
        ev.stopPropagation();
        const verb = snap.config.category === 'action' ? '做出' : '说出';
        if (!confirm(`确认 ${p.name} 已经${verb}了自己的词牌？TA 将被淘汰。`)) return;
        const r = await api('/api/eliminate', {
          roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token, targetId: p.id
        });
        if (!r.ok) return toast(r.error);
        S.reveal = {};
        if (r.state) applyState(r.state);
      };
      acts.appendChild(btnOut);
      card.appendChild(acts);
    }

    if (snap.phase === 'playing' && !p.alive && snap.hostId === (S.session && S.session.playerId)) {
      const acts = el('div', 'acts');
      const btnRev = el('button', 'sm', '撤销淘汰');
      btnRev.onclick = async (ev) => {
        ev.stopPropagation();
        const r = await api('/api/revive', {
          roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token, targetId: p.id
        });
        if (!r.ok) return toast(r.error);
        if (r.state) applyState(r.state);
      };
      acts.appendChild(btnRev);
      card.appendChild(acts);
    }

    if (snap.phase === 'playing' && p.alive) {
      card.onclick = async () => {
        if (S.reveal[p.id]) { delete S.reveal[p.id]; render(); return; }
        const r = await api('/api/peek', {
          roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token, targetId: p.id
        });
        if (!r.ok) return toast(r.error);
        S.reveal[p.id] = { word: r.word, until: Date.now() + (r.seconds || 5) * 1000 };
        render();
      };
    }

    return card;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：结算                                                          */
  /* ------------------------------------------------------------------ */

  function viewResult() {
    const snap = S.snap;
    const wrap = el('div');
    const winner = snap.players.find((p) => p.id === snap.winnerId);
    const iWin = snap.winnerId && S.session && snap.winnerId === S.session.playerId;

    const hero = el('div', 'result-hero');
    hero.appendChild(el('div', 'crown', '🏆'));
    hero.appendChild(el('div', 'winner', winner ? winner.name + ' 获胜！' : '本局平局'));
    hero.appendChild(el('div', 'muted small', winner ? '撑到了最后，其他人全军覆没' : '同归于尽，无人获胜'));
    wrap.appendChild(hero);

    const card = el('div', 'card');
    card.appendChild(el('h3', null, '本局词牌回放'));
    const list = el('div', 'final-list');
    snap.players.forEach((p) => {
      const item = el('div', 'final-item');
      item.appendChild(el('span', 'muted', p.name + (p.alive ? '（存活）' : '（淘汰）')));
      const b = el('b', null, p.finalWord || '—');
      item.appendChild(b);
      list.appendChild(item);
    });
    card.appendChild(list);
    wrap.appendChild(card);

    if (snap.canControlConfig) {
      const c2 = el('div', 'card mt');
      c2.appendChild(el('h3', null, iWin ? '你赢了，来开下一局！' : '重新开局'));
      c2.appendChild(configPanel());
      const btn = el('button', 'primary wide mt', '再来一局');
      btn.onclick = async () => {
        btn.disabled = true;
        const r = await api('/api/restart', {
          roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token, config: S.draft
        });
        if (!r.ok) { toast(r.error); btn.disabled = false; return; }
        if (r.state) applyState(r.state);
      };
      c2.appendChild(btn);

      const btnLobby = el('button', 'ghost wide mt', '回到大厅（不重开）');
      btnLobby.onclick = async () => {
        const r = await api('/api/back-to-lobby', { roomId: snap.roomId, playerId: S.session.playerId, token: S.session.token });
        if (!r.ok) return toast(r.error);
        if (r.state) applyState(r.state);
      };
      c2.appendChild(btnLobby);
      wrap.appendChild(c2);
    } else {
      const c2 = el('div', 'card mt center');
      c2.appendChild(el('div', null, iWin ? '' : '等待本局获胜者开始下一局…'));
      c2.appendChild(el('div', 'hint', '获胜者拥有下一局的开局权与玩法选择权'));
      wrap.appendChild(c2);
    }

    wrap.appendChild(leaveButton());
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function render() {
    app.innerHTML = '';
    const snap = S.snap;
    if (!S.session || !snap) {
      app.appendChild(viewHome());
      return;
    }
    if (snap.phase === 'lobby') app.appendChild(viewLobby());
    else if (snap.phase === 'playing') app.appendChild(viewGame());
    else app.appendChild(viewResult());
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    setupEngine();
    const saved = loadSession();
    const urlRoom = new URLSearchParams(location.search).get('room');

    if (saved && saved.roomId && (!urlRoom || urlRoom === saved.roomId)) {
      S.session = saved;
      S.conn = 'reconnecting';
      render();
      const r = await ENG.reconnect(saved);
      if (r.ok) {
        S.session = Object.assign({}, ENG.getSession());
        S.conn = 'online';
        saveSession();
        setUrlRoom(r.roomId);
        render();
        return;
      }
      toast(r.error || '未能恢复上次的房间');
      S.session = null;
      S.conn = 'idle';
      saveSession();
    }
    render();
  }

  window.addEventListener('beforeunload', () => {
    try { if (ENG) ENG.leave(); } catch (e) { /* 忽略：离开前尽力通知房主 */ }
  });

  boot();
})();
