#!/bin/bash
# 虫族Telegram Bot与Clerk完整集成脚本

echo "=== 虫族Telegram Bot与Clerk集成 ==="
echo ""

BOT_TOKEN="8727608374:AAEyVrUf1kJ53263HV1B2gkDlbZQi9HcGJo"
WEBHOOK_SECRET="zuzu_clerk_secret_$(date +%s)"

# 检查ngrok是否运行
echo "1️⃣  检查ngrok状态..."
if pgrep -q "ngrok"; then
    echo "✅ ngrok正在运行"

    # 尝试获取ngrok URL
    NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for tunnel in data.get('tunnels', []):
        if tunnel.get('proto') == 'https':
            print(tunnel.get('public_url'))
            break
except:
    pass
" 2>/dev/null)

    if [ -n "$NGROK_URL" ]; then
        echo "📡 Ngrok URL: $NGROK_URL"
    else
        echo "⚠️  无法获取ngrok URL"
        echo "   请手动启动: ngrok http 4800"
        read -p "请输入ngrok URL: " NGROK_URL
    fi
else
    echo "❌ ngrok未运行"
    echo ""
    echo "请先在新终端启动ngrok:"
    echo "  ngrok http 4800"
    echo ""
    read -p "启动后，请输入ngrok URL: " NGROK_URL
fi

# 去除结尾斜杠
NGROK_URL=${NGROK_URL%/}

if [ -z "$NGROK_URL" ]; then
    echo "❌ 无法继续，需要ngrok URL"
    exit 1
fi

# 设置Webhook
WEBHOOK_URL="${NGROK_URL}/api/contacts/telegram/webhook"

echo ""
echo "2️⃣  设置Telegram Webhook..."
echo "   URL: $WEBHOOK_URL"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"$WEBHOOK_URL\",
    \"secret_token\": \"$WEBHOOK_SECRET\"
  }")

if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "✅ Webhook设置成功！"
else
    echo "❌ Webhook设置失败"
    echo "   错误: $RESPONSE"
    exit 1
fi

# 保存secret到.env
echo "" >> .env
echo "# Telegram Webhook Secret" >> .env
echo "TELEGRAM_WEBHOOK_SECRET=$WEBHOOK_SECRET" >> .env
echo "✅ Secret已保存到.env"

echo ""
echo "3️⃣  验证Webhook..."
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    url = d['result'].get('url', '未设置')
    print(f'   Webhook URL: {url}')
else:
    print('   ❌ 获取Webhook信息失败')
" 2>/dev/null

echo ""
echo "4️⃣  重启虫族服务..."
# 查找并杀死旧进程
pkill -f "node.*serve.*4800" 2>/dev/null
sleep 2

# 重新启动（您可能需要手动运行）
echo "   请重启虫族服务:"
echo "   npm run serve -- --port 4800"

echo ""
echo "=== 配置完成！==="
echo ""
echo "📱 下一步操作:"
echo "1. 确保虫族服务正在运行（端口4800）"
echo "2. 在虫族UI中打开 书记官 标签"
echo "3. 点击 连接Telegram"
echo "4. 向 @chong_zu_bot 发送 /start"
echo ""
echo "🔍 测试命令:"
echo "   curl -s https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo | python3 -m json.tool"
echo ""
