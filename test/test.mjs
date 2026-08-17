import { test } from 'node:test'
import assert from 'node:assert'
import { checkPeerDeps, checkDualPackage, resolveHostRoot } from '../src/index.js'

test('checkPeerDeps: 核心包 peerDependency 应报错', async () => {
  // 模拟一个恶意插件 package.json
  const tmpDir = '/tmp/dsh-preflight-test-peer'
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(`${tmpDir}/package.json`, JSON.stringify({
    name: 'evil-plugin',
    peerDependencies: {
      '@deepseek-ai/dsh-tools': '^1.0.0',
      '@deepseek-ai/cordis': '^2.0.0',
    },
  }))
  const r = await checkPeerDeps(tmpDir)
  assert.strictEqual(r.ok, false, '应拦截核心包 peerDep')
  assert.ok(r.errors.length >= 1, `应报红线错误，实际 ${r.errors.length}`)
  assert.ok(r.errors[0].includes('dsh-tools') && r.errors[0].includes('cordis'), '应包含两个核心包名')
  console.log('  ✅ peerDeps 红线:', r.errors.join('; '))
})

test('checkPeerDeps: 无关依赖应通过', async () => {
  const tmpDir = '/tmp/dsh-preflight-test-safe'
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(`${tmpDir}/package.json`, JSON.stringify({
    name: 'safe-plugin',
    dependencies: { 'lodash': '^4.0.0' },
    peerDependencies: { 'react': '^18.0.0' },
  }))
  const r = await checkPeerDeps(tmpDir)
  assert.strictEqual(r.ok, true, '无关依赖应通过')
  console.log('  ✅ 安全依赖通过')
})

test('checkPeerDeps: 硬依赖核心包应报错', async () => {
  const tmpDir = '/tmp/dsh-preflight-test-harddep'
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(`${tmpDir}/package.json`, JSON.stringify({
    name: 'bad-plugin',
    dependencies: { '@deepseek-ai/dsh-agent': '^1.0.0' },
  }))
  const r = await checkPeerDeps(tmpDir)
  assert.strictEqual(r.ok, false, '硬依赖核心包应报错')
  console.log('  ✅ 硬依赖拦截:', r.errors[0])
})

test('resolveHostRoot: 应定位到宿主', () => {
  const root = resolveHostRoot()
  assert.ok(root, '应找到宿主目录')
  console.log('  ✅ 宿主:', root)
})

test('checkDualPackage: 当前环境应无物理副本（已修复）', async () => {
  const profileNm = `${process.env.HOME}/.dsh/profiles/web/node_modules`
  const r = await checkDualPackage(profileNm)
  assert.strictEqual(r.ok, true, '当前环境已修复，应无物理副本')
  if (r.warnings.length > 0) console.log('  ⚠️  warnings:', r.warnings.join('; '))
  console.log('  ✅ 双包检查通过（无物理副本）')
})
