#!/usr/bin/env bash
#
# TradePilot 本地开发服务一键重启
#
# 流程：停止已运行的服务 → 释放被占用的端口 → 重新启动 → 等待就绪
#
# 用法：
#   ./restart-dev.sh                  # 重启 api + worker + web（默认）
#   ./restart-dev.sh api web          # 只重启指定服务
#   ./restart-dev.sh --stop           # 只关闭，不启动
#   ./restart-dev.sh --status         # 查看运行状态
#   ./restart-dev.sh --help
#
# 服务：api（NestJS，默认 3000）| worker（BullMQ，无端口）| web（Vite，5173）
#
# 端口可用环境变量覆盖，例如 API_PORT=8080 WEB_PORT=5174 ./restart-dev.sh
#
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.dev-run"
LOG_DIR="$ROOT/.dev-logs"
ALL_SERVICES=(api worker web)

# ---------------------------------------------------------------- 工具函数

usage() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

log()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✘\033[0m %s\n' "$*"; }

# 读取 server/.env 中的键（取第一个匹配，与 main.ts 的 loadLocalDotEnv 语义一致）
read_dotenv_port() {
  local key="$1" file="$ROOT/server/.env" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | head -n 1)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%%#*}"
  printf '%s' "$value" | tr -d "[:space:]\"'"
}

service_port() {
  case "$1" in
    api) echo "$API_PORT" ;;
    web) echo "$WEB_PORT" ;;
    *)   echo "" ;;
  esac
}

service_pid() {
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || return 0
  cat "$pidfile" 2>/dev/null
}

is_listening() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

# 等待端口进入 LISTEN（最多 timeout 秒）
wait_ready() {
  local name="$1" port="$2" timeout="${3:-60}" i
  [ -z "$port" ] && return 0
  i=0
  while [ "$i" -lt $((timeout * 2)) ]; do
    if is_listening "$port"; then
      ok "$name 已就绪  → http://localhost:$port"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  warn "$name 未在 ${timeout}s 内监听 :$port，请查看 $LOG_DIR/$name.log"
  return 0
}

# ---------------------------------------------------------------- 停止

# 等待进程退出（最多 5s）
wait_gone() {
  local pid="$1" i=0
  while [ "$i" -lt 50 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# 杀掉启动时记录的整个进程组（pnpm → turbo → node 全部在内）
kill_by_pidfile() {
  local name="$1" pid
  pid="$(service_pid "$name")"
  [ -n "$pid" ] || return 1
  if kill -0 "$pid" 2>/dev/null; then
    log "  关闭 $name（PID $pid）…"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    if ! wait_gone "$pid"; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$RUN_DIR/$name.pid"
  return 0
}

# 释放端口：可能有非本脚本启动的残留进程占用
free_port() {
  local port="$1" pids i=0
  [ -n "$port" ] || return 0
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] || return 0

  log "  端口 $port 被占用（PID: $(echo "$pids" | tr '\n' ' ' | sed 's/ $//')），先释放…"
  echo "$pids" | xargs -n 1 kill -TERM 2>/dev/null || true
  while [ "$i" -lt 30 ]; do
    is_listening "$port" || { ok "端口 $port 已释放"; return 0; }
    sleep 0.1
    i=$((i + 1))
  done
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs -n 1 kill -KILL 2>/dev/null || true
  fi
  if is_listening "$port"; then
    warn "端口 $port 仍被占用，请手动处理（可能需要 sudo）"
  else
    ok "端口 $port 已释放"
  fi
}

# worker 无端口，PID 文件丢失时按命令行特征兜底清理（tsx ... watch src/index.ts）
kill_worker_by_pattern() {
  local pids
  pids="$(pgrep -f 'tsx.*watch src/index.ts' 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  log "  清理残留 worker 进程（PID: $(echo "$pids" | tr '\n' ' ' | sed 's/ $//')）…"
  echo "$pids" | xargs -n 1 kill -TERM 2>/dev/null || true
  sleep 0.5
  pids="$(pgrep -f 'tsx.*watch src/index.ts' 2>/dev/null || true)"
  [ -n "$pids" ] && echo "$pids" | xargs -n 1 kill -KILL 2>/dev/null || true
  return 0
}

stop_service() {
  local name="$1" port
  log "[$name] 停止"
  if ! kill_by_pidfile "$name"; then
    case "$name" in
      worker) kill_worker_by_pattern ;;
      *)      free_port "$(service_port "$name")" ;;
    esac
  else
    # PID 文件命中后仍可能残留子进程占用端口，二次确认
    port="$(service_port "$name")"
    [ -n "$port" ] && free_port "$port"
  fi
  return 0
}

# ---------------------------------------------------------------- 启动

start_service() {
  local name="$1" log_file="$LOG_DIR/$name.log" pid

  log "[$name] 启动"
  : >"$log_file"

  # set -m 下后台任务自成进程组，便于整体关闭；nohup 避免终端关闭时被 HUP
  case "$name" in
    api)
      (cd "$ROOT/server" && exec nohup pnpm exec turbo run dev --filter=@tradepilot/api) >"$log_file" 2>&1 &
      ;;
    worker)
      (cd "$ROOT/server" && exec nohup pnpm exec turbo run dev --filter=@tradepilot/worker) >"$log_file" 2>&1 &
      ;;
    web)
      (cd "$ROOT/web" && exec nohup pnpm dev) >"$log_file" 2>&1 &
      ;;
  esac

  pid=$!
  echo "$pid" >"$RUN_DIR/$name.pid"
  ok "$name 已启动（PID $pid，日志 $log_file）"
}

# ---------------------------------------------------------------- 状态

show_status() {
  local name pid port state
  for name in "${ALL_SERVICES[@]}"; do
    pid="$(service_pid "$name")"
    port="$(service_port "$name")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      state="运行中（PID $pid）"
    else
      state="未运行"
    fi
    if [ -n "$port" ]; then
      if is_listening "$port"; then
        state="$state，端口 $port 已监听"
      else
        state="$state，端口 $port 空闲"
      fi
    fi
    printf '  %-7s %s\n' "$name" "$state"
  done
}

# ---------------------------------------------------------------- 主流程

main() {
  local services=() stop_only=0 status_only=0 arg name

  for arg in "$@"; do
    case "$arg" in
      -h | --help)  usage; exit 0 ;;
      --stop)       stop_only=1 ;;
      --status)     status_only=1 ;;
      api | worker | web) services[${#services[@]}]="$arg" ;;
      *) err "未知参数：$arg"; usage; exit 1 ;;
    esac
  done
  [ "${#services[@]}" -gt 0 ] || services=("${ALL_SERVICES[@]}")

  if [ "$status_only" -eq 1 ]; then
    show_status
    exit 0
  fi

  command -v pnpm >/dev/null 2>&1 || { err "未找到 pnpm，请先安装并加入 PATH"; exit 1; }

  API_PORT="${API_PORT:-}"
  [ -n "$API_PORT" ] || API_PORT="$(read_dotenv_port API_PORT)"
  [ -n "$API_PORT" ] || API_PORT=3000
  WEB_PORT="${WEB_PORT:-5173}"

  mkdir -p "$RUN_DIR" "$LOG_DIR"

  log "项目根目录：$ROOT"
  log "端口配置：api=$API_PORT  web=$WEB_PORT"
  log ""

  for name in "${services[@]}"; do
    stop_service "$name"
  done

  if [ "$stop_only" -eq 1 ]; then
    log ""
    log "已停止：${services[*]}"
    exit 0
  fi

  log ""
  set -m

  for name in "${services[@]}"; do
    start_service "$name"
  done

  log ""
  for name in "${services[@]}"; do
    wait_ready "$name" "$(service_port "$name")"
  done

  log ""
  log "完成。实时日志：tail -f $LOG_DIR/*.log"
}

main "$@"
