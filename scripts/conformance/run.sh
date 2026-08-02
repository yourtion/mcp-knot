#!/usr/bin/env bash
#
# Task 13: 官方 MCP conformance TCK 接入脚本（acceptance gate）。
#
# 用法：
#   pnpm test:conformance
#
# 做什么：
#   1. 构建 backend（dist）；
#   2. 在固定端口 8181 以「开放访问」配置起 Hub（OAuth 未配置 → /:group/mcp 全开）；
#   3. 用官方 @modelcontextprotocol/conformance v0.1.16（npx 拉取，不加为依赖）
#      在 server 模式下连 http://localhost:8181/default/mcp 跑 active suite；
#   4. 用 scripts/conformance/expected-failures.yaml 作 baseline：所有失败必须落在
#      baseline 内，且 baseline 内不得有已恢复（stale）条目，否则 exit 1（抓回归）。
#
# 关于「双 era」与 suite 选择（与 brief 假设的差异，详见 task-13-report.md）：
#   - conformance v0.1.16 的 server 场景仅覆盖 spec-version 2025-06-18 / 2025-11-25，
#     无 2026-07-28 场景；故「双 era」目标在 server 模式下无 2026-07-28 可跑。
#   - server 模式的 --suite 仅支持 active（默认）/ all / pending；
#     brief 假设的 `backcompat` suite 只存在于 client 模式，server 模式不可用。
#   - --spec-version 是「累积过滤器」（含该日期及之前引入的场景），不是按 era 切换协议。
#     2025-11-25 覆盖全部 server 场景，故脚本以该版本跑全套 active suite。
#   如未来 TCK 增加 2026-07-28 server 场景，可在此循环里追加该 spec-version。
set -euo pipefail

# ---------- 可配置项（环境变量覆盖） ----------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFORMANCE_PKG="@modelcontextprotocol/conformance@0.1.16"
HUB_PORT="${HUB_PORT:-8181}"
HUB_GROUP="${HUB_GROUP:-default}"
HUB_URL="http://localhost:${HUB_PORT}/${HUB_GROUP}/mcp"
SPEC_VERSION="${SPEC_VERSION:-2025-11-25}"   # 累积过滤；覆盖全部 server 场景
SUITE="${SUITE:-active}"
BASELINE="${REPO_ROOT}/scripts/conformance/expected-failures.yaml"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/.conformance-results}"

# ---------- 工具函数 ----------
log()  { printf '\033[36m[conformance]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[conformance ERROR]\033[0m %s\n' "$*" >&2; }

HUB_PID=""
cleanup() {
  if [[ -n "${HUB_PID}" ]] && kill -0 "${HUB_PID}" 2>/dev/null; then
    log "关闭 Hub（pid=${HUB_PID}）"
    kill "${HUB_PID}" 2>/dev/null || true
    # 给进程一点时间优雅退出，再强杀
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "${HUB_PID}" 2>/dev/null || break; sleep 0.3; done
    kill -9 "${HUB_PID}" 2>/dev/null || true
    # 兜底：按可执行路径再清一次（防止 trap 未及时触发留下僵尸/孤儿）
    pkill -9 -f "dist/backend/src/index.js" 2>/dev/null || true
  fi
}
TMP_CONFIG=""
finish() {
  cleanup
  [[ -n "${TMP_CONFIG}" && -d "${TMP_CONFIG}" ]] && rm -rf "${TMP_CONFIG}"
}
trap finish EXIT INT TERM

# ---------- 0. 前置检查 ----------
command -v node >/dev/null || { err "未找到 node"; exit 2; }
[[ -f "${BASELINE}" ]]     || { err "baseline 文件不存在：${BASELINE}"; exit 2; }

# ---------- 1. 构建 backend ----------
# dist 路径受 monorepo tsconfig 影响：backend 实际产物在 dist/backend/src/index.js
# （package.json 的 "start": "node dist/src/index.js" 与实际产物路径不符，故此处硬编码）
BACKEND_ENTRY="${REPO_ROOT}/backend/dist/backend/src/index.js"
if [[ ! -f "${BACKEND_ENTRY}" ]]; then
  log "构建 backend（首次或产物缺失）"
  (cd "${REPO_ROOT}" && pnpm --filter @mcp-core/mcp-knot-share build >/dev/null \
    && pnpm --filter @mcp-core/mcp-knot-protocol build >/dev/null \
    && pnpm --filter @mcp-core/mcp-knot-core build >/dev/null \
    && pnpm --filter @mcp-core/mcp-knot-api build >/dev/null) || { err "backend 构建失败"; exit 2; }
fi
[[ -f "${BACKEND_ENTRY}" ]] || { err "构建后仍找不到入口：${BACKEND_ENTRY}"; exit 2; }

# ---------- 2. 起 Hub（开放访问配置） ----------
# 端口占用预检：若 8181 已被占用（多半是上次跑残留的 Hub），直接失败，避免连到错实例。
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${HUB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  err "端口 ${HUB_PORT} 已被占用，请先停掉占用进程（多为上次 conformance 残留的 Hub）。"
  err "  查询：lsof -nP -iTCP:${HUB_PORT} -sTCP:LISTEN"
  exit 3
fi

# 用临时 CONFIG_PATH 放一份 system.json={}（空对象 → 走 port 默认值 8181 且 OAuth 未配置
# → /:group/mcp 全开，TCK 无需凭据即可连）。避免污染仓库 backend/config。
TMP_CONFIG="$(mktemp -d)"
cp "${REPO_ROOT}/backend/config/"*.json "${TMP_CONFIG}/" 2>/dev/null || true
# 强制 system.json 为空对象：触发 getAllConfig 的 system=空分支（port 默认 8181，OAuth 未配置）
printf '{}\n' > "${TMP_CONFIG}/system.json"
# 若调用方通过 HUB_PORT 改了端口，写进 system.json（需要完整 system 校验，故仅当端口非默认时
# 走环境变量 HUB_PORT 让 index.ts 读取——index.ts 当前只读 config，不读 env，因此改端口需配
# 置文件；默认 8181 即可，不在此处支持改端口以避免触发 system 全字段校验）。
if [[ "${HUB_PORT}" != "8181" ]]; then
  err "HUB_PORT 非 8181 暂不支持（需 system.json 完整字段校验），请保持默认。"
  exit 2
fi

log "启动 Hub：port=${HUB_PORT} endpoint=/${HUB_GROUP}/mcp（开放访问）"
( cd "${REPO_ROOT}/backend" \
  && CONFIG_PATH="${TMP_CONFIG}" node "${BACKEND_ENTRY}" ) >/tmp/p7-conformance-hub.log 2>&1 &
HUB_PID=$!

# ---------- 3. 等 Hub 就绪 ----------
log "等待 Hub 就绪…"
ready=0
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null -m 1 -X POST "${HUB_URL}" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"'"${SPEC_VERSION}"'","capabilities":{},"clientInfo":{"name":"tck-probe","version":"1"}}}'; then
    ready=1; break
  fi
  kill -0 "${HUB_PID}" 2>/dev/null || { err "Hub 进程已退出，日志见 /tmp/p7-conformance-hub.log"; tail -20 /tmp/p7-conformance-hub.log >&2 || true; exit 3; }
  sleep 0.5
done
if [[ "${ready}" != "1" ]]; then
  err "Hub 在 30s 内未就绪，日志见 /tmp/p7-conformance-hub.log"
  tail -20 /tmp/p7-conformance-hub.log >&2 || true
  exit 3
fi
log "Hub 就绪（${HUB_URL}）"

# ---------- 4. 跑 conformance TCK ----------
mkdir -p "${OUT_DIR}"
rm -rf "${OUT_DIR:?}"/*

log "运行 conformance TCK：spec=${SPEC_VERSION} suite=${SUITE}"
log "  npx ${CONFORMANCE_PKG} server --url ${HUB_URL} --suite ${SUITE} --spec-version ${SPEC_VERSION}"

# TCK 在 baseline 全部命中时 exit 0；出现 unexpected / stale 时 exit 1。
set +e
npx "${CONFORMANCE_PKG}" server \
  --url "${HUB_URL}" \
  --suite "${SUITE}" \
  --spec-version "${SPEC_VERSION}" \
  --expected-failures "${BASELINE}" \
  -o "${OUT_DIR}" \
  --verbose
TCK_EXIT=$?
set -e

# ---------- 5. 结果 ----------
if [[ "${TCK_EXIT}" -eq 0 ]]; then
  log "✅ conformance 通过：所有失败均在 baseline 内，无新增回归，无 stale 条目。"
  exit 0
else
  err "❌ conformance 未通过（exit ${TCK_EXIT}）：存在 unexpected failure 或 stale baseline 条目。"
  err "   结果目录：${OUT_DIR}"
  err "   Hub 日志：/tmp/p7-conformance-hub.log"
  err "   - unexpected failure = 真实回归，需修复 Hub；"
  err "   - stale baseline 条目 = 之前失败的场景现在通过了，需从 expected-failures.yaml 移除。"
  exit "${TCK_EXIT}"
fi
