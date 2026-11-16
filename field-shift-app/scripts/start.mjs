#!/usr/bin/env node
/**
 * One command for the whole app: `npm start` (or double-click `iniciar.cmd` at the repo root).
 *
 * 1. Installs what is missing: the backend venv (Python 3.11 via uv when available) and node_modules.
 * 2. Picks free ports, starting at 8000 for the backend and 5173 for the front end, so a server
 *    left running elsewhere (an old backend, the old nasa_chall_train/web app) never shadows this one.
 * 3. Starts the backend, waits for /health, then starts Vite pointed at that backend and opens the
 *    browser. Ctrl+C stops both.
 *
 * No dependency beyond Node itself.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND_DIR = path.join(APP_DIR, 'backend')
const VENV_DIR = path.join(BACKEND_DIR, '.venv')
const IS_WINDOWS = process.platform === 'win32'
const VENV_PYTHON = IS_WINDOWS ? path.join(VENV_DIR, 'Scripts', 'python.exe') : path.join(VENV_DIR, 'bin', 'python')
const VITE_BIN = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
const noOpen = process.argv.includes('--no-open')

const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const tag = { app: color('32')('[app]'), api: color('36')('[api]'), web: color('35')('[web]') }
const say = (message) => console.log(`${tag.app} ${message}`)

function fail(message) {
  console.error(`${tag.app} ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: APP_DIR, shell: false, ...options })
  return result.status === 0
}

function findUv() {
  const probe = spawnSync(IS_WINDOWS ? 'where' : 'which', ['uv'], { encoding: 'utf8' })
  if (probe.status === 0) return probe.stdout.split(/\r?\n/)[0].trim()
  if (IS_WINDOWS && process.env.LOCALAPPDATA) {
    const winget = path.join(
      process.env.LOCALAPPDATA,
      'Microsoft', 'WinGet', 'Packages', 'astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe', 'uv.exe',
    )
    if (existsSync(winget)) return winget
  }
  return null
}

/** A Python 3.11 to 3.15 already on the machine, as [command, ...args], or null. */
function findPython() {
  const candidates = IS_WINDOWS
    ? [['py', '-3.15'], ['py', '-3.14'], ['py', '-3.13'], ['py', '-3.12'], ['py', '-3.11'], ['python']]
    : [['python3.15'], ['python3.14'], ['python3.13'], ['python3.12'], ['python3.11'], ['python3']]
  for (const [cmd, ...args] of candidates) {
    const probe = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])'], { encoding: 'utf8' })
    const version = Number(probe.stdout?.trim())
    if (probe.status === 0 && version >= 311 && version <= 315) return [cmd, ...args]
  }
  return null
}

function ensureBackend() {
  if (existsSync(VENV_PYTHON)) return
  say('Primeira execução: criando o ambiente Python do backend (backend/.venv)…')
  const requirements = path.join(BACKEND_DIR, 'requirements.txt')
  const uv = process.env.FIELD_SHIFT_NO_UV ? null : findUv()
  if (uv) {
    // uv downloads Python 3.11 by itself if the machine does not have it.
    if (!run(uv, ['venv', '--python', '3.11', VENV_DIR])) fail('uv venv falhou.')
    if (!run(uv, ['pip', 'install', '--python', VENV_PYTHON, '-r', requirements])) fail('Instalação das dependências do backend falhou.')
    return
  }
  // Without uv, any Python 3.11 to 3.15 will do (both ends checked on 2026-11-15).
  const python = findPython()
  if (!python) {
    fail(
      'Não achei o uv nem um Python entre 3.11 e 3.15. O jeito mais simples é instalar o uv ' +
        '(Windows: winget install astral-sh.uv; macOS/Linux: veja https://docs.astral.sh/uv/) e rodar de novo.',
    )
  }
  const [cmd, ...args] = python
  if (!run(cmd, [...args, '-m', 'venv', VENV_DIR])) fail('Não consegui criar o ambiente Python.')
  if (!run(VENV_PYTHON, ['-m', 'pip', 'install', '-r', requirements])) fail('Instalação das dependências do backend falhou.')
}

function ensureFrontEnd() {
  if (existsSync(VITE_BIN)) return
  say('Primeira execução: instalando as dependências do front-end (npm install)…')
  const npm = IS_WINDOWS ? 'npm.cmd' : 'npm'
  if (!run(npm, ['install'], { shell: IS_WINDOWS })) fail('npm install falhou.')
}

function checkData() {
  const missing = [
    ['climate/enso.json', 'chip do ENSO e sinal climático'],
    ['fieldphase/data/v1/meta.json', 'painel de análise'],
  ].filter(([file]) => !existsSync(path.join(BACKEND_DIR, 'fixtures', file)))
  for (const [file, what] of missing) {
    say(`Aviso: backend/fixtures/${file} não existe; ${what} vai aparecer como indisponível. Veja "Climate pipeline" no README.`)
  }
}

/** True when nothing listens on the port, on IPv4 or IPv6 localhost. */
function portIsFree(port) {
  const tryHost = (host) =>
    new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', (error) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, host)
    })
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((results) => results.every(Boolean))
}

async function freePort(start, label) {
  for (let port = start; port < start + 20; port += 1) {
    if (await portIsFree(port)) {
      if (port !== start) say(`Porta ${start} ocupada por outro processo; o ${label} vai usar a ${port}.`)
      return port
    }
  }
  fail(`Nenhuma porta livre entre ${start} e ${start + 19} para o ${label}.`)
}

const children = []

function prefixed(child, label) {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.log(`${label} ${line}`)
    })
  }
}

function start(command, args, label, env = {}) {
  const child = spawn(command, args, { cwd: APP_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  prefixed(child, label)
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${label} parou (código ${code}). Encerrando o app.`)
      stopAll(code ?? 1)
    }
  })
  children.push(child)
  return child
}

let stopping = false
function stopAll(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode !== null) continue
    // On Windows a plain kill leaves uvicorn's and Vite's own children running; kill the tree.
    if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
  process.exit(code)
}

async function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

async function main() {
  ensureBackend()
  ensureFrontEnd()
  checkData()

  const apiPort = await freePort(8000, 'backend')
  const webPort = await freePort(5173, 'front-end')

  process.on('SIGINT', () => stopAll(0))
  process.on('SIGTERM', () => stopAll(0))

  say(`Iniciando o backend na porta ${apiPort}…`)
  start(VENV_PYTHON, ['-m', 'uvicorn', 'main:app', '--app-dir', BACKEND_DIR, '--host', '127.0.0.1', '--port', String(apiPort)], tag.api)
  if (!(await waitForHealth(apiPort))) {
    console.error(`${tag.api} não respondeu em /health depois de 30 s.`)
    stopAll(1)
  }

  const apiBase = `http://localhost:${apiPort}`
  say(`Backend pronto em ${apiBase}. Iniciando o front-end na porta ${webPort}…`)
  const viteArgs = [VITE_BIN, '--port', String(webPort), '--strictPort']
  if (!noOpen) viteArgs.push('--open')
  start(process.execPath, viteArgs, tag.web, { VITE_API_BASE_URL: apiBase })
  say(`Abra http://localhost:${webPort}  ·  Ctrl+C encerra tudo.`)
}

main().catch((error) => {
  console.error(error)
  stopAll(1)
})
