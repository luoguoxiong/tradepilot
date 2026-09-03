#!/bin/bash
# TradePilot 一键启动脚本：同时拉起后端(8787)与前端(5173)，Ctrl+C 一起退出
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

# 0) 环境检查：.env 必须存在且已填 key
if [ ! -f "$ROOT/server/.env" ]; then
  echo "❌ 缺少 server/.env，请先: cp server/.env.example server/.env 并填入 key"
  exit 1
fi
if grep -q "在这里填入" "$ROOT/server/.env"; then
  echo "❌ server/.env 中还有未填的 key（搜索'在这里填入'）"
  exit 1
fi

# 1) 依赖安装（node_modules 缺失时自动装）
[ -d "$ROOT/server/node_modules" ] || (cd "$ROOT/server" && echo "📦 安装后端依赖..." && npm install)
[ -d "$ROOT/web/node_modules" ] || (cd "$ROOT/web" && echo "📦 安装前端依赖..." && npm install)

# 2) 后端构建（dist 缺失或源码有更新时重新构建）
if [ ! -d "$ROOT/server/dist" ] || [ -n "$(find "$ROOT/server/src" -newer "$ROOT/server/dist/index.js" -name '*.ts' 2>/dev/null | head -1)" ]; then
  (cd "$ROOT/server" && echo "🔨 构建后端..." && npm run build)
fi

# 3) 端口占用检查
if lsof -i :8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 8787 已被占用，假定后端已在运行，跳过启动"
  SERVER_PID=""
else
  echo "🚀 启动后端 http://localhost:8787 （日志: /tmp/tradepilot-server.log）"
  (cd "$ROOT/server" && node dist/index.js > /tmp/tradepilot-server.log 2>&1 & echo $! > /tmp/tradepilot-server.pid)
  SERVER_PID=$(cat /tmp/tradepilot-server.pid)
  sleep 1.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "❌ 后端启动失败，日志如下："; tail -20 /tmp/tradepilot-server.log; exit 1
  fi
fi

# 4) 清理函数：Ctrl+C / 退出时杀掉后端
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo ""; echo "🛑 停止后端 (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# 5) 启动前端（前台运行，Ctrl+C 退出并联动关闭后端）
echo "🚀 启动前端 http://localhost:5173 （浏览器将自动打开）"
( sleep 4 && open http://localhost:5173 ) &
cd "$ROOT/web" && npx vite --port 5173
