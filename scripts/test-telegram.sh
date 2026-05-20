#!/bin/bash

# Telegram机器人测试和配置脚本

echo "=== 江湖Telegram机器人配置工具 ==="
echo ""

# 检查是否设置了Token
if [ -z "$COMPANY_TELEGRAM_BOT_TOKEN" ]; then
    echo "❌ 错误: 请先设置环境变量 COMPANY_TELEGRAM_BOT_TOKEN"
    echo ""
    echo "请按以下步骤操作:"
    echo "1. 在Telegram中找到 @BotFather"
    echo "2. 发送 /newbot 创建新机器人"
    echo "3. 获取Token后，运行:"
    echo ""
    echo "   export COMPANY_TELEGRAM_BOT_TOKEN='你的Token'"
    echo ""
    exit 1
fi

# 测试Bot连接
echo "🔍 测试Bot连接..."
BOT_INFO=$(curl -s "https://api.telegram.org/bot$COMPANY_TELEGRAM_BOT_TOKEN/getMe")

if echo "$BOT_INFO" | grep -q '"ok":true'; then
    BOT_USERNAME=$(echo "$BOT_INFO" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
    echo "✅ Bot连接成功: @$BOT_USERNAME"
else
    echo "❌ Bot连接失败"
    echo "错误信息: $BOT_INFO"
    exit 1
fi

echo ""
echo "=== 当前配置 ==="
echo "Bot Username: $BOT_USERNAME"
echo "Bot Token: ${COMPANY_TELEGRAM_BOT_TOKEN:0:10}..."
echo ""

# 检查数据库中的配置
echo "=== 数据库中的Telegram配置 ==="
sqlite3 ~/.jianghu/data.db "SELECT key, value FROM settings WHERE key LIKE '%telegram%';" 2>/dev/null
echo ""

# 获取用户的Telegram ID
TELEGRAM_ID=$(sqlite3 ~/.jianghu/data.db "SELECT value FROM settings WHERE key='contact_telegram_id';" 2>/dev/null)

if [ -n "$TELEGRAM_ID" ]; then
    echo "已链接的Telegram ID: $TELEGRAM_ID"
    echo ""
    echo "📤 发送测试消息到您的Telegram..."

    # 发送测试消息
    TEST_MESSAGE="🤖 江湖测试消息

您的Telegram机器人配置正常！
Bot: @$BOT_USERNAME
时间: $(date '+%Y-%m-%d %H:%M:%S')"

    RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot$COMPANY_TELEGRAM_BOT_TOKEN/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{
            \"chat_id\": \"$TELEGRAM_ID\",
            \"text\": \"$TEST_MESSAGE\"
        }")

    if echo "$RESPONSE" | grep -q '"ok":true'; then
        echo "✅ 测试消息发送成功！"
        echo "请检查您的Telegram。"
    else
        echo "❌ 消息发送失败"
        echo "错误信息: $RESPONSE"
    fi
else
    echo "⚠️  未找到已链接的Telegram ID"
    echo "请先在江湖界面中链接Telegram"
fi

echo ""
echo "=== 完成配置 ==="
echo ""
echo "如果机器人能正常接收消息，但不会自动回复，可能是因为："
echo ""
echo "1. 本地服务问题 - 需要配置本地Webhook"
echo "2. Clerk未启用 - 请检查江湖设置"
echo ""
echo "要设置本地Webhook，请使用:"
echo "  bash scripts/setup-telegram-webhook.sh"
echo ""
