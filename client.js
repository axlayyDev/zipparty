'use strict';

(() => {
  // ------------------------------------------------------------ helpers

  const $ = (sel) => document.querySelector(sel);
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // Mirrors the server's table (the server is still the authority).
  const FILE_TYPES = {
    png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'],
    gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], svg: ['image', 'image/svg+xml'],
    bmp: ['image', 'image/bmp'],
    mp3: ['audio', 'audio/mpeg'], ogg: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'],
    wav: ['audio', 'audio/wav'], m4a: ['audio', 'audio/mp4'], flac: ['audio', 'audio/flac'],
    json: ['data', 'application/json'], txt: ['data', 'text/plain'], md: ['data', 'text/plain'],
    csv: ['data', 'text/plain'], ini: ['data', 'text/plain'], cfg: ['data', 'text/plain'],
  };
  const KIND_ORDER = { image: 0, audio: 1, data: 2 };
  const LIMITS = {
    zipBytes: 300 * 1024 * 1024,
    assetBytes: 8 * 1024 * 1024,
    dataBytes: 1024 * 1024,
    roomBytes: 40 * 1024 * 1024,
    assets: 150,
    zipEntries: 5000,
  };
  const SCALE_STEPS = [0.6, 1, 1.6, 2.4];

  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

  function toast(message, kind) {
    const t = make('div', 'toast' + (kind ? ' ' + kind : ''), message);
    $('#toasts').append(t);
    setTimeout(() => t.classList.add('out'), 3800);
    setTimeout(() => t.remove(), 4300);
  }

  // -------------------------------------------------------------- state

  const socket = io();

  const state = {
    you: null,
    code: null,
    hostId: null,
    players: [],
    packName: '',
    assets: new Map(), // id -> { id, name, kind, mime, size, url, text }
    items: new Map(), // id -> { id, assetId, x, y, z, scale }
    itemEls: new Map(), // id -> HTMLElement
    dragging: null,
    importing: false,
    volume: 0.8,
  };
  const playing = new Set();

  /** Emit an event and wait for the server's acknowledgement. */
  function request(event, payload, onOk) {
    return new Promise((resolve, reject) => {
      socket.timeout(30000).emit(event, payload || {}, (err, res) => {
        if (err) return reject(new Error('The server did not answer in time.'));
        if (!res || !res.ok) return reject(new Error((res && res.error) || 'Request failed.'));
        if (onOk) onOk(res); // runs synchronously, before any later packet is handled
        resolve(res);
      });
    });
  }

  function showScreen(name) {
    $('#landing').classList.toggle('hidden', name !== 'landing');
    $('#room').classList.toggle('hidden', name !== 'room');
  }

  const isHost = () => state.you !== null && state.hostId === state.you;

  // ------------------------------------------------------------ landing

  function loadName() {
    try { return localStorage.getItem('zipparty-name') || ''; } catch (e) { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem('zipparty-name', n); } catch (e) { /* storage unavailable */ }
  }
  const getName = () => $('#name').value.trim().slice(0, 20);

  async function withBusy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  }

  $('#btn-create').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    saveName(getName());
    await request('room:create', { name: getName() }, (res) => enterRoom(res));
  }));

  async function joinFromInput(btn) {
    const code = $('#code-input').value.trim();
    if (!code) { toast('Enter a room code first.', 'error'); return; }
    await withBusy(btn, async () => {
      saveName(getName());
      await request('room:join', { code, name: getName() }, (res) => enterRoom(res));
    });
  }
  $('#btn-join').addEventListener('click', (e) => joinFromInput(e.currentTarget));
  $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput($('#btn-join')); });
  $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });

  $('#btn-leave').addEventListener('click', async () => {
    try { await request('room:leave'); } catch (e) { /* leaving anyway */ }
    leaveLocal();
  });

  function leaveLocal() {
    clearBoard();
    stopAllSounds();
    state.code = null;
    state.you = null;
    state.hostId = null;
    state.players = [];
    state.packName = '';
    $('#chat-log').textContent = '';
    history.replaceState(null, '', location.pathname);
    $('#code-input').value = '';
    showScreen('landing');
  }

  $('#room-code-btn').addEventListener('click', async () => {
    const link = location.origin + '/?room=' + state.code;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied.');
    } catch (e) {
      window.prompt('Copy this invite link:', link);
    }
  });

  // --------------------------------------------------------- room entry

  function enterRoom(res, opts) {
    const keepChat = opts && opts.keepChat;
    const s = res.state;
    clearBoard();
    stopAllSounds();
    if (!keepChat || state.code !== s.code) $('#chat-log').textContent = '';

    state.you = res.you;
    state.code = s.code;
    state.hostId = s.hostId;
    state.players = s.players;
    state.packName = s.packName || '';
    for (const it of s.items) {
      state.items.set(it.id, it);
      createItemEl(it);
    }

    $('#room-code').textContent = s.code;
    history.replaceState(null, '', '?room=' + s.code);
    showScreen('room');
    renderPlayers();
    renderAssets();
    updateBoardHint();
    socket.emit('assets:request', {}); // the server then streams the stored assets
  }

  function clearBoard() {
    for (const el of state.itemEls.values()) el.remove();
    state.itemEls.clear();
    state.items.clear();
    for (const a of state.assets.values()) if (a.url) URL.revokeObjectURL(a.url);
    state.assets.clear();
    state.dragging = null;
    $('#viewer-wrap').classList.add('hidden');
    $('#viewer').textContent = '';
  }

  // ------------------------------------------------------------ players

  function renderPlayers() {
    const box = $('#players');
    box.textContent = '';
    for (const p of state.players) {
      const chip = make('span', 'chip');
      const dot = make('i');
      dot.style.background = p.color;
      chip.append(dot, make('span', '', p.name + (p.id === state.you ? ' (you)' : '')));
      if (p.id === state.hostId) chip.append(make('b', 'badge', 'HOST'));
      box.append(chip);
    }
    $('#host-panel').classList.toggle('hidden', !isHost());
    updateBoardHint();
  }

  // ------------------------------------------------------------- assets

  function addAsset(meta, bytes) {
    if (state.assets.has(meta.id)) return;
    const a = { id: meta.id, name: meta.name, kind: meta.kind, mime: meta.mime, size: meta.size, url: null, text: null };
    if (a.kind === 'data') {
      a.text = new TextDecoder().decode(bytes);
    } else {
      a.url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
    }
    state.assets.set(a.id, a);
    for (const it of state.items.values()) if (it.assetId === a.id) applyItem(it);
    scheduleAssetRender();
  }

  let assetRenderQueued = false;
  function scheduleAssetRender() {
    if (assetRenderQueued) return;
    assetRenderQueued = true;
    requestAnimationFrame(() => { assetRenderQueued = false; renderAssets(); });
  }

  const baseName = (path) => path.split('/').pop();

  function renderAssets() {
    const groups = { image: [], audio: [], data: [] };
    for (const a of state.assets.values()) groups[a.kind].push(a);

    $('#count-images').textContent = groups.image.length;
    $('#count-sounds').textContent = groups.audio.length;
    $('#count-data').textContent = groups.data.length;

    const imgBox = $('#tray-images');
    imgBox.textContent = '';
    for (const a of groups.image) {
      const btn = make('button', 'thumb');
      btn.type = 'button';
      btn.title = 'Add "' + baseName(a.name) + '" to the board';
      const img = make('img');
      img.src = a.url;
      img.alt = baseName(a.name);
      img.draggable = false;
      btn.append(img);
      btn.addEventListener('click', () => socket.emit('item:spawn', { assetId: a.id }));
      imgBox.append(btn);
    }

    const sndBox = $('#tray-sounds');
    sndBox.textContent = '';
    for (const a of groups.audio) {
      const btn = make('button', 'row-btn');
      btn.type = 'button';
      btn.dataset.sound = a.id;
      btn.title = a.name + ' (' + fmtBytes(a.size) + ')';
      btn.append(make('span', 'icon', '▶'), make('span', 'label', baseName(a.name)));
      btn.addEventListener('click', () => socket.emit('audio:play', { assetId: a.id }));
      sndBox.append(btn);
    }

    const dataBox = $('#tray-data');
    dataBox.textContent = '';
    for (const a of groups.data) {
      const btn = make('button', 'row-btn');
      btn.type = 'button';
      btn.title = a.name + ' (' + fmtBytes(a.size) + ')';
      btn.append(make('span', 'icon', '{ }'), make('span', 'label', baseName(a.name)));
      btn.addEventListener('click', () => showData(a));
      dataBox.append(btn);
    }

    const parts = [];
    if (state.packName) parts.push(state.packName);
    parts.push(groups.image.length + ' images', groups.audio.length + ' sounds', groups.data.length + ' data files');
    $('#status').textContent = state.assets.size ? parts.join(' · ') : 'No pack loaded yet';
    updateBoardHint();
  }

  function showData(a) {
    let text = a.text || '';
    if (/\.json$/i.test(a.name)) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* show raw text */ }
    }
    if (text.length > 20000) text = text.slice(0, 20000) + '\n\n... (truncated)';
    $('#viewer-title').textContent = a.name;
    $('#viewer').textContent = text; // textContent: file contents are never treated as HTML
    $('#viewer-wrap').classList.remove('hidden');
  }

  function updateBoardHint() {
    const hint = $('#board-hint');
    if (state.items.size > 0) { hint.textContent = ''; return; }
    if (state.assets.size === 0) {
      hint.textContent = isHost()
        ? 'Import a .zip from the panel on the right to get started.'
        : 'Waiting for the host to import a .zip...';
    } else {
      hint.textContent = 'Click an image in the tray to put it on the board.';
    }
  }

  // ---------------------------------------------------------- zip import

  const dropzone = $('#dropzone');
  const zipInput = $('#zip-input');
  zipInput.addEventListener('change', () => {
    const file = zipInput.files && zipInput.files[0];
    zipInput.value = '';
    importZip(file);
  });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
  }));
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    importZip(file);
  });

  $('#btn-clear').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await request('assets:reset', {}, () => resetLocalPack());
    toast('Cleared.');
  }));

  function resetLocalPack() {
    clearBoard();
    state.packName = '';
    renderAssets();
  }

  function setProgress(fraction, text) {
    $('#progress').classList.remove('hidden');
    $('#progress-bar').style.width = Math.round(clamp(fraction, 0, 1) * 100) + '%';
    $('#progress-text').textContent = text;
  }

  async function importZip(file) {
    if (!file || state.importing) return;
    if (!isHost()) { toast('Only the host can import a zip.', 'error'); return; }
    if (!/\.zip$/i.test(file.name)) { toast('Please choose a .zip file.', 'error'); return; }
    if (!window.JSZip) { toast('JSZip failed to load. Check your connection and reload the page.', 'error'); return; }
    if (file.size > LIMITS.zipBytes) { toast('That zip is over ' + fmtBytes(LIMITS.zipBytes) + '. Try a smaller one.', 'error'); return; }

    state.importing = true;
    setProgress(0, 'Reading ' + file.name + '...');
    try {
      const zip = await JSZip.loadAsync(file);

      // 1. Decide which entries to use.
      const picked = [];
      const skippedExt = {};
      let entryCount = 0;
      zip.forEach((path, entry) => {
        if (entry.dir || ++entryCount > LIMITS.zipEntries) return;
        const base = baseName(path);
        if (!base || base.startsWith('.') || path.startsWith('__MACOSX/')) return;
        const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
        const type = FILE_TYPES[ext];
        if (!type) {
          const key = ext ? '.' + ext : '(no extension)';
          skippedExt[key] = (skippedExt[key] || 0) + 1;
          return;
        }
        picked.push({ entry, path, base, kind: type[0] });
      });
      picked.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path));
      const overCap = Math.max(0, picked.length - LIMITS.assets);
      const entries = picked.slice(0, LIMITS.assets);

      if (entries.length === 0) {
        const seen = Object.keys(skippedExt).slice(0, 6).join(', ');
        throw new Error('No usable files in that zip.' + (seen ? ' Found only: ' + seen + '.' : ''));
      }

      // 2. Reset the room, then upload each file.
      await request('assets:reset', {}, () => resetLocalPack());

      let total = 0;
      let loaded = 0;
      let tooBig = 0;
      let roomFull = 0;
      let unreadable = 0;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        setProgress(i / entries.length, 'Loading ' + (i + 1) + '/' + entries.length + ': ' + e.base);
        let bytes;
        try {
          bytes = await e.entry.async('uint8array');
        } catch (err) {
          unreadable++;
          continue;
        }
        if (bytes.byteLength === 0) continue;
        if (bytes.byteLength > (e.kind === 'data' ? LIMITS.dataBytes : LIMITS.assetBytes)) { tooBig++; continue; }
        if (total + bytes.byteLength > LIMITS.roomBytes) { roomFull++; continue; }
        const res = await request('asset:add', { name: e.path, data: bytes });
        total += bytes.byteLength;
        loaded++;
        addAsset(res.asset, bytes);
      }

      state.packName = file.name;
      await request('assets:done', { packName: file.name });

      // 3. Tell the host what happened.
      const notes = [];
      const skippedTotal = Object.values(skippedExt).reduce((a, b) => a + b, 0);
      if (skippedTotal) {
        const top = Object.entries(skippedExt).sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k, v]) => k + ' x' + v).join(', ');
        notes.push(skippedTotal + ' unsupported (' + top + ')');
      }
      if (tooBig) notes.push(tooBig + ' too large');
      if (roomFull + overCap) notes.push(roomFull + overCap + ' over the room limit');
      if (unreadable) notes.push(unreadable + ' unreadable');
      const summary = 'Loaded ' + loaded + ' files (' + fmtBytes(total) + ')' + (notes.length ? '. Skipped: ' + notes.join(', ') : '');
      setProgress(1, summary);
      toast(summary);
      setTimeout(() => { if (!state.importing) $('#progress').classList.add('hidden'); }, 9000);
    } catch (err) {
      $('#progress').classList.add('hidden');
      toast(err.message || 'Import failed.', 'error');
    } finally {
      state.importing = false;
    }
  }

  // -------------------------------------------------------- board items

  const board = $('#board');

  function createItemEl(item) {
    const el = make('div', 'item');
    el.dataset.id = item.id;

    const img = make('img');
    img.draggable = false;
    img.alt = '';
    img.addEventListener('load', () => img.classList.toggle('pixel', img.naturalWidth <= 64));

    const rm = make('button', 'item-remove', '×');
    rm.type = 'button';
    rm.title = 'Remove from board';
    rm.addEventListener('pointerdown', (e) => e.stopPropagation());
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('item:remove', { id: item.id });
    });

    el.append(img, rm);
    attachDrag(el, item.id);
    attachResize(el, item.id);
    board.append(el);
    state.itemEls.set(item.id, el);
    applyItem(item);
  }

  function applyItem(item) {
    const el = state.itemEls.get(item.id);
    if (!el) return;
    el.style.left = item.x * 100 + '%';
    el.style.top = item.y * 100 + '%';
    el.style.zIndex = item.z;
    el.style.setProperty('--scale', item.scale);
    const img = el.querySelector('img');
    const asset = state.assets.get(item.assetId);
    if (asset && asset.url && img.dataset.assetId !== asset.id) {
      img.dataset.assetId = asset.id;
      img.src = asset.url;
      img.alt = baseName(asset.name);
    }
  }

  function removeItemLocal(id) {
    const el = state.itemEls.get(id);
    if (el) el.remove();
    state.itemEls.delete(id);
    state.items.delete(id);
    updateBoardHint();
  }

  function attachDrag(el, id) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const item = state.items.get(id);
      if (!item) return;
      e.preventDefault();

      const rect = board.getBoundingClientRect();
      const offX = (e.clientX - rect.left) / rect.width - item.x;
      const offY = (e.clientY - rect.top) / rect.height - item.y;
      const at = (ev) => ({
        x: clamp((ev.clientX - rect.left) / rect.width - offX, 0, 1),
        y: clamp((ev.clientY - rect.top) / rect.height - offY, 0, 1),
      });

      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      state.dragging = id;
      socket.emit('item:grab', { id });

      let lastSend = 0;
      const onMove = (ev) => {
        const p = at(ev);
        item.x = p.x;
        item.y = p.y;
        applyItem(item);
        const now = performance.now();
        if (now - lastSend > 33) {
          lastSend = now;
          socket.volatile.emit('item:move', { id, x: p.x, y: p.y });
        }
      };
      const onUp = (ev) => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        el.classList.remove('dragging');
        state.dragging = null;
        if (ev.type !== 'pointercancel') {
          const p = at(ev);
          item.x = p.x;
          item.y = p.y;
          applyItem(item);
        }
        socket.emit('item:drop', { id, x: item.x, y: item.y });
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });
  }

  function attachResize(el, id) {
    let timer = null;
    const setScale = (scale) => {
      const item = state.items.get(id);
      if (!item) return;
      item.scale = clamp(Math.round(scale * 100) / 100, 0.4, 4);
      applyItem(item);
      clearTimeout(timer);
      timer = setTimeout(() => socket.emit('item:scale', { id, scale: item.scale }), 80);
    };
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const item = state.items.get(id);
      if (item) setScale(item.scale * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });
    el.addEventListener('dblclick', () => {
      const item = state.items.get(id);
      if (!item) return;
      const next = SCALE_STEPS.find((s) => s > item.scale + 0.01);
      setScale(next === undefined ? SCALE_STEPS[0] : next);
    });
  }

  // Click empty board space: ping everyone.
  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.item')) return;
    const rect = board.getBoundingClientRect();
    socket.emit('board:ping', {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
    });
  });

  function showPing(p) {
    const el = make('div', 'ping');
    el.style.left = p.x * 100 + '%';
    el.style.top = p.y * 100 + '%';
    el.style.setProperty('--c', p.color);
    el.append(make('span', '', p.by));
    board.append(el);
    setTimeout(() => el.remove(), 1200);
  }

  // -------------------------------------------------------------- audio

  function playSound(assetId) {
    const a = state.assets.get(assetId);
    if (!a || a.kind !== 'audio' || !a.url) return;
    const audio = new Audio(a.url);
    audio.volume = state.volume;
    playing.add(audio);
    const done = () => playing.delete(audio);
    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    audio.play().catch(() => {
      done();
      toast('Your browser blocked the sound. Click anywhere on the page, then try again.', 'error');
    });
    const row = document.querySelector('[data-sound="' + assetId + '"]');
    if (row) {
      row.classList.add('pulse');
      setTimeout(() => row.classList.remove('pulse'), 350);
    }
  }

  function stopAllSounds() {
    for (const audio of playing) audio.pause();
    playing.clear();
  }

  $('#volume').addEventListener('input', (e) => {
    state.volume = Number(e.target.value);
    for (const audio of playing) audio.volume = state.volume;
  });
  $('#btn-stop-audio').addEventListener('click', () => socket.emit('audio:stop', {}));

  // --------------------------------------------------------------- chat

  function addChat(msg) {
    const log = $('#chat-log');
    const line = make('div', 'msg' + (msg.system ? ' system' : ''));
    if (msg.system) {
      line.textContent = msg.text;
    } else {
      const who = make('b', '', msg.name);
      who.style.color = msg.color;
      line.append(who, document.createTextNode(msg.text));
    }
    log.append(line);
    while (log.childElementCount > 100) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    input.value = '';
  });

  // ------------------------------------------------------ socket events

  socket.on('room:players', (p) => {
    if (!state.code) return;
    state.hostId = p.hostId;
    state.players = p.players;
    renderPlayers();
  });

  socket.on('assets:cleared', () => {
    if (state.code) resetLocalPack();
  });

  socket.on('asset:added', (a) => {
    if (state.code) addAsset(a, a.data);
  });

  socket.on('pack:ready', (p) => {
    if (!state.code) return;
    for (const el of state.itemEls.values()) el.remove();
    state.itemEls.clear();
    state.items.clear();
    state.packName = p.packName || '';
    for (const it of p.items) {
      state.items.set(it.id, it);
      createItemEl(it);
    }
    renderAssets();
  });

  socket.on('item:added', (it) => {
    if (!state.code) return;
    state.items.set(it.id, it);
    createItemEl(it);
    updateBoardHint();
  });

  socket.on('item:moved', (m) => {
    const it = state.items.get(m.id);
    if (!it || state.dragging === m.id) return;
    it.x = m.x;
    it.y = m.y;
    applyItem(it);
  });

  socket.on('item:z', (m) => {
    const it = state.items.get(m.id);
    if (!it) return;
    it.z = m.z;
    applyItem(it);
  });

  socket.on('item:scaled', (m) => {
    const it = state.items.get(m.id);
    if (!it) return;
    it.scale = m.scale;
    applyItem(it);
  });

  socket.on('item:removed', (m) => removeItemLocal(m.id));
  socket.on('audio:play', (m) => playSound(m.assetId));
  socket.on('audio:stop', stopAllSounds);
  socket.on('board:ping', showPing);
  socket.on('chat:message', addChat);

  socket.on('disconnect', () => {
    if (state.code) toast('Connection lost. Trying to reconnect...', 'error');
  });

  // After a dropped connection the old socket is gone, so rejoin the same room.
  socket.on('connect', () => {
    if (!state.code) return;
    request('room:join', { code: state.code, name: getName() }, (res) => enterRoom(res, { keepChat: true }))
      .then(() => toast('Reconnected.'))
      .catch((e) => {
        toast('Could not rejoin the room: ' + e.message, 'error');
        leaveLocal();
      });
  });

  socket.on('connect_error', () => {
    if (!state.code) toast('Cannot reach the server. Retrying...', 'error');
  });

  // --------------------------------------------------------------- init

  $('#name').value = loadName();
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    $('#code-input').value = roomParam.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    $(($('#name').value ? '#btn-join' : '#name')).focus();
  }
})();
