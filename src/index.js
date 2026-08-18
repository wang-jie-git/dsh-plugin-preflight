/**
 * dsh-plugin-preflight — 插件安装预检闸
 *
 * 设计目标（2026-08-17 双包危害事故后的防复发机制）：
 * dsh 官方（apps/cli/src/plugin.ts）安装是全 pnpm 转发 + 装后 reconcile，零预检；
 * 市场插件（dsh-plugin-marketplace）只有安全护栏（防外部攻击），无插件间冲突检测。
 * 本插件补上「安装前预检」这道闸：
 *   1. 服务名冲突检查（service 已注册冲突 → 加载即挂）
 *   2. peerDependencies 红线（@deepseek-ai/* 核心包 → 双包危害）
 *   3. 双包危害检测（Symbol 分裂 → reading 'prepare'）
 *   4. 配置语法有效性（~/.dsh/cordis.patch.yml 空文件 → 启动崩溃）
 *   5. 插件依赖完整性（patch 中 name: 指向的包未安装 → 启动失败）
 *   6. 干运行启动测试（实际启动 DSH 15s，捕获所有运行时错误）
 *
 * 自动拦截：劫持 /api/marketplace/install 路由，安装完成后验证 + 自动回滚。
 * 手动检查：POST /api/preflight/check { packageDir, dryRun?: true }
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

export const inject = ['webServer']

/** @typedef {{ ok: boolean, warnings: string[], errors: string[], detail: Record<string, any> }} PreflightResult */

// ── 工具函数 ──

/**
 * 读取 package.json（容忍不存在）
 * @param {string} dir
 * @returns {Promise<Record<string, any> | null>}
 */
async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function isSymbolicLink(p) {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

// ── 检查 1：双包危害 ──

/**
 * 从 ~/.npm/_npx/ 中定位宿主（含 @deepseek-ai/dsh 的 npx 缓存目录）
 * 选最近修改的版本，避免多版本共存时误匹配
 * @returns {string | null}
 */
export function resolveHostRoot() {
  const npxDir = join(process.env.HOME ?? '', '.npm', '_npx')
  if (!existsSync(npxDir)) return null
  let best = null
  let bestTime = 0
  for (const entry of readdirSync(npxDir)) {
    const dshPkg = join(npxDir, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(dshPkg)) {
      try {
        const st = statSync(join(npxDir, entry))
        if (st.mtimeMs > bestTime) {
          best = join(npxDir, entry, 'node_modules')
          bestTime = st.mtimeMs
        }
      } catch { /* 跳过无法 stat 的目录 */ }
    }
  }
  return best
}

/**
 * 检查 1：双包危害（核心包物理副本 / Symbol 分裂）
 * @param {string} profileNodeModules profile 的 node_modules 路径
 * @returns {Promise<PreflightResult>}
 */
export async function checkDualPackage(profileNodeModules) {
  const warnings = []
  const errors = []
  const hostRoot = resolveHostRoot()
  if (!hostRoot) {
    return { ok: true, warnings: ['未定位到 dsh 宿主（npx 缓存），跳过双包检查'], errors: [], detail: {} }
  }
  const coreNs = join(profileNodeModules, '@deepseek-ai')
  const topLevel = ['react', 'zod', 'schemastery', 'cosmokit']

  // @deepseek-ai/* 物理副本
  if (existsSync(coreNs)) {
    for (const name of readdirSync(coreNs)) {
      const profDir = join(coreNs, name)
      const hostDir = join(hostRoot, '@deepseek-ai', name)
      let isDir = false
      try { isDir = existsSync(join(profDir, 'package.json')) } catch { /* 忽略 */ }
      if (!isDir) continue
      if (existsSync(join(hostDir, 'package.json')) && !isSymbolicLink(profDir)) {
        const pkg = await readManifest(profDir)
        errors.push(`@deepseek-ai/${name}@${pkg?.version ?? '?'} 是 profile 内的物理副本（应 symlink 指向宿主）`)
      }
    }
  }

  // 顶层关键库物理副本
  for (const name of topLevel) {
    const profDir = join(profileNodeModules, name)
    const hostDir = join(hostRoot, name)
    if (existsSync(join(profDir, 'package.json')) && !isSymbolicLink(profDir) && existsSync(join(hostDir, 'package.json'))) {
      errors.push(`双包危害：${name} 是 profile 内的物理副本（应 symlink 指向宿主）`)
    }
  }

  // Symbol 分裂实测（核心凭证）
  try {
    const script = `
      const { createRequire } = require('module');
      const hostReq = createRequire(${JSON.stringify(hostRoot + '/')});
      const profReq = createRequire(${JSON.stringify(profileNodeModules + '/')});
      const h = hostReq('@deepseek-ai/dsh-tools');
      const p = profReq('@deepseek-ai/dsh-tools');
      process.stdout.write(String(h.TOOL_RUNTIME_SCHEDULER === p.TOOL_RUNTIME_SCHEDULER));
    `
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 }).trim()
    if (out !== 'true') {
      errors.push('TOOL_RUNTIME_SCHEDULER Symbol 分裂 → 会报 reading \'prepare\'')
    }
  } catch (e) {
    warnings.push(`Symbol 实测跳过：${String(e?.message ?? e).slice(0, 120)}`)
  }

  return { ok: errors.length === 0, warnings, errors, detail: { hostRoot } }
}

// ── 检查 2：peerDependencies 红线 ──

/**
 * 检查 2：peerDependencies 指向 @deepseek-ai/* 核心包（装进 profile 触发双包）
 * @param {string} packageDir 待安装插件目录
 * @returns {Promise<PreflightResult>}
 */
export async function checkPeerDeps(packageDir, opts = {}) {
  const warnings = []
  const errors = []
  const pkg = await readManifest(packageDir)
  if (!pkg) return { ok: true, warnings: ['目标不是 node 包（无 package.json）'], errors: [], detail: {} }

  const peers = { ...(pkg.peerDependencies ?? {}) }
  const deps = { ...(pkg.dependencies ?? {}) }

  // 核心包红线列表：默认 10 个 @deepseek-ai/* 核心包，可通过 opts.corePackages 覆盖
  const corePackages = opts.corePackages ?? [
    'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-llm',
    'cordis', 'schemastery', 'dsh-session', 'dsh-skill',
    'dsh-settings', 'dsh-commands',
  ]
  const coreRe = new RegExp(`^@deepseek-ai/(?:${corePackages.join('|')})`)
  const corePeers = Object.keys(peers).filter((k) => coreRe.test(k))
  const coreDeps = Object.keys(deps).filter((k) => coreRe.test(k))

  if (corePeers.length > 0) {
    errors.push(
      `peerDependencies 指向核心包 ${corePeers.join(', ')} — pnpm 默认 auto-install-peers=true 会把 ${corePeers.length} 份副本装进 profile，触发双包危害`,
    )
  }
  if (coreDeps.length > 0) {
    errors.push(`dependencies 硬依赖核心包 ${coreDeps.join(', ')} — 装入后必然产生双实例（Symbol 分裂）`)
  }
  if (corePeers.length === 0 && coreDeps.length === 0 && (Object.keys(peers).length > 0 || Object.keys(deps).length > 0)) {
    warnings.push('依赖数条，未命中核心包红线（本项通过）')
  }
  return {
    ok: errors.length === 0,
    warnings,
    errors,
    detail: { peers: Object.keys(peers), deps: Object.keys(deps) },
  }
}

// ── 检查 3：服务名冲突 ──

/**
 * 检查 3：服务名冲突（inject 的服务名 vs 已启用插件声明的服务）
 * @param {string} packageDir 待安装插件目录
 * @param {string[]} profilePluginDirs 已启用插件目录列表
 * @param {object} [opts]
 * @param {string} [opts.profileDir] profile 目录
 * @returns {Promise<PreflightResult>}
 */
export async function checkServiceConflict(packageDir, profilePluginDirs, opts = {}) {
  const errors = []
  const warnings = []
  const pkg = await readManifest(packageDir)
  if (!pkg) return { ok: true, warnings: ['目标无 package.json，跳过服务冲突检查'], errors: [], detail: {} }

  // 收集待装插件声明的 id
  const declares = new Set()
  const patchFile = pkg.dsh?.bundle?.patch
  if (patchFile) {
    try {
      const patch = await readFile(join(packageDir, patchFile), 'utf8')
      for (const line of patch.split('\n')) {
        const m = /^\s*-\s*id:\s*([\w.-]+)/.exec(line)
        if (m) declares.add(m[1])
      }
    } catch {
      /* patch 读取失败不阻塞 */
    }
  }
  const clientInject = pkg.dsh?.client?.inject ?? []
  for (const s of clientInject) declares.add(`client:${s}`)

  // 收集已注册的 id（三类来源）
  const existing = new Set()

  // 来源 1：profile 级别的 cordis.patch.yml
  const profileDir = opts.profileDir ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'web')
  const profilePatchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(profilePatchFile)) {
    try {
      const content = readFileSync(profilePatchFile, 'utf8')
      for (const line of content.split('\n')) {
        const m = /^\s*-\s*id:\s*([\w.-]+)/.exec(line)
        if (m) existing.add(m[1])
      }
    } catch { /* 忽略 */ }
  }

  // 来源 2：plugins/ 目录下的每个插件
  for (const dir of profilePluginDirs) {
    const ep = await readManifest(dir)
    if (!ep) continue
    existing.add(ep.name)
    if (ep.dsh?.bundle?.patch) {
      try {
        const patch = await readFile(join(dir, ep.dsh.bundle.patch), 'utf8')
        for (const line of patch.split('\n')) {
          const m = /^\s*-\s*id:\s*([\w.-]+)/.exec(line)
          if (m) existing.add(m[1])
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  // 来源 3：profilePatchId
  for (const id of [...existing]) {
    const entryPath = join(profileDir, 'node_modules', id)
    if (existsSync(join(entryPath, 'package.json'))) {
      existing.add(id)
    }
  }

  const conflicts = [...declares].filter((id) => existing.has(id) && !id.startsWith('client:'))
  for (const id of conflicts) {
    errors.push(`服务名冲突：待装插件声明 id "${id}" 已被现有插件注册 — Cordis 会在启动时报 service has been registered`)
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    detail: { declares: [...declares], existingCount: existing.size },
  }
}

// ── 检查 4：配置语法有效性 ──

/**
 * 检查 4：配置语法有效性
 * 验证所有 cordis.patch.yml 文件是合法的 YAML 数组。
 * 使用 js-yaml（Cordis 依赖已安装）做完整解析。
 *
 * 覆盖场景：
 * - ~/.dsh/cordis.patch.yml 为空文件 → 启动崩溃
 * - profile/cordis.patch.yml 语法错误 → 启动崩溃
 * - YAML 解析异常（缩进、类型等）
 *
 * @param {string} profileDir profile 目录
 * @returns {Promise<PreflightResult>}
 */
export async function checkConfigSyntax(profileDir) {
  const warnings = []
  const errors = []
  const detail = {}

  // 候选文件：全局 + profile 级别
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const candidates = [
    { label: '全局', path: join(dshHome, 'cordis.patch.yml') },
    { label: 'Profile', path: join(profileDir, 'cordis.patch.yml') },
  ]

  let yaml
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(join(profileDir, 'noop.js'))
    yaml = req('js-yaml')
  } catch {
    warnings.push('js-yaml 不可用，跳过配置语法检查')
    return { ok: true, warnings, errors, detail: {} }
  }

  for (const { label, path } of candidates) {
    if (!existsSync(path)) {
      detail[path] = { status: 'missing', label }
      continue
    }

    const content = readFileSync(path, 'utf8').trim()

    // 空文件检测
    if (content.length === 0) {
      errors.push(`[${label}] ${path} 是空文件 — DSH 要求顶级 YAML 数组（'[]'），空文件导致解析崩溃`)
      detail[path] = { status: 'empty', label }
      continue
    }

    // 完整 YAML 解析
    try {
      const parsed = yaml.load(content)
      if (!Array.isArray(parsed)) {
        errors.push(`[${label}] ${path} 必须是顶级 YAML 数组（当前类型: ${typeof parsed}）`)
        detail[path] = { status: 'invalid_type', label, type: typeof parsed }
      } else {
        detail[path] = { status: 'ok', label, entries: parsed.length }
      }
    } catch (e) {
      errors.push(`[${label}] ${path} YAML 语法错误: ${e.message}`)
      detail[path] = { status: 'parse_error', label, error: e.message }
    }
  }

  return { ok: errors.length === 0, warnings, errors, detail }
}

// ── 检查 5：插件依赖完整性 ──

/**
 * 检查 5：插件依赖完整性
 * 扫描 profile cordis.patch.yml 中所有 `name:` 条目，
 * 验证对应的 package 在 node_modules 中已安装。
 *
 * 覆盖场景：
 * - dsh-web-ui-all 未安装但配置中引用了 → 启动失败
 * - 任意插件被手动从 node_modules 删除但配置还在 → 启动失败
 *
 * @param {string} profileDir profile 目录
 * @returns {Promise<PreflightResult>}
 */
export async function checkPluginDeps(profileDir) {
  const warnings = []
  const errors = []
  const detail = { missing: [], resolved: [], skipped: [] }

  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchFile)) {
    return { ok: true, warnings: ['profile 无 cordis.patch.yml，跳过插件依赖检查'], errors: [], detail: {} }
  }

  const content = readFileSync(patchFile, 'utf8')
  // 块级解析：按顶层 `- ` 条目切块（与 rollbackPlugin 同逻辑，避免行级正则误命中注释/文档）
  const blocks = []
  let currentBlock = []
  for (const line of content.split('\n')) {
    const isEntryStart = /^\s*-\s/.test(line)
    if (isEntryStart && currentBlock.length > 0) {
      blocks.push(currentBlock)
      currentBlock = [line]
    } else {
      currentBlock.push(line)
    }
  }
  if (currentBlock.length > 0) blocks.push(currentBlock)

  const nameEntries = []
  for (const block of blocks) {
    // 只取条目块的 name 值（跳过纯注释块 / 嵌套 insert 块）
    const nameLine = block.find((l) => /^\s*name:\s*\S/.test(l))
    if (!nameLine) continue
    const m = /^\s*name:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(nameLine)
    if (m) nameEntries.push(m[1] || m[2] || m[3])
  }

  if (nameEntries.length === 0) {
    return { ok: true, warnings: ['cordis.patch.yml 中无 name: 条目，跳过插件依赖检查'], errors: [], detail: {} }
  }

  for (const name of nameEntries) {
    // 相对路径指向 JS 文件（如 ./plugins/xxx/src/index.js）→ 检查文件是否存在
    if (name.startsWith('.')) {
      const resolved = resolve(join(profileDir, name))
      if (existsSync(resolved)) {
        detail.resolved.push(name)
      } else {
        errors.push(`插件 "${name}" 未找到 — ${resolved} 不存在`)
        detail.missing.push(name)
      }
      continue
    }

    // 裸名（无 / 无 @scope）→ Cordis 内置插件或 bundle 内部解析，跳过
    if (!name.includes('/') && !name.startsWith('@')) {
      detail.skipped.push(name)
      continue
    }

    // npm 包名（@scope/name 或 scope/name）→ 检查 node_modules
    const resolved = join(profileDir, 'node_modules', name)
    if (existsSync(join(resolved, 'package.json'))) {
      detail.resolved.push(name)
    } else {
      errors.push(`插件 "${name}" 未安装 — ${resolved} 不存在`)
      detail.missing.push(name)
    }
  }

  if (detail.skipped.length > 0) {
    warnings.push(`跳过 ${detail.skipped.length} 个裸名条目（Cordis 内置解析）: ${detail.skipped.join(', ')}`)
  }

  return { ok: errors.length === 0, warnings, errors, detail }
}

// ── 检查 6：干运行启动测试 ──

/**
 * 检查 6：干运行启动测试
 * 启动 DSH 子进程，捕获 stderr 中的错误，15 秒超时后自动关闭。
 * 最全面的检查——覆盖所有运行时错误（slot API 不兼容、插件加载失败等）。
 *
 * 使用 `--dump-config` 快速验证配置树（无服务器启动），
 * 再短时启动实际服务器捕获运行时错误。
 *
 * 环境变量 DSH_PREFLIGHT_DRY_RUN=1 防止递归启动本插件。
 *
 * @param {string} profileDir profile 目录
 * @returns {Promise<PreflightResult>}
 */
export async function checkDryRun(profileDir, opts = {}) {
  const warnings = []
  const errors = []
  const detail = { steps: [] }

  // 防止递归：如果已经在 dry-run 中，跳过
  if (process.env.DSH_PREFLIGHT_DRY_RUN) {
    return { ok: true, warnings: ['已在 dry-run 中，跳过递归检查'], errors: [], detail: {} }
  }

  const npxBin = 'npx'
  const dshPkg = '@deepseek-ai/dsh'
  const env = { ...process.env, DSH_PREFLIGHT_DRY_RUN: '1' }
  // DSH 运行检测端口（默认 3080），可通过 opts.port 覆盖
  const dshPort = opts.port ?? 3080

  // 步骤 1：--dump-config 快速验证配置树
  detail.steps.push({ name: 'dump-config', status: 'running' })
  try {
    const out = execFileSync(npxBin, ['-y', dshPkg, '--profile', 'web', '--dump-config'], {
      cwd: profileDir,
      encoding: 'utf8',
      timeout: 30000,
      env,
      maxBuffer: 1024 * 1024,
    })
    // 检查输出中是否包含错误
    if (/error|Error|failed|Failed|SyntaxError|TypeError|ReferenceError/.test(out)) {
      errors.push('--dump-config 输出中包含错误:\n' + out.slice(0, 2000))
      detail.steps[detail.steps.length - 1] = { name: 'dump-config', status: 'failed', output: out.slice(0, 500) }
    } else {
      detail.steps[detail.steps.length - 1] = { name: 'dump-config', status: 'passed' }
    }
  } catch (e) {
    errors.push(`配置树验证失败: ${e.message}`)
    detail.steps[detail.steps.length - 1] = { name: 'dump-config', status: 'error', error: e.message }
    // dump-config 失败就不继续了
    return { ok: false, warnings, errors, detail }
  }

  // 步骤 2：短时启动（15 秒），捕获运行时错误
  // 注意：如果主 DSH 已在运行（task-board 文件锁、端口占用），
  // 启动测试会失败。这在安装后自动预检时（DSH 未运行）最有价值。
  // 对于手动 API 调用，检查端口是否已被占用
  detail.steps.push({ name: 'startup', status: 'running' })

  // 检查 DSH 是否已在运行
  let dshRunning = false
  try {
    const resp = await fetch(`http://127.0.0.1:${dshPort}/`)
    if (resp.ok) dshRunning = true
  } catch { /* 无响应，DSH 未运行 */ }

  if (dshRunning) {
    warnings.push('DSH 已在运行中，跳过启动测试（安装后检查时自动启用）')
    detail.steps[detail.steps.length - 1] = { name: 'startup', status: 'skipped', reason: 'DSH 已在运行' }
    return { ok: true, warnings, errors, detail }
  }

  try {
    const child = spawn(npxBin, ['-y', dshPkg, '--profile', 'web', '--port', '0'], {
      cwd: profileDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    })

    /** @type {string[]} */
    const stderrLines = []

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderrLines.push(text)
    })

    // 等待启动或超时
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        // 15 秒到了，不管是否启动完成都 kill
        resolvePromise('timeout')
      }, 15000)

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0 && code !== null) {
          resolvePromise(`exited:${code}`)
        } else {
          resolvePromise('ok')
        }
      })
    })

    // 收集 stderr 中的错误
    const fullStderr = stderrLines.join('')
    const errorPatterns = [
      /Failed to load plugins/i,
      /failed to apply loader/i,
      /requires options\.(key|id)/i,
      /Error:/,
      /SyntaxError:/,
      /TypeError:/,
      /service has been registered/i,
      /Cannot find module/i,
      /not found/i,
    ]

    const foundErrors = []
    for (const pattern of errorPatterns) {
      const match = fullStderr.match(pattern)
      if (match) {
        // 提取上下文行
        const lines = fullStderr.split('\n')
        const errorLine = lines.findIndex((l) => pattern.test(l))
        const context = lines.slice(Math.max(0, errorLine - 1), errorLine + 5).join('\n').slice(0, 500)
        foundErrors.push(`${match[0]} — 上下文:\n${context}`)
      }
    }

    if (foundErrors.length > 0) {
      for (const fe of foundErrors) {
        errors.push(`启动测试发现错误: ${fe}`)
      }
      detail.steps[detail.steps.length - 1] = { name: 'startup', status: 'failed', errors: foundErrors }
    } else if (fullStderr.length > 0) {
      warnings.push(`启动测试 stderr 有输出（非致命）:\n${fullStderr.slice(0, 500)}`)
      detail.steps[detail.steps.length - 1] = { name: 'startup', status: 'warn', stderr: fullStderr.slice(0, 500) }
    } else {
      detail.steps[detail.steps.length - 1] = { name: 'startup', status: 'passed' }
    }

    // 确保子进程被清理
    child.kill()
  } catch (e) {
    errors.push(`启动测试异常: ${e.message}`)
    detail.steps[detail.steps.length - 1] = { name: 'startup', status: 'error', error: e.message }
  }

  return { ok: errors.length === 0, warnings, errors, detail }
}

// ── 综合预检入口 ──

/**
 * 综合预检入口
 * @param {object} opts
 * @param {string} opts.packageDir 待检查的插件目录
 * @param {string} [opts.profileDir] profile 目录（默认 ~/.dsh/profiles/web）
 * @param {boolean} [opts.dryRun] 是否执行干运行启动测试（较慢，但最全面）
 * @returns {Promise<PreflightResult>}
 */
export async function preflight(opts) {
  const profileDir = opts.profileDir ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'web')
  const profileNodeModules = join(profileDir, 'node_modules')
  const profilePluginsDir = join(profileDir, 'plugins')

  // 把 plugins/ 目录扫描成目录数组
  const pluginDirs = []
  if (existsSync(profilePluginsDir)) {
    for (const entry of readdirSync(profilePluginsDir)) {
      const fullPath = join(profilePluginsDir, entry)
      if (existsSync(join(fullPath, 'package.json'))) {
        pluginDirs.push(fullPath)
      }
    }
  }

  const checks = {}
  checks.dualPackage = await checkDualPackage(profileNodeModules)
  checks.peerDeps = await checkPeerDeps(opts.packageDir, { corePackages: opts.corePackages })
  checks.serviceConflict = await checkServiceConflict(opts.packageDir, pluginDirs, { profileDir: opts.profileDir })
  checks.configSyntax = await checkConfigSyntax(profileDir)
  checks.pluginDeps = await checkPluginDeps(profileDir)

  // 干运行检查：可选，需要明确请求
  if (opts.dryRun) {
    checks.dryRun = await checkDryRun(profileDir, { port: opts.port })
  }

  const errors = []
  const warnings = []
  for (const [k, v] of Object.entries(checks)) {
    errors.push(...v.errors.map((e) => `[${k}] ${e}`))
    warnings.push(...v.warnings.map((w) => `[${k}] ${w}`))
  }
  return { ok: errors.length === 0, warnings, errors, checks }
}

// ── 自动劫持：安装后自动预检 ──

/**
 * 通过 repo 名在 profile 中查找已安装的插件目录
 */
function findPluginLocation(repoName, profileDir) {
  const installedFile = join(profileDir, '..', 'marketplace', 'installed.json')
  if (existsSync(installedFile)) {
    try {
      const idx = JSON.parse(readFileSync(installedFile, 'utf8'))
      const key = String(repoName ?? '').toLowerCase()
      const record = idx[key] || idx[repoName]
      if (record?.location) {
        const loc = resolve(join(profileDir, record.location))
        if (existsSync(loc)) return loc
      }
    } catch { /* 忽略 */ }
  }

  const nm = join(profileDir, 'node_modules')
  if (existsSync(nm)) {
    const parts = String(repoName ?? '').split('/')
    const repoBase = parts[1] || parts[0]
    const direct = join(nm, repoBase)
    if (existsSync(join(direct, 'package.json'))) return direct
    if (repoName && repoName.includes('/')) {
      const scoped = join(nm, repoName)
      if (existsSync(join(scoped, 'package.json'))) return scoped
    }
    for (const entry of readdirSync(nm)) {
      const pkgPath = join(nm, entry, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
          const repoUrl = pkg.repository?.url ?? ''
          if (repoUrl.includes(repoName) || repoUrl.includes(repoBase)) {
            return join(nm, entry)
          }
        } catch { /* 忽略 */ }
      }
    }
  }
  return null
}

/**
 * 回滚：删除插件目录 + 从 patch 文件中移除对应条目
 */
async function rollbackPlugin(pluginDir, profileDir, logger) {
  if (!pluginDir || !existsSync(pluginDir)) return false
  let pkgName = ''
  try {
    const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
    pkgName = pkg.name || ''
  } catch { /* 忽略 */ }

  await rm(pluginDir, { recursive: true, force: true }).catch((e) => {
    logger?.warn?.('dsh-plugin-preflight: 回滚删除失败', String(e))
  })

  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    try {
      const content = readFileSync(patchFile, 'utf8')
      const lines = content.split('\n')
      const blocks = []
      let currentBlock = []
      for (const line of lines) {
        const isEntryStart = /^\s*-\s/.test(line)
        if (isEntryStart && currentBlock.length > 0) {
          blocks.push(currentBlock)
          currentBlock = [line]
        } else {
          currentBlock.push(line)
        }
      }
      if (currentBlock.length > 0) blocks.push(currentBlock)

      const filtered = blocks
        .filter((block) => !block.some((l) => l.includes(pkgName)))
        .flat()

      const newContent = filtered.join('\n').replace(/\n{3,}/g, '\n\n')
      await writeFile(patchFile, newContent, 'utf8')
    } catch (e) {
      logger?.warn?.('dsh-plugin-preflight: patch 回滚失败', String(e))
    }
  }

  logger?.info?.(`dsh-plugin-preflight: 已回滚 ${pkgName || pluginDir}`)
  return true
}

/**
 * 劫持 /api/marketplace/install 路由，安装后运行预检 + 自动回滚
 * 返回 cleanup 函数（卸载/HMR 时恢复原始 handler、清除重试 timer）
 * 对应 postmortem「注册=可逆效果」：任何副作用都必须可逆。
 */
function patchMarketplaceRoute(webServer, profileDir, logger, options = {}) {
  const maxRetries = options.maxRetries ?? 20
  const baseDelay = options.baseDelay ?? 200
  const maxDelay = options.maxDelay ?? 30000

  let timer = null
  let restored = false

  const originalHandlerRef = webServer.exact?.get?.('/api/marketplace/install')?.handler

  const cleanup = () => {
    if (restored) return
    restored = true
    if (timer) clearTimeout(timer)
    const route = webServer.exact?.get?.('/api/marketplace/install')
    if (route && route.handler === wrappedHandler) {
      route.handler = originalHandlerRef
    }
  }

  const wrappedHandler = async (req, res) => {
    let statusCode = 200
    let responseData = null
    let responseHeaders = {}

    const origWriteHead = res.writeHead.bind(res)
    const origEnd = res.end.bind(res)

    res.writeHead = (code, ...args) => {
      statusCode = code
      if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        responseHeaders = args[0]
      }
      return res
    }

    res.end = (...args) => {
      if (args[0] !== undefined) responseData = args[0]
    }

    try {
      await originalHandlerRef(req, res)
    } catch (e) {
      logger?.warn?.('dsh-plugin-preflight: 原始 handler 异常', String(e?.message ?? e))
      origWriteHead(500, { 'content-type': 'application/json' })
      origEnd(JSON.stringify({ error: String(e?.message ?? e) }))
      return
    }

    let needPreflight = false
    let repoName = null
    let pluginName = null
    if (statusCode === 200 && responseData) {
      try {
        const body = JSON.parse(responseData.toString('utf8'))
        if (body.status === 'done' && body.type === 'cordis-plugin') {
          needPreflight = true
          repoName = body.repo || null
          pluginName = body.name || null
        }
      } catch { /* 非 JSON 响应不拦截 */ }
    }

    if (needPreflight && repoName) {
      let pluginDir = null
      if (pluginName) {
        pluginDir = join(profileDir, 'node_modules', pluginName)
        if (!existsSync(join(pluginDir, 'package.json'))) pluginDir = null
      }
      if (!pluginDir) pluginDir = findPluginLocation(repoName, profileDir)

      if (pluginDir) {
        // 安装后预检：静态检查 + 干运行（安装后可以做完整的动态检查）
        const result = await preflight({
          packageDir: pluginDir,
          profileDir,
          dryRun: true,
          corePackages: options.corePackages,
        })
        if (!result.ok) {
          const rolledBack = await rollbackPlugin(pluginDir, profileDir, logger)
          origWriteHead(409, { 'content-type': 'application/json' })
          const errorBody = JSON.stringify({
            ok: false,
            blocked: true,
            rolledBack,
            plugin: pluginName || repoName,
            error: '安装预检未通过，已自动回滚',
            details: result.errors,
            warnings: result.warnings,
          })
          origEnd(errorBody)
          return
        }
      } else {
        logger?.warn?.(`dsh-plugin-preflight: 找不到刚安装的插件目录 (${repoName}/${pluginName})，跳过预检`)
      }
    }

    origWriteHead(statusCode, responseHeaders)
    if (responseData !== null) {
      origEnd(responseData)
    } else {
      origEnd()
    }
  }

  const installRoute = webServer.exact?.get?.('/api/marketplace/install')
  if (!installRoute) {
    if (options._retryCount >= maxRetries) {
      logger?.warn?.('dsh-plugin-preflight: 放弃劫持市场路由（超过最大重试次数）')
      return cleanup
    }
    const retryCount = options._retryCount ?? 0
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay)
    timer = setTimeout(() => {
      const innerCleanup = patchMarketplaceRoute(webServer, profileDir, logger, {
        ...options,
        _retryCount: retryCount + 1,
      })
      if (typeof innerCleanup === 'function') innerCleanup()
    }, delay)
    return cleanup
  }

  installRoute.handler = wrappedHandler
  logger?.info?.('dsh-plugin-preflight: 已劫持 /api/marketplace/install — 安装后自动预检 + 回滚')
  return cleanup
}

// ── 宿主端插件主体 ──

/**
 * 插件可调配置（对应 config 设计原则：无硬编码可调参数）
 * 注意：dsh 的 cordis.patch.yml 是浅 patch，嵌套对象需扁平化声明
 * @type {{ hookMarketplace?: boolean, corePackages?: string[], maxRetries?: number, port?: number }}
 */
export const configDefaults = {
  // 是否劫持 /api/marketplace/install（卸载/HMR 时自动恢复原始 handler）
  hookMarketplace: true,
  // 核心包红线列表（默认 10 个 @deepseek-ai/*）
  corePackages: [
    'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-llm',
    'cordis', 'schemastery', 'dsh-session', 'dsh-skill',
    'dsh-settings', 'dsh-commands',
  ],
  maxRetries: 20,
  port: 3080,
}

/**
 * @param {import('...').Context} ctx
 */
export function apply(ctx, cfg = {}) {
  const config = { ...configDefaults, ...cfg }
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  const profileNodeModules = join(profileDir, 'node_modules')

  const webServer = ctx.webServer
  if (!webServer) {
    ctx.logger?.warn?.('dsh-plugin-preflight: webServer 服务不可用，预检闸未启用')
    return
  }

  // 启动时自动巡检：双包危害 + 配置语法 + 插件依赖完整性
  Promise.all([
    checkDualPackage(profileNodeModules),
    checkConfigSyntax(profileDir),
    checkPluginDeps(profileDir),
  ]).then(([dualPackage, configSyntax, pluginDeps]) => {
    const allErrors = [...dualPackage.errors, ...configSyntax.errors, ...pluginDeps.errors]
    const allWarnings = [...dualPackage.warnings, ...configSyntax.warnings, ...pluginDeps.warnings]

    if (allErrors.length > 0) {
      ctx.logger?.warn?.(`dsh-plugin-preflight: 启动巡检发现 ${allErrors.length} 个问题：\n${allErrors.join('\n')}`)
      if (allWarnings.length > 0) {
        ctx.logger?.warn?.(`dsh-plugin-preflight: 警告：\n${allWarnings.join('\n')}`)
      }
    } else {
      ctx.logger?.info?.('dsh-plugin-preflight: 启动预检通过（无冲突、无双包、配置语法正确、依赖完整）')
    }
  }).catch((e) => ctx.logger?.warn?.(`dsh-plugin-preflight: 启动巡检失败 ${String(e)}`))

  // 手动检查 API
  webServer.register({
    kind: 'exact',
    path: '/api/preflight/check',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      }
      try {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const target = body.packageDir

        // 支持全量检查（不传 packageDir 时检查整个 profile）
        const opts = {
          packageDir: target ? resolve(target) : profileDir,
          profileDir,
          dryRun: body.dryRun === true,
          corePackages: config.corePackages,
          port: config.port,
        }

        const r = await preflight(opts)
        res.writeHead(r.ok ? 200 : 409, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
      }
    },
  })

  // 全量巡检 API
  webServer.register({
    kind: 'exact',
    path: '/api/preflight/scan',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      }
      try {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')

        // 全量扫描：检查整个 profile（包括干运行）
        const result = await preflight({
          packageDir: profileDir,
          profileDir,
          dryRun: body.dryRun !== false,
          corePackages: config.corePackages,
          port: config.port,
        })

        res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
      }
    },
  })

  ctx.logger?.info?.('dsh-plugin-preflight: 预检闸已启用 (POST /api/preflight/check, POST /api/preflight/scan)')

  // 自动劫持市场安装路由（effect-based：卸载/HMR 时自动恢复原始 handler，对应 postmortem「注册=可逆效果」）
  if (config.hookMarketplace) {
    ctx.effect(() => {
      let cleanup = null
      let active = true
      process.nextTick(() => {
        if (!active) return
        cleanup = patchMarketplaceRoute(webServer, profileDir, ctx.logger, {
          maxRetries: config.maxRetries,
          corePackages: config.corePackages,
        })
      })
      return () => {
        active = false
        if (cleanup) cleanup()
      }
    })
  }
}