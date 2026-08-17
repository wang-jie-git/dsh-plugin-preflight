import { checkPeerDeps, checkDualPackage, resolveHostRoot, preflight } from '../src/index.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import assert from 'node:assert'

let passed = 0, failed = 0

function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++ }
  catch(e) { console.log(`  ❌ ${name}: ${e.message}`); failed++ }
}

async function asyncOk(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); passed++ }
  catch(e) { console.log(`  ❌ ${name}: ${e.message}`); failed++ }
}

// Test 1: peerDeps 红线
const peerDir = '/tmp/dsh-preflight-test-peer'
mkdirSync(peerDir, { recursive: true })
writeFileSync(`${peerDir}/package.json`, JSON.stringify({
  name: 'evil-plugin',
  peerDependencies: { '@deepseek-ai/dsh-tools': '^1.0.0', '@deepseek-ai/cordis': '^2.0.0' },
}))
await asyncOk('peerDeps 红线拦截', async () => {
  const r = await checkPeerDeps(peerDir)
  assert.strictEqual(r.ok, false)
  assert.ok(r.errors[0].includes('dsh-tools') && r.errors[0].includes('cordis'))
})

// Test 2: 安全依赖通过
const safeDir = '/tmp/dsh-preflight-test-safe'
mkdirSync(safeDir, { recursive: true })
writeFileSync(`${safeDir}/package.json`, JSON.stringify({
  name: 'safe-plugin',
  dependencies: { 'lodash': '^4.0.0' },
  peerDependencies: { 'react': '^18.0.0' },
}))
await asyncOk('安全依赖通过', async () => {
  const r = await checkPeerDeps(safeDir)
  assert.strictEqual(r.ok, true)
})

// Test 3: 硬依赖核心包
const hardDir = '/tmp/dsh-preflight-test-harddep'
mkdirSync(hardDir, { recursive: true })
writeFileSync(`${hardDir}/package.json`, JSON.stringify({
  name: 'bad-plugin',
  dependencies: { '@deepseek-ai/dsh-agent': '^1.0.0' },
}))
await asyncOk('硬依赖拦截', async () => {
  const r = await checkPeerDeps(hardDir)
  assert.strictEqual(r.ok, false)
})

// Test 4: 宿主定位
ok('宿主定位', () => {
  const root = resolveHostRoot()
  assert.ok(root, '应找到宿主')
})

// Test 5: 双包检查（当前环境已修复）
await asyncOk('双包检查通过（当前环境）', async () => {
  const r = await checkDualPackage(`${process.env.HOME}/.dsh/profiles/web/node_modules`)
  assert.strictEqual(r.ok, true, `不应有物理副本: ${r.errors.join('; ')}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
