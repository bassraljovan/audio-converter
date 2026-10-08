const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { buildArgs, FORMATS } = require('./formats');

// In a packaged build the binary lives outside the asar archive.
const FFMPEG = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const INPUT_EXTS = new Set([
  'mp3', 'wav', 'wave', 'flac', 'm4a', 'm4b', 'aac', 'alac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'aifc',
  'ape', 'wv', 'mka', 'ac3', 'eac3', 'dts', 'amr', 'au', 'snd', 'caf', 'mp2', 'mpc', 'tta', 'voc', 'w64', 'ra',
  'mid', 'gsm', '3gp', 'mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', 'mts',
]);

let win;
const running = new Map();     // job id -> child process
const reserved = new Set();    // output paths claimed by in-flight jobs

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 920,
    minHeight: 600,
    title: 'Audio Converter',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171a' : '#f4f4f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const p of running.values()) p.kill('SIGKILL');
  if (process.platform !== 'darwin') app.quit();
});

// ---------- Files ----------

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add audio files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio & video', extensions: [...INPUT_EXTS] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-folder', async (_e, purpose) => {
  const r = await dialog.showOpenDialog(win, {
    title: purpose === 'output' ? 'Choose output folder' : 'Add folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Expand dropped/picked paths: folders are walked recursively for audio files.
ipcMain.handle('expand-paths', async (_e, paths) => {
  const out = [];
  const walk = (p, depth) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 12) return;
      let names = [];
      try { names = fs.readdirSync(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) if (!n.startsWith('.')) walk(path.join(p, n), depth + 1);
    } else if (st.isFile()) {
      const ext = path.extname(p).slice(1).toLowerCase();
      // Explicitly chosen files are accepted whatever the extension; folder contents are filtered.
      if (depth === 0 || INPUT_EXTS.has(ext)) out.push({ path: p, size: st.size });
    }
  };
  for (const p of paths) walk(p, 0);
  return out;
});

ipcMain.handle('probe', async (_e, file) => {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostdin', '-i', file]);
  return parseProbe(stderr);
});

function parseProbe(text) {
  const info = { ok: false, duration: 0, codec: '', sampleRate: 0, channels: '', bitrate: 0, hasCover: false, coverIndex: null, hasVideo: false };
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
  const br = text.match(/Duration:.*?bitrate:\s*(\d+)\s*kb\/s/);
  if (br) info.bitrate = +br[1];
  const streams = text.split('\n').filter(l => /^\s*Stream #0:\d+/.test(l));
  for (const l of streams) {
    const idx = +l.match(/Stream #0:(\d+)/)[1];
    if (/: Audio: /.test(l) && !info.ok) {
      info.ok = true;
      const rest = l.split(': Audio: ')[1];
      info.codec = rest.split(/[ ,(]/)[0];
      const sr = rest.match(/(\d+) Hz/);
      if (sr) info.sampleRate = +sr[1];
      const parts = rest.split(',').map(x => x.trim());
      if (parts[2]) info.channels = parts[2].replace(/\(.*\)/, '').trim();
      const abr = rest.match(/(\d+) kb\/s/);
      if (abr) info.bitrate = +abr[1];
    } else if (/: Video: /.test(l)) {
      if (/attached pic/.test(l)) {
        if (!info.hasCover) { info.hasCover = true; info.coverIndex = idx; }
      } else info.hasVideo = true;
    }
  }
  if (!info.ok) {
    const lines = text.trim().split('\n');
    info.error = /Invalid data|could not find codec|No such file/i.test(text)
      ? 'Not a supported audio file'
      : (lines[lines.length - 1] || 'No audio stream found');
  }
  return info;
}

// ---------- Conversion ----------

ipcMain.handle('convert', async (_e, job) => {
  const { id, input, settings, info } = job;
  const f = FORMATS[settings.format];
  const dir = settings.outputMode === 'folder' && settings.outputDir ? settings.outputDir : path.dirname(input);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    return { ok: false, error: `Can't create output folder: ${err.message}` };
  }

  const base = path.basename(input, path.extname(input)) + (settings.suffix || '');
  let target = path.join(dir, `${base}.${f.ext}`);
  const sameAsInput = path.resolve(target).toLowerCase() === path.resolve(input).toLowerCase();
  const taken = p => reserved.has(p) || fs.existsSync(p);

  if (taken(target) || sameAsInput) {
    if (settings.onExists === 'skip' && !sameAsInput) return { ok: true, skipped: true, output: target };
    if (settings.onExists === 'rename' || sameAsInput || reserved.has(target)) {
      let n = 1;
      do { target = path.join(dir, `${base} (${n++}).${f.ext}`); } while (taken(target));
    }
  }
  reserved.add(target);

  // Write to a temp name first so a cancelled/failed job never leaves a broken file.
  const tmp = path.join(dir, `.${path.basename(target, '.' + f.ext)}.converting-${id}.${f.ext}`);
  const args = [
    '-hide_banner', '-nostdin', '-y', '-i', input,
    ...buildArgs(settings, info),
    '-progress', 'pipe:1', '-nostats',
    tmp,
  ];

  const total = info && info.duration ? info.duration : 0;
  const started = Date.now();
  const result = await run(FFMPEG, args, {
    onStart: p => running.set(id, p),
    onStdout: chunk => {
      if (!total) return;
      const m = chunk.match(/out_time_us=(\d+)/g);
      if (!m) return;
      const us = +m[m.length - 1].split('=')[1];
      const pct = Math.min(99.5, (us / 1e6 / total) * 100);
      if (win && !win.isDestroyed()) win.webContents.send('progress', { id, pct });
    },
  });
  running.delete(id);
  reserved.delete(target);

  if (result.killed) {
    safeUnlink(tmp);
    return { ok: false, cancelled: true };
  }
  if (result.code !== 0) {
    safeUnlink(tmp);
    return { ok: false, error: summarizeError(result.stderr) };
  }
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target); // only reached for overwrite
    fs.renameSync(tmp, target);
  } catch (err) {
    safeUnlink(tmp);
    return { ok: false, error: `Couldn't save file: ${err.message}` };
  }
  const size = fs.statSync(target).size;
  return { ok: true, output: target, size, seconds: (Date.now() - started) / 1000 };
});

ipcMain.handle('cancel', (_e, id) => {
  const ids = id ? [id] : [...running.keys()];
  for (const i of ids) {
    const p = running.get(i);
    if (p) { p.__cancelled = true; p.kill('SIGKILL'); }
  }
});

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('system-info', () => ({
  cpus: os.cpus().length,
  platform: process.platform,
  musicDir: path.join(app.getPath('music'), 'Converted'),
}));

// ---------- Helpers ----------

function run(cmd, args, hooks = {}) {
  return new Promise(resolve => {
    let stderr = '';
    const p = spawn(cmd, args, { windowsHide: true });
    hooks.onStart && hooks.onStart(p);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => hooks.onStdout && hooks.onStdout(d));
    p.stderr.on('data', d => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    p.on('error', err => resolve({ code: -1, stderr: String(err), killed: false }));
    p.on('close', code => resolve({ code, stderr, killed: !!p.__cancelled }));
  });
}

function summarizeError(stderr) {
  const lines = stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const interesting = lines.filter(l => /error|invalid|not supported|unsupported|failed|could not|no such|permission/i.test(l));
  return (interesting.slice(-2).join(' — ') || lines.slice(-1)[0] || 'ffmpeg failed').slice(0, 400);
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}
