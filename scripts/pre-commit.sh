#!/usr/bin/env bash
# pre-commit 快门禁（秒级）：crapper + dryer 只看 git 变更的 src 文件。
# 完整门禁（build + 测试 + LCOV + 定向 CRAP + 全树 DRY）：bash scripts/gate.sh
#
# 激活（本地一次性，git 配置不进仓库）：
#   git config core.hooksPath scripts/githooks
#
# 为什么不用工具自带的 --changed（本仓库实测）：
#   crapper 的 --changed 无视随后的路径参数（给了 src/parse.ts 仍会分析
#   lib/parse.js，疑似按 basename 匹配）。本仓库 lib/ 是已提交的构建产物，
#   每次重建都会变 dirty，--changed 必然把 lib/*.js 扫进来；--use-existing-
#   coverage 模式下 lib js 在 LCOV（SF 是 src 路径）里查不到覆盖 → 按 0% 计
#   CRAP=CC²+CC → CC≥3 全军覆没。dryer 的 --changed 倒是遵守路径参数，但为
#   两个工具保持同一机制，统一按 `git status --porcelain -- src` 自选文件，
#   顺带把 CRAP 精确对齐到 gate.sh 的定向范围（parse.ts / lineage-infer.ts /
#   src/geometry，排除无覆盖的 src/index.ts 与 src/client/*，同 docs/gates.md）。
#   空变更 = 两个工具都跳过，直接放行。
#
# CRAP 模式自适应（实测结论）：
#   - target/coverage/typescript/lcov.info 存在，且 src/*.ts 与 lib/*.js 都
#     不比它新 → --use-existing-coverage：读盘上 LCOV 算真实 CRAP，阈值生效。
#   - 否则（无 coverage 或已过期）→ --no-coverage：只打印复杂度报告。
#     crapper 在 --no-coverage 下 CRAP=N/A、threshold 不生效（实测 CC=13 也
#     exit 0），此模式不因复杂度挡提交，CRAP<10 由 gate.sh 兜底。不能在
#     coverage 过期时硬用 --use-existing-coverage：新函数按 0% 覆盖计
#     CRAP=CC²+CC（CC≥3 即 >10），会把没问题的改动假阳挡下（实测）。
#
# dryer 命中重复时 exit 0（非零仅表示用法错误），与 gate.sh 一致按输出里的
# '^DUPLICATE score=' 行判定。注意用 grep … >/dev/null 而非 grep -q：-q 命中
# 即退，大输出时 printf 吃 SIGPIPE，pipefail 下会把"命中"翻成"未命中"。
#
# 口径：porcelain 取的是工作区状态（含未跟踪新文件），比"本次提交的暂存内容"
# 略宽——快门禁管树的状态，比提交本身更严。
#
# 不用 -e 是刻意的：crapper 非零是预期分支（超阈值），要先把两个工具都跑完、
# 各自记下结果，最后统一裁决退出码。
set -uo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

SCRATCH_UB_BIN="/home/columpve/data/hermes/dsh-do/.scratch/ubtools/.venv/bin"

# $1 = env 值（可空），$2 = 工具名；输出解析后的路径，找不到返回非零。
find_tool() {
  local env_val="$1" name="$2"
  if [[ -n "$env_val" ]]; then
    if command -v "$env_val" >/dev/null 2>&1; then command -v "$env_val"; return 0; fi
    return 1
  fi
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  if [[ -x "$SCRATCH_UB_BIN/$name" ]]; then printf '%s\n' "$SCRATCH_UB_BIN/$name"; return 0; fi
  return 1
}

MISSING=0
CRAPPER_BIN="$(find_tool "${CRAPPER:-}" crapper)" || {
  echo 'pre-commit: crapper 未安装，跳过（安装见 docs/gates.md，或 export CRAPPER=<path>）' >&2
  MISSING=1
}
DRYER_BIN="$(find_tool "${DRYER:-}" dryer)" || {
  echo 'pre-commit: dryer 未安装，跳过（安装见 docs/gates.md，或 export DRYER=<path>）' >&2
  MISSING=1
}
if (( MISSING )); then
  echo 'pre-commit: 工具未安装，跳过' >&2
  exit 0
fi

# 收集 src 下变更的 .ts：新增/修改/重命名(取新名)/未跟踪；删除跳过。
# porcelain 输出 "XY path"（X=暂存区 Y=工作区，?? = 未跟踪）。
CRAP_FILES=()
DRY_FILES=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  xy="${line:0:2}"
  path="${line:3}"
  case "$path" in *' -> '*) path="${path##* -> }" ;; esac
  [[ "$xy" == *D* ]] && continue
  [[ "$path" == src/*.ts ]] || continue
  DRY_FILES+=("$path")
  case "$path" in
    src/parse.ts | src/lineage-infer.ts | src/geometry/*.ts) CRAP_FILES+=("$path") ;;
  esac
done < <(git status --porcelain -- src)

FAILED=0

if ((${#CRAP_FILES[@]})); then
  echo '== CRAP 快门禁（阈值 10）=='
  echo "变更文件：$(printf '%s ' "${CRAP_FILES[@]}")"
  LCOV="target/coverage/typescript/lcov.info"
  CRAP_MODE=(--no-coverage)
  if [[ -f "$LCOV" && -z "$(find src -name '*.ts' -newer "$LCOV" -print -quit 2>/dev/null)" \
      && -z "$(find lib -name '*.js' -newer "$LCOV" -print -quit 2>/dev/null)" ]]; then
    CRAP_MODE=(--use-existing-coverage)
  else
    echo '（无有效 coverage 或 coverage 已过期：仅复杂度报告，CRAP 阈值本次不生效，由 gate.sh 兜底）'
  fi
  CRAP_OUT="$("$CRAPPER_BIN" "${CRAP_MODE[@]}" --threshold 10 "${CRAP_FILES[@]}" 2>&1)"
  CRAP_RC=$?
  printf '%s\n' "$CRAP_OUT"
  if (( CRAP_RC != 0 )); then
    echo "pre-commit: CRAP 门禁未过（exit $CRAP_RC，阈值 10）" >&2
    FAILED=1
  fi
else
  echo '== CRAP 快门禁：src 门禁范围内无变更文件，跳过 =='
fi

if ((${#DRY_FILES[@]})); then
  echo '== 重复度快门禁（阈值 0.82）=='
  echo "变更文件：$(printf '%s ' "${DRY_FILES[@]}")"
  DRY_OUT="$("$DRYER_BIN" --threshold 0.82 "${DRY_FILES[@]}" 2>&1)"
  DRY_RC=$?
  printf '%s\n' "$DRY_OUT"
  if (( DRY_RC != 0 )); then
    echo "pre-commit: dryer 异常退出（exit $DRY_RC）" >&2
    FAILED=1
  fi
  if printf '%s\n' "$DRY_OUT" | grep '^DUPLICATE score=' >/dev/null; then
    echo 'pre-commit: 发现重复度 ≥ 0.82 的结构重复' >&2
    FAILED=1
  fi
else
  echo '== 重复度快门禁：src 下无变更文件，跳过 =='
fi

if (( FAILED )); then
  echo 'pre-commit: 快门禁未过，提交被挡。完整验证：bash scripts/gate.sh' >&2
  exit 1
fi
echo 'pre-commit: OK'
