#!/bin/bash
# 虫族Telegram Bot连接自动化测试脚本
# 自动化连接虫族Telegram Bot的流程

echo "=================================="
echo "  虫族Telegram Bot连接自动化"
echo "=================================="
echo ""

# 项目根目录
PROJECT_ROOT="/Users/woniu/dm/其他尝试/公司/room-main"
ARTIFACTS_DIR="$PROJECT_ROOT/artifacts/telegram-connection"

# 确保artifacts目录存在
mkdir -p "$ARTIFACTS_DIR"

# 检查服务器是否运行
echo "1. 检查服务器状态..."
if lsof -i :4800 > /dev/null 2>&1; then
    echo "   服务器正在运行 (端口4800)"
else
    echo "   错误: 服务器未运行！"
    echo "   请先启动服务器: npm run dev:room"
    exit 1
fi

# 运行测试
echo ""
echo "2. 运行Telegram连接测试..."
cd "$PROJECT_ROOT"
npx playwright test e2e/telegram-bot-connection.spec.ts --headed --project=chromium

# 检查测试结果
if [ $? -eq 0 ]; then
    echo ""
    echo "=================================="
    echo "  测试成功完成！"
    echo "=================================="
    echo ""
    echo "截图文件保存在: $ARTIFACTS_DIR"
    echo ""
    echo "最新截图:"
    ls -lt "$ARTIFACTS_DIR"/*.png 2>/dev/null | head -5 | awk '{print "  " $9}'
    echo ""
    echo "注意: 测试会自动下载 JSON 报告文件"
else
    echo ""
    echo "=================================="
    echo "  测试失败"
    echo "=================================="
    echo ""
    echo "请检查日志中的错误信息"
    exit 1
fi
