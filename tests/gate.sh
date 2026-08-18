#!/bin/sh
# dsh-plugin-preflight 门禁脚本（可分发，供 pre-commit hook / CI / 手动使用）
# 用法: tests/gate.sh [--diff]
#   --diff  : 对比 git 变更增量检查（提交前推荐）
#   无参数  : quick 检查修改文件
# 任一项失败 → 非零退出

set -u

echo ""
echo "🧪 [gate] dsh-plugin-preflight 提交门禁"
echo "══════════════════════════════════════"

FAIL=0

# 1. 语法检查
echo "── [1/5] 语法检查 (node --check) ──"
for f in $(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep '\.js$'); do
  if ! node --check "$f" 2>/tmp/gate-err; then
    echo "❌ 语法错误: $f"
    cat /tmp/gate-err
    FAIL=1
  fi
done
[ "$FAIL" = "0" ] && echo "   ✅ 语法检查通过"
echo ""

# 2. 测试套件
echo "── [2/5] 测试套件 (node --test) ──"
TEST_OUTPUT=$(node --test test/test.mjs 2>&1 || true)
if echo "$TEST_OUTPUT" | grep -qE "ℹ fail [1-9]"; then
  echo "❌ 测试套件失败:"
  echo "$TEST_OUTPUT" | grep -E "✖|fail" | head -20
  FAIL=1
else
  echo "   ✅ 测试通过"
fi
echo ""

# 3. 语法 + 模拟 ctx 冒烟
echo "── [3/5] 模拟 ctx 冒烟 (apply 可注册) ──"
if node --input-type=module -e "
import { apply, configDefaults } from './src/index.js'
import assert from 'node:assert'
assert.equal(typeof apply, 'function', 'apply 应为函数')
assert.equal(typeof configDefaults.corePackages, 'object', 'configDefaults.corePackages 应为数组')
console.log('   ✅ apply/configDefaults 导出正常，核心包数=' + configDefaults.corePackages.length)
" 2>/tmp/gate-smoke; then
  :
else
  echo "❌ 冒烟失败:"
  cat /tmp/gate-smoke
  FAIL=1
fi
echo ""

# 4. moat 护城河（密钥/依赖/未使用导出）
echo "── [4/5] moat check ──"
if [ "${1:-}" = "--diff" ]; then
  MOAT_OUTPUT=$(timeout 90 moat check --diff 2>&1 || true)
else
  MOAT_OUTPUT=$(timeout 60 moat check 2>&1 || true)
fi
if echo "$MOAT_OUTPUT" | grep -qE "失败: [1-9]|FAILED|✖"; then
  echo "❌ moat 门禁失败:"
  echo "$MOAT_OUTPUT" | tail -20
  FAIL=1
else
  echo "   ✅ moat 通过"
fi
echo ""

# 5. moat preflight JS 影响域（moat v1.7.18+ 支持 JS/TS 解析）
echo "── [5/5] moat preflight（JS 函数影响域）──"
if git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -qE '\.(js|ts|tsx)$'; then
  PREFLIGHT_OUTPUT=$(timeout 60 moat preflight --files $(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts|tsx)$' | head -5 | tr '\n' ' ') --project . 2>&1 || true)
  if echo "$PREFLIGHT_OUTPUT" | grep -qE "CRITICAL: [1-9]|HIGH: [1-9]"; then
    echo "❌ preflight 发现高危变更:"
    echo "$PREFLIGHT_OUTPUT" | grep -B1 -A3 "CRITICAL\|HIGH" | head -30
    FAIL=1
  else
    echo "   ✅ preflight 通过（$(echo "$PREFLIGHT_OUTPUT" | grep -E '发现 [0-9]+ 个函数' | head -1 || echo '无高危')）"
  fi
else
  echo "   ✅ 无 JS/TS 变更，跳过"
fi
echo ""

echo "══════════════════════════════════════"
if [ "$FAIL" = "0" ]; then
  echo "✅ [gate] 全部通过，允许提交"
  exit 0
else
  echo "❌ [gate] 存在失败项，阻止提交 (跳过: git commit --no-verify)"
  exit 1
fi