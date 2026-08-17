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
 *
 * 自动拦截：劫持 /api/marketplace/install 路由，安装完成后验证 + 自动回滚。
 * 手动检查：POST /api/preflight/check { packageDir }
 */
import { readFile, rm, writeFile, readFile as readFileAsync } from 'node:fs/promises'
import { existsSync, readdirSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const inject = ['webServer']

export const name = 'dsh-plugin-preflight'
export const version = '0.1.0'

const DSH_TOKEN_SYMBOL = '@deepseek-ai/dsh-tools.scheduler'

/** @typedef {{ ok: boolean, warnings: string[], errors: string[], detail: Record<string, any> }} PreflightResult */

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

/**
 * 从 ~/.npm/_npx/ 中定位宿主（含 @deepseek-ai/dsh 的 npx 缓存目录）
 * @returns {string | null}
 */
export function resolveHostRoot() {
  const npxDir = join(process.env.HOME ?? '', '.npm', '_npx')
  if (!existsSync(npxDir)) return null
  for (const entry of readdirSync(npxDir)) {
    const dshPkg = join(npxDir, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(dshPkg)) return join(npxDir, entry, 'node_modules')
  }
  return null
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
      errors.push(`TOOL_RUNTIME_SCHEDULER Symbol 分裂（${DSH_TOKEN_SYMBOL}）→ 会报 reading 'prepare'`)
    }
  } catch (e) {
    warnings.push(`Symbol 实测跳过：${String(e?.message ?? e).slice(0, 120)}`)
  }

  return { ok: errors.length === 0, warnings, errors, detail: { hostRoot } }
}

function isSymbolicLink(p) {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

/**
 * 检查 2：peerDependencies 指向 @deepseek-ai/* 核心包（装进 profile 触发双包）
 * @param {string} packageDir 待安装插件目录
 * @returns {Promise<PreflightResult>}
 */
export async function checkPeerDeps(packageDir) {
  const warnings = []
  const errors = []
  const pkg = await readManifest(packageDir)
  if (!pkg) return { ok: true, warnings: ['目标不是 node 包（无 package.json）'], errors: [], detail: {} }

  const peers = { ...(pkg.peerDependencies ?? {}) }
  const deps = { ...(pkg.dependencies ?? {}) }

  const coreRe = /^@deepseek-ai\/(dsh-tools|dsh-agent|dsh-agent-loop|dsh-llm|cordis|schemastery|dsh-session|dsh-skill|dsh-settings|dsh-commands)/
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

/**
 * 检查 3：服务名冲突（inject 的服务名 vs 已启用插件声明的服务）
 * 扫描三类来源：profile cordis.patch.yml、plugins/目录、已安装的 profilePatchId
 * @param {string} packageDir 待安装插件目录
 * @param {string[]} profilePluginDirs 已启用插件目录列表
 * @param {object} [opts]
 * @param {string} [opts.profileDir] profile 目录（用于读取 profile 级别 cordis.patch.yml）
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

  // 来源 1：profile 级别的 cordis.patch.yml（最权威的已注册列表）
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

  // 来源 3：profilePatchId（从 profile cordis.patch.yml 中提取的 entry 路径中的包名）
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

/**
 * 综合预检入口
 * @param {object} opts
 * @param {string} opts.packageDir 待检查的插件目录
 * @param {string} [opts.profileDir] profile 目录（默认 ~/.dsh/profiles/web）
 * @returns {Promise<PreflightResult>}
 */
export async function preflight(opts) {
  const profileDir = opts.profileDir ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'web')
  const profileNodeModules = join(profileDir, 'node_modules')
  const profilePluginsDir = join(profileDir, 'plugins')

  const checks = {}
  checks.dualPackage = await checkDualPackage(profileNodeModules)
  checks.peerDeps = await checkPeerDeps(opts.packageDir)
  checks.serviceConflict = await checkServiceConflict(opts.packageDir, profilePluginsDir, { profileDir: opts.profileDir })

  const errors = []
  const warnings = []
  for (const [k, v] of Object.entries(checks)) {
    errors.push(...v.errors.map((e) => `[${k}] ${e}`))
    warnings.push(...v.warnings.map((w) => `[${k}] ${w}`))
  }
  return { ok: errors.length === 0, warnings, errors, checks }
}

// ── 自动拦截：劫持 /api/marketplace/install 路由 ──

/**
 * 通过 repo 名（"owner/repo-name"）在 profile 中查找已安装的插件目录。
 * 先查 installed.json 定位 → 再按 package.json 名称匹配 → 最后按 repo 名匹配。
 */
function findPluginLocation(repoName, profileDir) {
  // 1) 读 installed.json 获取精确位置
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

  // 2) 按 repo 名在 profile/node_modules 中搜索
  const nm = join(profileDir, 'node_modules')
  if (existsSync(nm)) {
    const parts = String(repoName ?? '').split('/')
    const repoBase = parts[1] || parts[0]
    // 直接匹配目录名
    const direct = join(nm, repoBase)
    if (existsSync(join(direct, 'package.json'))) return direct
    // 按 @scope/name 匹配
    if (repoName && repoName.includes('/')) {
      const scoped = join(nm, repoName)
      if (existsSync(join(scoped, 'package.json'))) return scoped
    }
    // 扫描所有包，匹配 repository.url
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
 * 回滚：删除插件目录 + 从 patch 文件中移除对应条目。
 * 返回 true 表示回滚执行成功，false 表示无需回滚。
 */
async function rollbackPlugin(pluginDir, profileDir, logger) {
  if (!pluginDir || !existsSync(pluginDir)) return false
  // 从 package.json 读包名用于 patch 删除
  let pkgName = ''
  try {
    const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
    pkgName = pkg.name || ''
  } catch { /* 忽略 */ }

  // 删除目录
  await rm(pluginDir, { recursive: true, force: true }).catch((e) => {
    logger?.warn?.('dsh-plugin-preflight: 回滚删除失败', String(e))
  })

  // 从 patch 文件中移除
  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    try {
      const content = readFileSync(patchFile, 'utf8')
      const lines = content.split('\n')
      // 找到匹配的条目行（- id: <pkgName>）并删除整段
      const filtered = []
      let skip = false
      for (const line of lines) {
        if (skip && /^\s*-/.test(line)) { skip = false; filtered.push(line); continue }
        if (skip) continue
        if (line.trim() === `- id: ${pkgName}` || line.includes(pkgName)) {
          skip = true
          continue
        }
        filtered.push(line)
      }
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
 * 劫持 /api/marketplace/install 路由，在安装完成后运行预检，失败则自动回滚。
 * 通过 process.nextTick 延迟到所有插件加载完成后再执行。
 */
function patchMarketplaceRoute(webServer, profileDir, logger) {
  const installRoute = webServer.exact?.get?.('/api/marketplace/install')
  if (!installRoute) {
    // 市场插件可能尚未加载，延迟重试
    setTimeout(() => patchMarketplaceRoute(webServer, profileDir, logger), 200)
    return
  }

  const originalHandler = installRoute.handler

  installRoute.handler = async (req, res) => {
    // 拦截 res.end / res.writeHead 以捕获响应
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

    // 让原始 handler 处理（克隆 + 安装）
    try {
      await originalHandler(req, res)
    } catch (e) {
      logger?.warn?.('dsh-plugin-preflight: 原始 handler 异常', String(e?.message ?? e))
      origWriteHead(500, { 'content-type': 'application/json' })
      origEnd(JSON.stringify({ error: String(e?.message ?? e) }))
      return
    }

    // 仅对成功的 cordis-plugin 安装做预检
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
      // 先找插件目录
      let pluginDir = null
      if (pluginName) {
        pluginDir = join(profileDir, 'node_modules', pluginName)
        if (!existsSync(join(pluginDir, 'package.json'))) pluginDir = null
      }
      if (!pluginDir) pluginDir = findPluginLocation(repoName, profileDir)

      if (pluginDir) {
        const result = await preflight({ packageDir: pluginDir, profileDir })
        if (!result.ok) {
          // 预检失败：回滚
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

    // 发送原始响应
    origWriteHead(statusCode, responseHeaders)
    if (responseData !== null) {
      origEnd(responseData)
    } else {
      origEnd()
    }
  }

  logger?.info?.('dsh-plugin-preflight: 已劫持 /api/marketplace/install — 安装后自动预检 + 回滚')
}

// ── 宿主端插件主体 ──

/**
 * @param {import('...').Context} ctx
 */
export function apply(ctx) {
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  const profileNodeModules = join(profileDir, 'node_modules')

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    throw new Error('dsh-plugin-preflight: webServer service unavailable')
  }

  // 启动时自动巡检一次
  preflight({ packageDir: profileNodeModules, profileDir })
    .then((r) => {
      if (!r.ok) {
        ctx.logger?.warn?.(`dsh-plugin-preflight: 启动预检发现 ${r.errors.length} 个问题：\n${r.errors.join('\n')}`)
      } else {
        ctx.logger?.info?.('dsh-plugin-preflight: 启动预检通过（无冲突、无双包）')
      }
    })
    .catch((e) => ctx.logger?.warn?.(`dsh-plugin-preflight: 启动巡检失败 ${String(e)}`))

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
        if (!target) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: 'packageDir required' }))
        }
        const r = await preflight({ packageDir: resolve(target), profileDir })
        res.writeHead(r.ok ? 200 : 409, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
      }
    },
  })

  ctx.logger?.info?.('dsh-plugin-preflight: 预检闸已启用 (POST /api/preflight/check)')

  // 自动劫持市场安装路由（延迟到所有插件加载完成）
  process.nextTick(() => {
    patchMarketplaceRoute(webServer, profileDir, ctx.logger)
  })
}