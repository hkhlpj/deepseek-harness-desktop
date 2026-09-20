'use strict'

/**
 * DeepSeek Harness - standalone desktop shell.
 *
 * A GUI front-end for the compiled DeepSeek Harness web application. It boots
 * the bundled dsh runtime (a private Node.js executable plus the
 * @deepseek-ai/dsh package tree) as a hidden child process, waits for the web
 * host to publish its authenticated URL, and renders that URL inside Electron.
 *
 * No console window is ever created: the child is spawned with windowsHide,
 * piped stdio, and no console allocation. Nothing outside the application
 * folder is required - the bundled runtime is self-contained.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeImage } = require('electron')
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// A Windows GUI process has no console; writing to stdout can raise EPIPE and
// abort the main process, so stdio is inert here and all output goes to a file.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
process.on('uncaughtException', (error) => {
  try { log('[uncaughtException] ' + String((error && error.stack) || error)) } catch {}
})

const PRODUCT = 'DeepSeek Harness'
const PACKAGED = app.isPackaged
const APP_DIR = __dirname
const SMOKE = process.argv.includes('--smoke')

// resources/runtime in a packaged build, ../runtime during development.
const RUNTIME_DIR = PACKAGED
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(APP_DIR, '..', 'runtime')

const NODE_EXE = path.join(RUNTIME_DIR, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const DSH_BIN = path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const BOOT_TIMEOUT_MS = 300000
const URL_PATTERN = /(https?:\/\/127\.0\.0\.1:\d+\/[^\s)'"]*)/
const BG_LAYER_ID = 'dsh-desktop-background-layer'

let mainWindow = null
let settingsWindow = null
let serverProcess = null
let serverUrl = null
let lastPort = null
let quitting = false
let bootLog = []
let logStream = null
let backgroundCssKey = null
let backgroundCache = { key: '', dataUrl: null }

// ---------------------------------------------------------------------------
// Command line and logging
// ---------------------------------------------------------------------------

function rawArgs () {
  return process.argv.slice(PACKAGED ? 1 : 2)
}

function option (name) {
  const args = rawArgs()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--' + name && i + 1 < args.length) return args[i + 1]
    if (arg.startsWith('--' + name + '=')) return arg.slice(name.length + 3)
  }
  return undefined
}

function userDataFile (name) {
  let dir
  try {
    dir = app.getPath('userData')
  } catch {
    dir = path.join(os.tmpdir(), 'DeepSeek Harness')
  }
  return path.join(dir, name)
}

function openLog () {
  if (logStream) return logStream
  let target = option('log')
  if (!target) target = userDataFile('shell.log')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    logStream = fs.createWriteStream(target, { flags: 'a' })
  } catch {
    logStream = null
  }
  return logStream
}

function log (message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n'
  const stream = openLog()
  if (stream) {
    try { stream.write(line) } catch { /* ignore */ }
  }
}

function appendServerLog (chunk) {
  const text = chunk.toString()
  bootLog.push(text)
  if (bootLog.length > 800) bootLog.splice(0, bootLog.length - 800)
  const stream = openLog()
  if (stream) {
    try { stream.write(text) } catch { /* ignore */ }
  }
}

function bootTail (lines) {
  return bootLog.join('').split(/\r?\n/).slice(-(lines || 30)).join('\n')
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_PROMPTS = [
  { id: 'builtin', label: '内置默认（Harness 官方）', text: '', description: '不覆盖上游人格，使用 DeepSeek Harness 内置的默认提示词。' },
  { id: 'general', label: '通用助手', text: 'You are a helpful, careful AI assistant. Think before answering, state your assumptions when something is ambiguous, and always reply in the language the user writes in.' },
  { id: 'coding', label: '编程助手', text: 'You are a coding agent powered by the {{model}} model. Prefer minimal, surgical changes over rewrites. Read the relevant code first, verify your work with builds or tests, and mention important risks or tradeoffs briefly.' },
  { id: 'concise', label: '简洁模式', text: 'Answer as concisely as possible. Prefer short paragraphs or bullet points, skip filler, and never restate the question. Expand only when the user asks for detail.' },
  { id: 'chinese', label: '中文助手', text: '你是一个专业、严谨的中文 AI 助手。请始终使用简体中文回答；遇到专业术语时保留英文原文，并在首次出现时给出中文解释。' },
  { id: 'translator', label: '翻译专家', text: 'You are a professional translator working between Chinese and English. Translate faithfully, preserve tone, terminology and formatting, and output only the translation unless the user asks for commentary.' },
  { id: 'custom', label: '自定义', text: '', description: '使用下面文本框中的内容作为系统提示词。' }
]

const DEFAULT_SETTINGS = {
  presetId: 'builtin',
  systemPrompt: '',
  backgroundImage: '',
  backgroundOpacity: 0.55,
  backgroundBlur: 0,
  backgroundBlend: 'multiply'
}

let settings = { ...DEFAULT_SETTINGS }

function loadSettings () {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(userDataFile('settings.json'), 'utf8')) }
  } catch {
    settings = { ...DEFAULT_SETTINGS }
  }
  return settings
}

function saveSettings (next) {
  settings = { ...DEFAULT_SETTINGS, ...(next || {}) }
  try {
    const file = userDataFile('settings.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  } catch (error) {
    log('failed to save settings: ' + error)
  }
  return settings
}

/** Optional command-line overrides, used by automated checks. */
function applyCommandLineOverrides () {
  const background = option('background')
  if (background) settings.backgroundImage = background
  const prompt = option('prompt')
  if (prompt) {
    settings.systemPrompt = prompt
    settings.presetId = 'custom'
  }
}

// ---------------------------------------------------------------------------
// Prompt patch
// ---------------------------------------------------------------------------

/**
 * Translate the configured system prompt into a dsh loader patch overlay.
 * The overlay targets the system-prompt plugin by id and replaces the
 * deployment persona prefix. Returns the patch path, or null when the user
 * keeps the built-in persona.
 */
function writePromptPatch () {
  const text = String(settings.systemPrompt || '').trim()
  const patchFile = userDataFile('prompt-patch.yml')
  if (!text) {
    try { fs.rmSync(patchFile, { force: true }) } catch { /* ignore */ }
    return null
  }
  const body =
    '# Generated by the DeepSeek Harness desktop shell from the Settings dialog.\n' +
    '# Edit the prompt in the application, not here: this file is rewritten on save.\n' +
    '- id: system-prompt\n' +
    '  config:\n' +
    '    personaPrefix: ' + JSON.stringify(text) + '\n'
  try {
    fs.mkdirSync(path.dirname(patchFile), { recursive: true })
    fs.writeFileSync(patchFile, body, 'utf8')
    return patchFile
  } catch (error) {
    log('failed to write prompt patch: ' + error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

function killServer () {
  const child = serverProcess
  serverProcess = null
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  log('stopping host process ' + child.pid)
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    } else {
      child.kill('SIGTERM')
    }
  } catch (error) {
    log('failed to stop host: ' + error)
  }
}

function bootServer () {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(NODE_EXE)) {
      reject(new Error('Bundled Node.js runtime not found at:\n' + NODE_EXE))
      return
    }
    if (!fs.existsSync(DSH_BIN)) {
      reject(new Error('Bundled DeepSeek Harness runtime not found at:\n' + DSH_BIN))
      return
    }

    const port = option('port') || process.env.DSH_DESKTOP_PORT || '0'
    lastPort = port
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const home = option('home') || process.env.DSH_HOME
    if (home) env.DSH_HOME = home

    // Launcher flags must precede the app's own flags: the first token the
    // launcher does not recognize starts the inner argument list.
    const patch = writePromptPatch()
    const args = [DSH_BIN, 'web']
    if (patch) args.push('--patch', patch)
    args.push('--no-open', '--port', String(port))

    log('booting host: "' + NODE_EXE + '" ' + args.map(a => (a.includes(' ') ? '"' + a + '"' : a)).join(' '))
    log('runtime dir: ' + RUNTIME_DIR)
    log('DSH_HOME: ' + (env.DSH_HOME || '(default)'))
    if (patch) log('prompt patch: ' + patch)

    let child
    try {
      child = spawn(NODE_EXE, args, {
        cwd: RUNTIME_DIR,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }
    serverProcess = child
    log('host process started, pid ' + child.pid)

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killServer()
      reject(new Error('The DeepSeek Harness host did not become ready within ' + (BOOT_TIMEOUT_MS / 1000) + ' seconds.'))
    }, BOOT_TIMEOUT_MS)

    // The host may split its banner across several pipe writes, so match
    // against the accumulated output rather than a single chunk.
    let banner = ''
    const onData = (chunk) => {
      appendServerLog(chunk)
      if (settled) return
      banner += chunk.toString()
      if (banner.length > 65536) banner = banner.slice(-65536)
      const match = URL_PATTERN.exec(banner)
      if (match) {
        settled = true
        clearTimeout(timer)
        serverUrl = match[1]
        log('host ready: ' + serverUrl)
        resolve(serverUrl)
      }
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    child.on('error', (error) => {
      log('host spawn error: ' + error)
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('exit', (code, signal) => {
      serverProcess = null
      log('host exited code=' + code + ' signal=' + signal)
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('The DeepSeek Harness host exited during startup (code ' + code + ', signal ' + signal + ').'))
        return
      }
      if (!quitting && !SMOKE) {
        dialog.showErrorBox(PRODUCT + ' backend stopped', 'The background host process exited unexpectedly.\n\n' + bootTail(20))
        app.exit(1)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Background image
// ---------------------------------------------------------------------------

/**
 * The rendered page is served over http://127.0.0.1, so a file:// background
 * would be blocked by Chromium. The image is decoded once with nativeImage,
 * downscaled to a sane width and embedded as a data URL instead.
 */
function backgroundDataUrl () {
  const file = settings.backgroundImage
  if (!file || !fs.existsSync(file)) return null
  let stamp = ''
  try { stamp = String(fs.statSync(file).mtimeMs) } catch { stamp = '0' }
  const key = file + '|' + stamp
  if (backgroundCache.key === key) return backgroundCache.dataUrl
  let dataUrl = null
  try {
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) {
      const size = image.getSize()
      const scaled = size.width > 2560 ? image.resize({ width: 2560, quality: 'good' }) : image
      const jpeg = scaled.toJPEG(88)
      dataUrl = jpeg && jpeg.length ? 'data:image/jpeg;base64,' + jpeg.toString('base64') : scaled.toDataURL()
    }
  } catch (error) {
    log('failed to decode background image: ' + error)
  }
  backgroundCache = { key, dataUrl }
  return dataUrl
}

function backgroundLayerCss () {
  const dataUrl = backgroundDataUrl()
  if (!dataUrl) return null
  const opacity = Math.min(1, Math.max(0, Number(settings.backgroundOpacity)))
  const blur = Math.max(0, Number(settings.backgroundBlur) || 0)
  return [
    'html, body { background: transparent !important; }',
    '#root { background: transparent !important; position: relative; z-index: 1; }',
    ':root { --dsw-alias-bg-base: transparent !important; }',
    '#' + BG_LAYER_ID + ' {',
    '  position: fixed; inset: 0; z-index: 0; pointer-events: none;',
    '  background-image: url("' + dataUrl + '");',
    '  background-size: cover; background-position: center center; background-repeat: no-repeat;',
    '  opacity: ' + opacity + ';',
    blur > 0 ? '  filter: blur(' + blur + 'px); transform: scale(1.06);' : '',
    '}'
  ].join('\n')
}

function clamp01 (value, fallback) {
  const n = Number(value)
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : fallback))
}

/**
 * The page has no CSP, but file:// subresources are blocked from an http
 * origin, and the application paints several opaque surfaces with literal
 * colors, so neither a file URL nor variable overrides can show through.
 * The picture is therefore decoded once, embedded as a data URL and painted as
 * a full-window layer on top of the UI with a blend mode: the dark text keeps
 * its contrast while the whole window takes on the picture's colors.
 */
function backgroundLayerCss () {
  const dataUrl = backgroundDataUrl()
  if (!dataUrl) return null
  const opacity = clamp01(settings.backgroundOpacity, 0.55)
  const blur = Math.max(0, Number(settings.backgroundBlur) || 0)
  const blend = String(settings.backgroundBlend || 'multiply').replace(/[^a-z-]/g, '')
  return [
    '#' + BG_LAYER_ID + ' {',
    '  position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;',
    '  background-image: url("' + dataUrl + '");',
    '  background-size: cover; background-position: center center; background-repeat: no-repeat;',
    '  opacity: ' + opacity + ';',
    '  mix-blend-mode: ' + (blend || 'multiply') + ';',
    blur > 0 ? '  filter: blur(' + blur + 'px); transform: scale(1.06);' : '',
    '}'
  ].join('\n')
}

async function applyBackground () {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const contents = win.webContents
  if (backgroundCssKey) {
    try { await contents.removeInsertedCSS(backgroundCssKey) } catch { /* ignore */ }
    backgroundCssKey = null
  }
  try {
    await contents.executeJavaScript(
      '(() => { const old = document.getElementById(' + JSON.stringify(BG_LAYER_ID) + '); if (old) old.remove(); return true })()',
      true
    )
  } catch { /* page may not be ready */ }
  const css = backgroundLayerCss()
  if (!css) return
  try {
    backgroundCssKey = await contents.insertCSS(css)
    await contents.executeJavaScript(
      '(() => { const layer = document.createElement("div"); layer.id = ' + JSON.stringify(BG_LAYER_ID) +
        '; document.body.appendChild(layer); return true })()',
      true
    )
    log('background applied (opacity=' + settings.backgroundOpacity + ', blur=' + settings.backgroundBlur + ', blend=' + settings.backgroundBlend + ')')
  } catch (error) {
    log('failed to apply background: ' + error)
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createWindow () {
  const iconPath = path.join(APP_DIR, 'build', 'icon.png')
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0e14',
    title: PRODUCT,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-fail-load', (event, code, description, url) => {
    log('did-fail-load code=' + code + ' ' + description + ' url=' + url)
  })
  win.webContents.on('render-process-gone', (event, details) => {
    log('render-process-gone ' + JSON.stringify(details))
  })
  win.webContents.on('did-finish-load', () => {
    const url = win.webContents.getURL()
    log('did-finish-load url=' + url)
    if (/^https?:\/\/127\.0\.0\.1/.test(url)) setTimeout(() => { applyBackground() }, 80)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('closed', () => { mainWindow = null })

  mainWindow = win
  return win
}

function createSettingsWindow () {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return settingsWindow
  }
  const win = new BrowserWindow({
    width: 840,
    height: 800,
    minWidth: 700,
    minHeight: 620,
    parent: mainWindow || undefined,
    show: false,
    backgroundColor: '#11141b',
    title: '设置 - ' + PRODUCT,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(APP_DIR, 'settings.html'))
  win.on('closed', () => { settingsWindow = null })
  settingsWindow = win
  return win
}

async function restartBackend () {
  log('restarting host to apply settings')
  killServer()
  serverUrl = null
  const url = await bootServer()
  if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url)
  return url
}

function registerIpc () {
  ipcMain.handle('dsh:get-settings', () => ({
    settings,
    presets: DEFAULT_PROMPTS,
    version: app.getVersion(),
    runtimeDir: RUNTIME_DIR,
    packaged: PACKAGED
  }))

  ipcMain.handle('dsh:save-settings', (event, next) => saveSettings(next))

  ipcMain.handle('dsh:pick-background', async () => {
    const result = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      title: '选择背景图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dsh:apply', async (event, next) => {
    const beforePrompt = settings.systemPrompt
    const beforeBackground = settings.backgroundImage
    saveSettings(next)
    if (settings.backgroundImage !== beforeBackground) backgroundCache = { key: '', dataUrl: null }
    const promptChanged = String(settings.systemPrompt || '') !== String(beforePrompt || '')
    if (promptChanged) {
      try {
        await restartBackend()
      } catch (error) {
        log('restart failed: ' + error)
        return { ok: false, error: String((error && error.message) || error) }
      }
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      await applyBackground()
    }
    return { ok: true, restarted: promptChanged }
  })

  ipcMain.handle('dsh:close-settings', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
    return true
  })
}

function buildMenu () {
  const zh = String(app.getLocale() || '').toLowerCase().startsWith('zh')
  const t = (en, cn) => (zh ? cn : en)
  const template = [
    {
      label: t('File', '文件'),
      submenu: [
        { label: t('Settings...', '设置...'), accelerator: 'CmdOrCtrl+,', click: () => createSettingsWindow() },
        { type: 'separator' },
        { label: t('Open in Browser', '在浏览器中打开'), accelerator: 'CmdOrCtrl+Shift+O', click: () => { if (serverUrl) shell.openExternal(serverUrl) } },
        { label: t('Open Data Folder', '打开数据目录'), click: () => { shell.openPath(app.getPath('userData')) } },
        { type: 'separator' },
        { role: 'quit', label: t('Exit', '退出') }
      ]
    },
    {
      label: t('View', '视图'),
      submenu: [
        { role: 'reload', label: t('Reload', '重新加载') },
        { role: 'forceReload', label: t('Force Reload', '强制重新加载') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('Actual Size', '实际大小') },
        { role: 'zoomIn', label: t('Zoom In', '放大') },
        { role: 'zoomOut', label: t('Zoom Out', '缩小') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('Toggle Full Screen', '全屏切换') },
        { role: 'toggleDevTools', label: t('Toggle Developer Tools', '开发者工具') }
      ]
    },
    {
      label: t('Help', '帮助'),
      submenu: [
        {
          label: t('About', '关于'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('About', '关于') + ' ' + PRODUCT,
              message: PRODUCT,
              detail: [
                'Standalone desktop build of DeepSeek Harness.',
                'Electron: ' + process.versions.electron,
                'Chromium: ' + process.versions.chrome,
                'Node (shell): ' + process.versions.node,
                'Bundled runtime: ' + RUNTIME_DIR,
                'Port: ' + (lastPort === null ? '-' : lastPort)
              ].join('\n'),
              buttons: ['OK']
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.setAppUserModelId('ai.deepseek.harness.standalone')

  app.whenReady().then(async () => {
    openLog()
    log('--- shell start (packaged=' + PACKAGED + ', smoke=' + SMOKE + ') ---')
    loadSettings()
    applyCommandLineOverrides()
    registerIpc()
    buildMenu()
    const win = createWindow()
    win.loadFile(path.join(APP_DIR, 'loading.html'))

    try {
      const url = await bootServer()
      if (!mainWindow) return
      await mainWindow.loadURL(url)
      log('main document loaded')
      await applyBackground()
      if (SMOKE) {
        await new Promise((resolve) => setTimeout(resolve, 8000))
        const target = option('screenshot') || path.join(APP_DIR, 'smoke.png')
        const image = await mainWindow.webContents.capturePage()
        fs.writeFileSync(target, image.toPNG())
        const title = await mainWindow.webContents.executeJavaScript('document.title')
        log('SMOKE OK title=' + JSON.stringify(title) + ' screenshot=' + target)
        const settingsShot = option('settings-shot')
        if (settingsShot) {
          const sw = createSettingsWindow()
          await new Promise((resolve) => setTimeout(resolve, 5000))
          const shot = await sw.webContents.capturePage()
          fs.writeFileSync(settingsShot, shot.toPNG())
          log('SETTINGS SHOT ' + settingsShot)
        }
        app.exit(0)
      }
    } catch (error) {
      log('FATAL ' + String((error && error.stack) || error))
      log('boot tail:\n' + bootTail(30))
      if (SMOKE) {
        app.exit(1)
        return
      }
      dialog.showErrorBox(PRODUCT + ' failed to start', String((error && error.message) || error) + '\n\n' + bootTail(25))
      app.exit(1)
    }
  })

  app.on('window-all-closed', () => { app.quit() })
  app.on('before-quit', () => { quitting = true; killServer() })
  app.on('will-quit', () => { quitting = true; killServer() })
}