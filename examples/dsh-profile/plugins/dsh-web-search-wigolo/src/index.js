/**
 * dsh-web-search-wigolo — Wigolo search/fetch provider for DSH
 *
 * Registers the local wigolo MCP server as a native DSH web search provider
 * and fetch provider, so the `dsh-tool-web`'s search_web/fetch_page tools
 * use wigolo as their backend — free, keyless, local-first.
 *
 * communicates via `wigolo search <query>` and `wigolo fetch <url>` stdio.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const inject = ['web']
export const name = 'dsh-web-search-wigolo'
export const version = '0.1.0'

const WIGOLO_PROVIDER_ID = 'wigolo'

/** wigolo 二进制路径（缓存） */
let _wigoloBin = null

/**
 * 定位 wigolo 二进制：优先 profile 的 node_modules，fallback 到 PATH
 */
function resolveWigoloBin() {
  if (_wigoloBin) return _wigoloBin

  // 尝试 profile 的 node_modules/.bin/wigolo
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const profileBin = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'wigolo')
  if (existsSync(profileBin)) {
    _wigoloBin = profileBin
    return _wigoloBin
  }

  // 尝试全局 wigolo
  const globalBin = '/Users/mac/.npm-global/bin/wigolo'
  if (existsSync(globalBin)) {
    _wigoloBin = globalBin
    return _wigoloBin
  }

  // fallback 到 PATH
  _wigoloBin = 'wigolo'
  return _wigoloBin
}

/**
 * 适配 wigolo search JSON 输出 → DSH WebSearchResult
 * wigolo search --json: { results: [{ url, title, content, published }], ... }
 */
function adaptSearchResult(wigoloJson) {
  const sources = (wigoloJson.results ?? []).map((r) => ({
    url: r.url ?? '',
    title: r.title ?? '',
    snippet: (r.snippet ?? r.content_from_snippet ?? r.content ?? '').slice(0, 500),
    publishedAt: r.published_date ?? r.published ?? undefined,
  }))
  return { sources, truncated: false }
}

/**
 * 适配 wigolo fetch JSON 输出 → DSH WebFetchResult
 * wigolo fetch --json: { url, content, statusCode, contentType }
 */
function adaptFetchResult(wigoloJson, requestUrl) {
  const statusCode = wigoloJson.http_status ?? wigoloJson.statusCode ?? 200
  const content = wigoloJson.markdown ?? wigoloJson.content ?? ''
  const contentType = wigoloJson.contentType ?? wigoloJson.metadata?.contentType ?? ''
  const isHtml = contentType.includes('html') || content.includes('<html')
  return {
    url: wigoloJson.url ?? requestUrl,
    statusCode,
    body: { kind: isHtml ? 'html' : 'text', content },
    truncated: false,
  }
}

/**
 * 执行 wigolo CLI 工具，返回解析后的 JSON
 */
async function runWigolo(tool, args = []) {
  const bin = resolveWigoloBin()
  const { stdout } = await execFileAsync(bin, [tool, ...args, '--json'], {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/**
 * WebSearchProvider: 通过 wigolo search 搜索
 */
class WigoloSearchProvider {
  id = WIGOLO_PROVIDER_ID

  available() {
    return true
  }

  async search(request, signal) {
    const json = await runWigolo('search', [request.query])
    return adaptSearchResult(json)
  }

  async fetch(request, signal) {
    const json = await runWigolo('fetch', [request.url])
    return adaptFetchResult(json, request.url)
  }
}

/**
 * WebFetchProvider: 通过 wigolo fetch 抓取页面
 */
class WigoloFetchProvider {
  id = WIGOLO_PROVIDER_ID

  available() {
    return true
  }

  async fetch(request, signal) {
    const json = await runWigolo('fetch', [request.url])
    return adaptFetchResult(json, request.url)
  }
}

export function apply(ctx) {
  ctx.web.registerSearchProvider(new WigoloSearchProvider())
  ctx.web.registerFetchProvider(new WigoloFetchProvider())
  ctx.logger?.info?.(`dsh-web-search-wigolo: 已注册搜索提供商 "${WIGOLO_PROVIDER_ID}"`)
}

// Exported for unit testing (behavior-neutral; used by test/adapters.test.mjs).
export { adaptSearchResult, adaptFetchResult }