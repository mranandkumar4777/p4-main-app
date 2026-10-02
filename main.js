'use strict';
// Presenter desktop app (Electron main process).
// - starts the helper server (pages, phone remote, PIN) inside the app
// - opens the Control window; Live / Preview windows are opened by the page itself
// - "Check for Updates" reads a small JSON file published on GitHub Releases
// - Gemini API key is stored encrypted by the operating system (safeStorage)
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const server = require('./server');

// ---------------------------------------------------------------------------------------------
// Settings you may want to change
// ---------------------------------------------------------------------------------------------
const GEMINI_MODEL = process.env.PRESENTER_GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const UPDATE_CHECK_TIMEOUT_MS = 10000;
const WINDOW_DEFAULT = { width: 1280, height: 800 };
// How updates work
//  1. Push a version tag (git tag v1.0.1 && git push origin v1.0.1) or run the "Build desktop app" workflow.
//  2. GitHub builds the Windows and Mac installers and publishes them to the release "desktop-latest",
//     together with desktop-version.json (the file named below).
//  3. In the app: Settings -> Check for Updates reads that file and offers the download if the
//     version in it is higher than the version in package.json.
// Keep "version" in package.json in step with the tag you push.
// Release files are named like Presenter-1.0.1-win-x64.exe and Presenter-1.0.1-mac-arm64.dmg
// (see "artifactName" in package.json), so desktop-version.json can link to them directly.
// Unsigned builds: Windows SmartScreen / macOS Gatekeeper show a warning the first time.
// If you later buy a code-signing certificate, nothing in this file has to change.
//
//
//
// Where "Check for Updates" looks. The GitHub Action in .github/workflows/desktop.yml writes this
// file (desktop-version.json) to the "desktop-latest" release of the repository on every build.
// Format: { "version": "1.0.1", "notes": "...", "windows": "<url>", "mac_arm64": "<url>", "mac_x64": "<url>" }
const UPDATE_INFO_URL = 'https://github.com/mranandkumar4777/p1-app-pc/releases/download/desktop-latest/desktop-version.json';
const RELEASES_PAGE = 'https://github.com/mranandkumar4777/p1-app-pc/releases';

let mainWindow = null;
let serverInfo = null;
let bgMode = 'dark';          // 'dark' | 'transparent' (Live window background)
let checking = false;

// ---------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------
function createMainWindow() {
  mainWindow = new BrowserWindow(Object.assign({}, WINDOW_DEFAULT, {
    backgroundColor: '#0b1220',
    title: 'Presenter',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  }));
  mainWindow.loadURL('http://localhost:' + serverInfo.port + '/');
  mainWindow.on('closed', () => { mainWindow = null; });

  // Live / Preview windows are opened by the page with window.open(...?mode=display|preview)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let u; try { u = new URL(url); } catch (e) { return { action: 'deny' }; }
    if (u.origin === 'http://localhost:' + serverInfo.port) {
      const live = u.searchParams.get('mode') === 'display';
      const transparent = live && bgMode === 'transparent';
      return {
        action: 'allow',
        overrideBrowserWindowOptions: Object.assign({
          autoHideMenuBar: true,
          backgroundColor: transparent ? '#00000000' : '#000000',
          webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
        }, transparent ? { transparent: true, frame: false, hasShadow: false, alwaysOnTop: true } : {})
      };
    }
    if (/^https?:$/.test(u.protocol)) shell.openExternal(url);   // e.g. the Google search link
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------------------------
function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function downloadUrlFor(info) {
  if (process.platform === 'win32') return info.windows;
  if (process.platform === 'darwin') return process.arch === 'arm64' ? info.mac_arm64 : info.mac_x64;
  return info.url || RELEASES_PAGE;
}
async function checkForUpdates() {
  const current = app.getVersion();
  if (checking) return { status: 'busy', current };
  checking = true;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), UPDATE_CHECK_TIMEOUT_MS);
    let r; try { r = await fetch(UPDATE_INFO_URL + '?t=' + Date.now(), { signal: ctl.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
    if (!r.ok) return { status: 'error', current, error: 'The update file was not found yet (HTTP ' + r.status + ').' };
    const info = await r.json();
    const latest = String(info.version || '').trim();
    if (!latest) return { status: 'error', current, error: 'The update file has no version.' };
    if (cmpVersions(latest, current) <= 0) return { status: 'uptodate', current, latest };
    const parent = mainWindow || undefined;
    const choice = await dialog.showMessageBox(parent, {
      type: 'info', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
      title: 'Update available',
      message: 'Presenter ' + latest + ' is available (you have ' + current + ').',
      detail: info.notes ? String(info.notes).slice(0, 500) : ''
    });
    if (choice.response === 0) { shell.openExternal(downloadUrlFor(info) || RELEASES_PAGE); return { status: 'available', current, latest }; }
    return { status: 'dismissed', current, latest };
  } catch (e) {
    return { status: 'error', current, error: e && e.name === 'AbortError' ? 'Timed out.' : 'No internet connection?' };
  } finally { checking = false; }
}

// ---------------------------------------------------------------------------------------------
// Gemini API key (encrypted with the OS keychain when available) + AI helpers
// ---------------------------------------------------------------------------------------------
const keyFile = () => path.join(app.getPath('userData'), 'gemini.key');
function readKey() {
  try {
    const raw = fs.readFileSync(keyFile());
    if (raw[0] === 0x45 /* 'E' */) return safeStorage.decryptString(raw.subarray(1));
    return raw.subarray(1).toString('utf8');             // 'P' = stored without encryption
  } catch (e) { return ''; }
}
function writeKey(k) {
  if (!k) { try { fs.unlinkSync(keyFile()); } catch (e) {} return; }
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(keyFile(), Buffer.concat([Buffer.from('E'), safeStorage.encryptString(k)]));
  else fs.writeFileSync(keyFile(), Buffer.concat([Buffer.from('P'), Buffer.from(k, 'utf8')]));
}
function keyStatus() { const k = readKey(); return { has: !!k, last4: k.slice(-4), encrypted: safeStorage.isEncryptionAvailable() }; }

async function gemini(parts, schemaHint) {
  const key = readKey();
  if (!key) return { ok: false, code: 'no_key', error: 'Add your Gemini API key in Settings first.' };
  let r;
  try {
    r = await fetch(GEMINI_BASE + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
    });
  } catch (e) { return { ok: false, code: 'network', error: 'Could not reach Gemini (check the internet connection).' }; }
  if (r.status === 400 || r.status === 401 || r.status === 403) return { ok: false, code: 'bad_key', error: 'Gemini rejected the API key.' };
  if (r.status === 404) return { ok: false, code: 'bad_model', error: 'Gemini model "' + GEMINI_MODEL + '" is not available.' };
  if (r.status === 429) return { ok: false, code: 'rate_limit', error: 'Gemini rate limit reached — slowing down.', retryAfterMs: 10000 };
  if (!r.ok) return { ok: false, code: 'http', error: 'Gemini error (HTTP ' + r.status + ').' };
  try {
    const j = await r.json();
    const text = (((j.candidates || [])[0] || {}).content || {}).parts;
    const raw = (text || []).map((p) => p.text || '').join('').trim().replace(/^```json|```$/g, '');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) { return { ok: false, code: 'parse', error: 'Gemini returned something unreadable.' }; }
}

async function aiLyrics(query, ctx) {
  ctx = ctx || {};
  const prompt =
    'The user wants the lyrics of a song. Query: "' + String(query).slice(0, 300) + '".' +
    (ctx.artist ? ' Artist hint: ' + String(ctx.artist).slice(0, 100) + '.' : '') +
    (ctx.transcript ? ' Heard in the room: "' + String(ctx.transcript).slice(0, 300) + '".' : '') +
    ' Only answer if you actually know this song. Do not invent lyrics. Reply with JSON only: ' +
    '{"found":boolean,"title":string,"artist":string,"complete":boolean,"note":string,' +
    '"slides":[string]} where each slide is 2-4 short lines separated by \\n, in the original language/script.';
  const r = await gemini([{ text: prompt }]);
  if (!r.ok) return r;
  const d = r.data || {};
  const slides = (Array.isArray(d.slides) ? d.slides : []).map((s) => String(s || '').trim()).filter(Boolean);
  return { ok: true, found: !!d.found && slides.length > 0, title: String(d.title || query), artist: String(d.artist || ''), complete: !!d.complete, note: String(d.note || ''), slides };
}
async function aiDetect(wavB64, ctx) {
  ctx = ctx || {};
  const prompt =
    'Listen to this short audio clip from a church / event room. Decide whether a SONG is being sung or played and, if so, which one. ' +
    (ctx.recentTranscript ? 'Words heard just before: "' + String(ctx.recentTranscript).slice(0, 300) + '". ' : '') +
    'Reply with JSON only: {"isSong":boolean,"title":string,"artist":string,"confidence":number 0-100,"transcript":string (the words you hear, max 200 chars)}. ' +
    'If unsure, set a low confidence. Never guess a title you do not recognise.';
  const r = await gemini([{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: String(wavB64) } }]);
  if (!r.ok) return r;
  const d = r.data || {};
  return { ok: true, isSong: !!d.isSong, title: String(d.title || ''), artist: String(d.artist || ''), confidence: Math.max(0, Math.min(100, Number(d.confidence) || 0)), transcript: String(d.transcript || '') };
}

ipcMain.handle('presenter:getVersion', () => app.getVersion());
ipcMain.handle('presenter:checkForUpdates', () => checkForUpdates());
ipcMain.handle('presenter:setBgMode', (_e, mode) => { bgMode = mode === 'transparent' ? 'transparent' : 'dark'; return true; });
ipcMain.handle('presenter:ai:keyStatus', () => keyStatus());
ipcMain.handle('presenter:ai:setKey', (_e, k) => { try { writeKey(String(k || '').trim()); return { ok: true }; } catch (e) { return { ok: false, error: 'Could not store the key.' }; } });
ipcMain.handle('presenter:ai:lyrics', (_e, q, c) => aiLyrics(q, c));
ipcMain.handle('presenter:ai:detect', (_e, wav, c) => aiDetect(wav, c));

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    // microphone is needed for AI song detection; allow it only for the app's own pages
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && /^http:\/\/localhost:/.test(wc.getURL())));
    serverInfo = await server.start({ dataDir: app.getPath('userData') });
    createMainWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
  }).catch((e) => { dialog.showErrorBox('Presenter could not start', String(e && e.message || e)); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
