#!/bin/bash

echo "🚀 启动德国发票系统..."

# 1. 检查 PostgreSQL
if ! docker ps | grep -q de-invoice-postgres; then
    echo "⚠️  启动 PostgreSQL..."
    docker start de-invoice-postgres
fi

# 2. 启动后端
echo "🔧 启动后端服务..."
cd backend
npm run dev &
BACKEND_PID=$!

# 3. 启动前端
echo "🎨 启动前端服务..."
cd ../frontend
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ 服务启动完成!"
echo "   前端: http://localhost:3000"
echo "   后端: http://localhost:3001/api/v1"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待退出
wait
