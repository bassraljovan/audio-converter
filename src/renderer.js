/* global Formats */
(function () {
  const { FORMATS, DEPTH_LABEL, DEFAULT_SETTINGS, PRESETS } = Formats;
  const api = window.api;
  const $ = id => document.getElementById(id);

  const STORE_KEY = 'audio-converter-settings-v1';
  const items = [];               // queue entries
  const selected = new Set();     // item ids
  let lastClicked = null;
  let nextId = 1;
  let converting = false;
  let stopRequested = false;
  let sys = { cpus: 4, musicDir: '' };
  let lastOutput = null;

  let settings = loadSettings();

  // ---------- Settings persistence ----------
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }
  function set(patch) {
    Object.assign(settings, patch);
    saveSettings();
    renderSettings();
  }

  // ---------- Formatting helpers ----------
  const fmtTime = s => {
    if (!s || !isFinite(s)) return '—';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const fmtSize = b => {
    if (b == null) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1024 ** 3) return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (b / 1024 ** 3).toFixed(2) + ' GB';
  };
  const fmtRate = r => (r % 1000 ? (r / 1000).toFixed(1) : r / 1000) + ' kHz';
  const basename = p => p.split(/[\\/]/).pop();
  const dirname = p => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fileUrl = p => {
    let n = p.replace(/\\/g, '/');
    if (!n.startsWith('/')) n = '/' + n;
    return 'file://' + n.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');
  };

  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
  }

  // ---------- Adding files ----------
  async function addPaths(paths) {
    if (!paths || !paths.length) return;
    const found = await api.expandPaths(paths);
    const known = new Set(items.map(i => i.path));
    const fresh = found.filter(f => !known.has(f.path));
    if (!found.length) return toast('No audio files found there.');
    if (!fresh.length) return toast('Those files are already in the list.');
    for (const f of fresh) {
      items.push({ id: nextId++, path: f.path, size: f.size, state: 'probing', info: null, pct: 0 });
    }
    renderList();
    if (fresh.length < found.length) toast(`${found.length - fresh.length} already in the list, skipped.`);
    // Probe a few at a time so huge folders don't spawn hundreds of processes.
    const queue = items.filter(i => i.state === 'probing');
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        try {
          const info = await api.probe(it.path);
          it.info = info;
          it.state = info.ok ? 'ready' : 'invalid';
          it.error = info.error;
        } catch (e) {
          it.state = 'invalid'; it.error = String(e.message || e);
        }
        updateRow(it);
        updateChrome();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // ---------- Queue rendering ----------
  function sourceText(info) {
    if (!info || !info.ok) return '';
    const parts = [`<span class="codec">${esc(prettyCodec(info.codec))}</span>`];
    if (info.sampleRate) parts.push(fmtRate(info.sampleRate));
    if (info.channels) parts.push(esc(info.channels));
    if (info.bitrate) parts.push(info.bitrate + ' kbps');
    return parts.join(' · ');
  }
  function prettyCodec(c) {
    if (/^pcm_/.test(c)) return 'PCM ' + (c.match(/\d+/) || [''])[0] + '-bit';
    return ({ mp3float: 'mp3', wmav2: 'wma', wmapro: 'wma pro', vorbis: 'ogg vorbis' })[c] || c;
  }

  function statusHTML(it) {
    switch (it.state) {
      case 'probing': return `<div class="status muted"><div class="spinner"></div><span class="lbl">Reading…</span></div>`;
      case 'invalid': return `<div class="status err" title="${esc(it.error || '')}"><span class="lbl">${esc(it.error || "Can't read this file")}</span></div>`;
      case 'ready': return `<div class="status muted"><span class="lbl">Ready</span></div>`;
      case 'queued': return `<div class="status muted"><span class="lbl">Waiting…</span></div>`;
      case 'converting': return `<div class="status"><div class="mini"><div style="width:${it.pct.toFixed(1)}%"></div></div><span class="pct">${Math.floor(it.pct)}%</span></div>`;
      case 'done': return `<div class="status ok" title="${esc(it.output)}"><span class="lbl">✓ ${fmtSize(it.outSize)} · <a data-act="reveal">Show</a></span></div>`;
      case 'skipped': return `<div class="status warn" title="${esc(it.output)}"><span class="lbl">Skipped — file exists</span></div>`;
      case 'cancelled': return `<div class="status muted"><span class="lbl">Stopped</span></div>`;
      case 'error': return `<div class="status err" title="${esc(it.error || '')}"><span class="lbl">Failed: ${esc(it.error || 'unknown error')}</span></div>`;
    }
    return '';
  }

  function rowHTML(it) {
    const name = basename(it.path);
    return `
      <button class="icon-btn play" data-act="play" title="Preview"${it.state === 'invalid' ? ' disabled' : ''}>
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>
      </button>
      <div class="name"><div class="t" title="${esc(name)}">${esc(name)}</div><div class="p" title="${esc(it.path)}">&lrm;${esc(dirname(it.path))}&lrm;</div></div>
      <div class="src">${sourceText(it.info)}</div>
      <div class="num">${fmtTime(it.info && it.info.duration)}</div>
      <div class="num">${fmtSize(it.size)}</div>
      <div class="st">${statusHTML(it)}</div>
      <button class="icon-btn x" data-act="remove" title="Remove">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>`;
  }

  function renderList() {
    const list = $('list');
    list.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'row';
      el.dataset.id = it.id;
      el.setAttribute('role', 'option');
      el.innerHTML = rowHTML(it);
      if (selected.has(it.id)) el.classList.add('selected');
      list.appendChild(el);
    }
    markPlaying();
    updateChrome();
  }

  function rowEl(it) { return $('list').querySelector(`.row[data-id="${it.id}"]`); }

  function updateRow(it) {
    const el = rowEl(it);
    if (el) el.innerHTML = rowHTML(it);
  }

  function updateStatus(it) {
    const el = rowEl(it);
    if (!el) return;
    if (it.state === 'converting') {
      const bar = el.querySelector('.mini > div');
      const pct = el.querySelector('.pct');
      if (bar && pct) { bar.style.width = it.pct.toFixed(1) + '%'; pct.textContent = Math.floor(it.pct) + '%'; return; }
    }
    el.querySelector('.st').innerHTML = statusHTML(it);
  }

  // ---------- List interaction ----------
  $('list').addEventListener('click', e => {
    const row = e.target.closest('.row');
    if (!row) { selected.clear(); syncSelection(); return; }
    const it = items.find(i => i.id === +row.dataset.id);
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'remove') return removeItems([it.id]);
      if (a === 'play') return togglePreview(it);
      if (a === 'reveal') return api.reveal(it.output);
    }
    if (e.shiftKey && lastClicked != null) {
      const a = items.findIndex(i => i.id === lastClicked), b = items.indexOf(it);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!(e.metaKey || e.ctrlKey)) selected.clear();
      for (let k = lo; k <= hi; k++) selected.add(items[k].id);
    } else if (e.metaKey || e.ctrlKey) {
      selected.has(it.id) ? selected.delete(it.id) : selected.add(it.id);
      lastClicked = it.id;
    } else {
      selected.clear(); selected.add(it.id); lastClicked = it.id;
    }
    syncSelection();
  });

  $('list').addEventListener('dblclick', e => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('[data-act]')) return;
    const it = items.find(i => i.id === +row.dataset.id);
    if (it.state === 'done') api.openPath(it.output);
    else togglePreview(it);
  });

  function syncSelection() {
    for (const el of $('list').children) el.classList.toggle('selected', selected.has(+el.dataset.id));
    updateChrome();
  }

  function removeItems(ids) {
    const busy = new Set(items.filter(i => i.state === 'converting').map(i => i.id));
    const drop = ids.filter(id => !busy.has(id));
    if (drop.length < ids.length) toast("Files that are converting right now can't be removed.");
    for (const id of drop) {
      const k = items.findIndex(i => i.id === id);
      if (k >= 0) {
        if (player.item && player.item.id === id) stopPreview();
        items.splice(k, 1);
      }
      selected.delete(id);
    }
    renderList();
  }

  // ---------- Toolbar ----------
  $('addFiles').onclick = $('emptyAdd').onclick = async () => addPaths(await api.pickFiles());
  $('addFolder').onclick = $('emptyFolder').onclick = async () => {
    const dir = await api.pickFolder('input');
    if (dir) addPaths([dir]);
  };
  $('removeSel').onclick = () => removeItems([...selected]);
  $('clearAll').onclick = () => removeItems(items.map(i => i.id));
  $('clearDone').onclick = () => removeItems(items.filter(i => i.state === 'done' || i.state === 'skipped').map(i => i.id));
  $('openOut').onclick = () => {
    if (lastOutput) api.reveal(lastOutput);
    else if (settings.outputMode === 'folder' && settings.outputDir) api.openPath(settings.outputDir);
  };

  function updateChrome() {
    const n = items.length;
    $('empty').hidden = n > 0;
    $('clearAll').disabled = !n || converting;
    $('removeSel').disabled = !selected.size;
    $('clearDone').disabled = !items.some(i => i.state === 'done' || i.state === 'skipped');
    $('openOut').disabled = !lastOutput && !(settings.outputMode === 'folder' && settings.outputDir);

    const btn = $('convertBtn');
    if (converting) {
      btn.disabled = false;
      btn.classList.add('stop');
      $('convertLabel').textContent = stopRequested ? 'Stopping…' : 'Stop';
    } else {
      btn.classList.remove('stop');
      const convertible = items.filter(i => i.info && i.info.ok);
      const pending = convertible.filter(i => i.state !== 'done' && i.state !== 'skipped');
      btn.disabled = !convertible.length;
      const fmt = FORMATS[settings.format].label;
      $('convertLabel').textContent = pending.length
        ? `Convert ${pending.length} to ${fmt}`
        : convertible.length ? `Convert again to ${fmt}` : 'Convert';
    }
    updateOverall();
    renderEstimate();
  }

  function updateOverall() {
    const valid = items.filter(i => i.info && i.info.ok);
    const done = valid.filter(i => i.state === 'done').length;
    const failed = valid.filter(i => i.state === 'error').length;
    const skipped = valid.filter(i => i.state === 'skipped').length;
    const bad = items.filter(i => i.state === 'invalid').length;
    const fill = $('overallBar');
    let text;
    if (!items.length) { text = 'Add some files to get started'; fill.style.width = '0'; }
    else if (converting) {
      const job = valid.filter(i => ['queued', 'converting', 'done', 'error', 'skipped'].includes(i.state) && i.inRun);
      const weight = i => Math.max(1, (i.info && i.info.duration) || 1);
      const total = job.reduce((a, i) => a + weight(i), 0);
      const got = job.reduce((a, i) => a + weight(i) * (i.state === 'converting' ? i.pct / 100 : i.state === 'queued' ? 0 : 1), 0);
      const pct = total ? (got / total) * 100 : 0;
      const finished = job.filter(i => i.state !== 'queued' && i.state !== 'converting').length;
      text = `Converting ${finished + 1 > job.length ? job.length : finished + 1} of ${job.length} · ${Math.floor(pct)}%`;
      fill.style.width = pct + '%';
      fill.classList.remove('done');
    } else {
      const totalDur = valid.reduce((a, i) => a + (i.info.duration || 0), 0);
      text = `${items.length} file${items.length === 1 ? '' : 's'} · ${fmtTime(totalDur)}`;
      if (done) text += ` · ${done} converted`;
      if (skipped) text += ` · ${skipped} skipped`;
      if (failed) text += ` · ${failed} failed`;
      if (bad) text += ` · ${bad} unreadable`;
      const pct = valid.length ? (done + skipped) / valid.length * 100 : 0;
      fill.style.width = pct + '%';
      fill.classList.toggle('done', pct >= 100);
    }
    $('statusText').textContent = text;
  }

  // ---------- Conversion ----------
  $('convertBtn').onclick = () => (converting ? stop() : start());

  function concurrency() {
    const c = Number(settings.concurrency);
    return c > 0 ? c : Math.max(1, Math.min(4, sys.cpus - 1));
  }

  async function start() {
    if (settings.outputMode === 'folder' && !settings.outputDir) {
      const dir = await api.pickFolder('output');
      if (!dir) return;
      set({ outputDir: dir });
    }
    let todo = items.filter(i => i.info && i.info.ok && i.state !== 'done' && i.state !== 'skipped');
    if (!todo.length) todo = items.filter(i => i.info && i.info.ok); // "Convert again"
    if (!todo.length) return;

    for (const i of items) i.inRun = false;
    for (const it of todo) { it.state = 'queued'; it.pct = 0; it.inRun = true; it.error = null; updateStatus(it); }
    converting = true;
    stopRequested = false;
    document.body.classList.add('busy');
    updateChrome();

    const snapshot = JSON.parse(JSON.stringify(settings));
    const queue = todo.slice();
    const started = performance.now();

    const worker = async () => {
      for (let it = queue.shift(); it && !stopRequested; it = queue.shift()) {
        if (!items.includes(it)) continue;
        it.state = 'converting';
        updateStatus(it);
        updateOverall();
        let r;
        try {
          r = await api.convert({ id: String(it.id), input: it.path, info: it.info, settings: snapshot });
        } catch (e) {
          r = { ok: false, error: String(e.message || e) };
        }
        if (r.cancelled) it.state = 'cancelled';
        else if (!r.ok) { it.state = 'error'; it.error = r.error; }
        else if (r.skipped) { it.state = 'skipped'; it.output = r.output; }
        else { it.state = 'done'; it.output = r.output; it.outSize = r.size; lastOutput = r.output; }
        it.pct = 100;
        updateStatus(it);
        updateChrome();
      }
    };
    await Promise.all(Array.from({ length: concurrency() }, worker));

    for (const it of todo) if (it.state === 'queued') { it.state = 'cancelled'; updateStatus(it); }
    converting = false;
    document.body.classList.remove('busy');
    updateChrome();

    const done = todo.filter(i => i.state === 'done').length;
    const failed = todo.filter(i => i.state === 'error').length;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (stopRequested) toast(`Stopped. ${done} file${done === 1 ? '' : 's'} finished.`);
    else if (failed) toast(`${done} converted, ${failed} failed. Hover a failed file to see why.`, 'err');
    else if (done) toast(`Done: ${done} file${done === 1 ? '' : 's'} converted in ${secs}s.`);
    stopRequested = false;
  }

  function stop() {
    stopRequested = true;
    api.cancel(null);
    updateChrome();
  }

  api.onProgress(({ id, pct }) => {
    const it = items.find(i => String(i.id) === id);
    if (!it || it.state !== 'converting') return;
    it.pct = pct;
    updateStatus(it);
    updateOverall();
  });

  // ---------- Settings panel ----------
  function option(value, label, current) {
    return `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
  }

  function renderSettings() {
    const f = FORMATS[settings.format];

    // Presets
    const presetMatch = PRESETS.find(p => Object.entries(p.s).every(([k, v]) => String(settings[k]) === String(v))
      && Object.keys(DEFAULT_SETTINGS).filter(k => ['sampleRate', 'channels', 'normalize'].includes(k) && !(k in p.s)).every(k => settings[k] === DEFAULT_SETTINGS[k]));
    $('preset').innerHTML = option('', presetMatch ? presetMatch.label : 'Custom settings', '') +
      PRESETS.filter(p => p !== presetMatch).map(p => option(p.id, p.label, '')).join('');

    // Format tiles
    $('formats').innerHTML = Object.entries(FORMATS).map(([key, x]) =>
      `<button class="fmt${key === settings.format ? ' on' : ''}" data-fmt="${key}" role="radio" aria-checked="${key === settings.format}">
         <b>${x.label}</b><span>${x.note}</span></button>`).join('');

    // Quality
    const q = $('qualityControls');
    let html = '';
    if (settings.format === 'mp3') {
      html += `<div class="seg" id="mp3Mode">
        <button data-mode="cbr" class="${settings.mp3Mode !== 'vbr' ? 'on' : ''}">Constant bitrate</button>
        <button data-mode="vbr" class="${settings.mp3Mode === 'vbr' ? 'on' : ''}">Variable (VBR)</button></div>`;
      if (settings.mp3Mode === 'vbr') {
        const v = ['V0 · ~245 kbps · best', 'V1 · ~225 kbps', 'V2 · ~190 kbps · great', 'V3 · ~175 kbps', 'V4 · ~165 kbps', 'V5 · ~130 kbps · good', 'V6 · ~115 kbps', 'V7 · ~100 kbps', 'V8 · ~85 kbps', 'V9 · ~65 kbps · smallest'];
        html += `<select id="vbrQuality">${v.map((l, i) => option(i, l, settings.vbrQuality)).join('')}</select>`;
      } else html += bitrateSelect(f);
    } else if (f.bitrates) {
      html += bitrateSelect(f);
    } else if (f.qualities) {
      const approx = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500];
      html += `<select id="oggQuality">${f.qualities.map(n => option(n, `Quality ${n} · ~${approx[n]} kbps${n === 6 ? ' · recommended' : ''}`, settings.oggQuality)).join('')}</select>`;
    }
    if (f.depths) {
      const depth = f.depths.includes(settings.depth) ? settings.depth : f.defaultDepth;
      html += `<div><label class="s-sub" for="depth">Bit depth</label><select id="depth">${f.depths.map(d => option(d, DEPTH_LABEL[d] + (d === '16' ? ' · CD' : ''), depth)).join('')}</select></div>`;
    }
    if (f.levels) {
      html += `<div><label class="s-sub" for="flacLevel">Compression <output>${settings.flacLevel}${settings.flacLevel == 5 ? ' (default)' : ''}</output></label>
        <input type="range" id="flacLevel" min="0" max="12" step="1" value="${settings.flacLevel}" />
        <div class="hint">Higher makes smaller files but converts slower. Sound is identical at every level.</div></div>`;
    }
    if (f.kind === 'lossless' && settings.format !== 'flac') {
      html += `<div class="hint">Lossless: no quality is lost beyond what the source already has.</div>`;
    }
    q.innerHTML = html;

    // Sample rate
    const rates = f.rates;
    if (settings.sampleRate !== 'original' && !rates.includes(Number(settings.sampleRate))) settings.sampleRate = 'original';
    $('sampleRate').innerHTML = option('original', 'Same as source', settings.sampleRate) + rates.map(r => option(r, fmtRate(r), settings.sampleRate)).join('');
    $('channels').value = settings.channels;

    // Effects
    $('normalize').value = settings.normalize;
    $('gainDb').value = settings.gainDb;
    $('gainOut').textContent = (settings.gainDb > 0 ? '+' : '') + settings.gainDb + ' dB';
    $('fadeIn').value = settings.fadeIn;
    $('fadeOut').value = settings.fadeOut;
    $('trimSilence').checked = !!settings.trimSilence;
    const fx = [settings.normalize !== 'off', Number(settings.gainDb) !== 0, Number(settings.fadeIn) > 0, Number(settings.fadeOut) > 0, settings.trimSilence].filter(Boolean).length;
    $('fxBadge').hidden = !fx;
    $('fxBadge').textContent = fx + ' on';

    // Output
    document.querySelectorAll('input[name=outputMode]').forEach(r => { r.checked = r.value === settings.outputMode; });
    $('outputDirText').textContent = settings.outputDir || 'No folder chosen';
    $('outputDirText').title = settings.outputDir || '';
    document.querySelector('.folder-pick').classList.toggle('disabled', settings.outputMode !== 'folder');
    if (document.activeElement !== $('suffix')) $('suffix').value = settings.suffix;
    $('onExists').value = settings.onExists;
    $('keepMetadata').checked = !!settings.keepMetadata;
    $('keepArt').checked = !!settings.keepArt;
    const auto = Math.max(1, Math.min(4, sys.cpus - 1));
    $('concurrency').innerHTML = option(0, `Automatic (${auto} at a time)`, settings.concurrency) +
      [1, 2, 3, 4, 6, 8, 12, 16].filter(n => n <= Math.max(2, sys.cpus)).map(n => option(n, n === 1 ? '1 file at a time' : `${n} files at a time`, settings.concurrency)).join('');

    updateChrome();
  }

  function bitrateSelect(f) {
    const cur = f.bitrates.includes(Number(settings.bitrate)) ? Number(settings.bitrate) : f.defaultBitrate;
    const tag = b => b === f.defaultBitrate ? ' · recommended' : b >= 256 ? ' · high' : b <= 64 ? ' · small' : '';
    return `<div><label class="s-sub" for="bitrate">Bitrate</label><select id="bitrate">${f.bitrates.map(b => option(b, `${b} kbps${tag(b)}`, cur)).join('')}</select></div>`;
  }

  function renderEstimate() {
    const valid = items.filter(i => i.info && i.info.ok && i.info.duration);
    const el = $('estimate');
    if (!valid.length) { el.innerHTML = ''; return; }
    const f = FORMATS[settings.format];
    let total = 0, exact = true;
    for (const it of valid) {
      const d = it.info.duration;
      const ch = settings.channels !== 'original' ? Number(settings.channels) : (/mono/.test(it.info.channels) ? 1 : 2);
      const rate = settings.sampleRate !== 'original' ? Number(settings.sampleRate) : (it.info.sampleRate || 44100);
      if (settings.format === 'wav' || settings.format === 'aiff') {
        const bits = settings.depth === '32f' ? 32 : Number(f.depths.includes(settings.depth) ? settings.depth : f.defaultDepth);
        total += d * rate * ch * bits / 8;
      } else if (f.bitrates && !(settings.format === 'mp3' && settings.mp3Mode === 'vbr')) {
        const br = f.bitrates.includes(Number(settings.bitrate)) ? Number(settings.bitrate) : f.defaultBitrate;
        total += d * br * 1000 / 8;
      } else if (settings.format === 'mp3') {
        total += d * [245, 225, 190, 175, 165, 130, 115, 100, 85, 65][settings.vbrQuality] * 125; exact = false;
      } else if (settings.format === 'ogg') {
        total += d * [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 500][settings.oggQuality] * 125; exact = false;
      } else {
        const bits = settings.depth === '24' ? 24 : 16;
        total += d * rate * ch * bits / 8 * 0.6; exact = false;
      }
    }
    el.innerHTML = `Estimated output: <b>${exact ? '' : '~'}${fmtSize(Math.round(total))}</b> for ${valid.length} file${valid.length === 1 ? '' : 's'}`;
  }

  // Settings events (delegated so re-rendered controls keep working)
  const settingsEl = $('settings');
  settingsEl.addEventListener('click', e => {
    const fmt = e.target.closest('[data-fmt]');
    if (fmt) {
      const f = FORMATS[fmt.dataset.fmt];
      const patch = { format: fmt.dataset.fmt };
      if (f.bitrates && !f.bitrates.includes(Number(settings.bitrate))) patch.bitrate = f.defaultBitrate;
      if (f.depths && !f.depths.includes(settings.depth)) patch.depth = f.defaultDepth;
      return set(patch);
    }
    const mode = e.target.closest('[data-mode]');
    if (mode) return set({ mp3Mode: mode.dataset.mode });
  });
  settingsEl.addEventListener('change', e => {
    const t = e.target;
    switch (t.id) {
      case 'preset': {
        const p = PRESETS.find(x => x.id === t.value);
        if (p) set({ sampleRate: 'original', channels: 'original', normalize: 'off', ...p.s });
        return;
      }
      case 'bitrate': return set({ bitrate: Number(t.value) });
      case 'vbrQuality': return set({ vbrQuality: Number(t.value) });
      case 'oggQuality': return set({ oggQuality: Number(t.value) });
      case 'depth': return set({ depth: t.value });
      case 'flacLevel': return set({ flacLevel: Number(t.value) });
      case 'sampleRate': return set({ sampleRate: t.value });
      case 'channels': return set({ channels: t.value });
      case 'normalize': return set({ normalize: t.value });
      case 'gainDb': return set({ gainDb: Number(t.value) });
      case 'fadeIn': return set({ fadeIn: Math.max(0, Number(t.value) || 0) });
      case 'fadeOut': return set({ fadeOut: Math.max(0, Number(t.value) || 0) });
      case 'trimSilence': return set({ trimSilence: t.checked });
      case 'onExists': return set({ onExists: t.value });
      case 'keepMetadata': return set({ keepMetadata: t.checked });
      case 'keepArt': return set({ keepArt: t.checked });
      case 'concurrency': return set({ concurrency: Number(t.value) });
      case 'suffix': return set({ suffix: sanitizeSuffix(t.value) });
    }
    if (t.name === 'outputMode') {
      set({ outputMode: t.value });
      if (t.value === 'folder' && !settings.outputDir) $('browseOut').click();
    }
  });
  settingsEl.addEventListener('input', e => {
    if (e.target.id === 'gainDb') $('gainOut').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + ' dB';
    if (e.target.id === 'flacLevel') e.target.previousElementSibling.querySelector('output').textContent = e.target.value;
  });
  $('browseOut').onclick = async () => {
    const dir = await api.pickFolder('output');
    if (dir) set({ outputDir: dir, outputMode: 'folder' });
    else if (!settings.outputDir) set({ outputMode: 'source' });
  };

  function sanitizeSuffix(s) {
    return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 60);
  }

  // ---------- Preview player ----------
  const audio = $('audio');
  const player = { item: null, seeking: false };

  function togglePreview(it) {
    if (player.item === it && !audio.paused) { audio.pause(); return; }
    if (player.item !== it) {
      player.item = it;
      const src = it.state === 'done' && it.output ? it.output : it.path;
      audio.src = fileUrl(src);
      $('pName').textContent = basename(src);
    }
    audio.play().catch(() => {
      toast(`Preview isn't available for ${prettyCodec((it.info && it.info.codec) || 'this format').toUpperCase()} files, but they can still be converted.`);
      stopPreview();
    });
    markPlaying();
  }
  function stopPreview() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    player.item = null;
    $('pName').textContent = 'Nothing playing';
    $('pTime').textContent = '0:00';
    $('seek').value = 0;
    markPlaying();
  }
  function markPlaying() {
    const playing = player.item && !audio.paused;
    $('player').classList.toggle('playing', !!playing);
    $('playBtn').disabled = !player.item && !items.length;
    $('seek').disabled = !player.item;
    for (const el of $('list').children) el.classList.toggle('playing', !!player.item && +el.dataset.id === player.item.id && playing);
  }
  audio.addEventListener('play', markPlaying);
  audio.addEventListener('pause', markPlaying);
  audio.addEventListener('ended', markPlaying);
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    if (!player.seeking) $('seek').value = (audio.currentTime / audio.duration) * 1000;
    $('pTime').textContent = `${fmtTime(audio.currentTime) === '—' ? '0:00' : fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
  });
  $('seek').addEventListener('input', () => { player.seeking = true; });
  $('seek').addEventListener('change', () => {
    if (audio.duration) audio.currentTime = ($('seek').value / 1000) * audio.duration;
    player.seeking = false;
  });
  $('playBtn').onclick = () => {
    if (player.item) return togglePreview(player.item);
    const first = items.find(i => selected.has(i.id)) || items[0];
    if (first) togglePreview(first);
  };

  // ---------- Drag & drop ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    addPaths(paths);
  });

  // ---------- Keyboard ----------
  window.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('addFiles').click(); return; }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); removeItems([...selected]); }
    else if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); items.forEach(i => selected.add(i.id)); syncSelection(); }
    else if (e.key === 'Escape') { selected.clear(); syncSelection(); }
  });

  // ---------- Boot ----------
  api.systemInfo().then(info => { sys = info; renderSettings(); });
  renderSettings();
  renderList();
})();
