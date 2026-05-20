#!/bin/bash
# 江湖Telegram Bot - 完整解决方案

echo "=== 江湖Telegram Bot解决方案 ==="
echo ""

# 配置
BOT_TOKEN="8727608374:AAEyVrUf1kJ53263HV1B2gkDlbZQi9HcGJo"
BOT_USERNAME="chong_zu_bot"

echo "📋 Bot配置:"
echo "   Token: ${BOT_TOKEN:0:15}..."
echo "   Username: @$BOT_USERNAME"
echo ""

# 测试1：Bot连接
echo "=== 测试1：Bot连接性 ==="
BOT_INFO=$(curl -s "https://api.telegram.org/bot$BOT_TOKEN/getMe" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('ok'):
    print('✅ Bot连接成功')
    print('用户名: @' + d['result'].get('username', ''))
    sys.exit(0)
else:
    print('❌ Bot连接失败: ' + d.get('description', ''))
    sys.exit(1)
" 2>/dev/null)

if echo "$BOT_INFO" | grep -q "Bot连接成功"; then
    echo ""
else
    echo "⚠️  Bot连接失败，请检查Token"
    echo "   可能原因："
    echo "     1. Token不正确或已过期"
    echo "     2. 网络问题"
    echo ""
    exit 1
fi

echo ""
echo "✅ Bot连接正常！"
echo ""

# 方案A：本地验证方式（推荐，更稳定）
echo "=== 方案A：本地验证方式==="
echo ""
echo "📝 优点:"
echo "   1. 功能完整 - 完整的Clerk集成"
echo "   2. 更稳定 - 本地服务处理所有复杂逻辑"
echo "   3. 支持多设备 - Webhook可指向多个地址"
echo "   4. 开发友好 - 无需自己配置Webhook"
echo ""
echo "📝 使用步骤:"
echo "   1. 刷新浏览器: http://localhost:4800"
echo "   2. 点击侧边栏 > 全局设置"
echo "   3. 找到 通知 > 连接方式"
echo "   4. 点击 '打开机器人链接'"
echo "   5. 在Telegram中点击链接并验证"
echo "   6. 验证成功后，机器人会正常回复"
echo ""
echo "⚠️  注意:"
echo "   如果之前链接失败，需要先断开旧链接"
echo "   在江湖界面中可以：全局设置 > 通知 > 断开Telegram"
echo ""

# 方案B：手动测试（快速验证）
echo "=== 方案B：手动测试Bot ==="
echo ""
echo "📝 当前Telegram ID: 6385977101"
echo ""
echo "使用curl发送测试消息:"
echo "curl -s -X POST 'https://api.telegram.org/bot$BOT_TOKEN/sendMessage' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{"
echo "     \"chat_id\": \"6385977101\","
echo "     \"text\": \"🤖 测试消息 - $(date '+%H:%M:%S')\""
echo "   }'"
echo ""
echo "或使用Webhook方式（需要ngrok）:"
echo "1. 启动ngrok: ngrok http 4800"
echo "2. 复制显示的URL（如：https://abc.ngrok.io）"
echo "3. 设置Webhook:"
echo "   curl -X POST 'https://api.telegram.org/bot$BOT_TOKEN/setWebhook' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{"
echo "       \"url\": \"https://YOUR_NGROK_URL.ngrok.io/api/telegram/webhook\","
echo "       \"secret_token\": \"YOUR_SECRET\""
echo "     }'"
echo ""

# 诊断当前状态
echo "=== 诊断当前状态 ==="
echo "检查数据库中的Telegram配置..."
sqlite3 ~/.jianghu/data.db "SELECT key, value FROM settings WHERE key LIKE 'contact_telegram%';" 2>/dev/null
echo ""

echo "建议操作:"
echo "1. 首先断开旧的Telegram链接（如果有的话）"
echo "   在江湖UI中: 全局设置 > 通知 > 断开Telegram"
echo ""
echo "2. 重新连接Telegram"
echo "   刷新浏览器: http://localhost:4800"
echo "   全局设置 > 通知 > 连接方式"
echo "   打开 @chong_zu_bot 发送 /start"
echo "   点击江湖显示的链接"
echo "   等待几秒后，应该会验证成功"
echo ""

# 方案C：暂时禁用（备用）
echo "=== 方案C：暂时禁用Telegram（备用）==="
echo ""
echo "如果Telegram一直有问题，可以:"
echo "1. 关闭Telegram通知"
echo "2. 启用邮件通知"
echo "3. 等待本地服务恢复"
echo ""

echo ""
echo "=== 推荐操作顺序 ==="
echo "1️⃣ 刷新浏览器"
echo "2️⃣ 打开全局设置 > 通知"
echo "3️⃣ 断开旧的Telegram链接（如果有）"
echo "4️⃣ 重新连接Telegram（打开机器人链接）"
echo "5️⃣ 等待验证完成（2-3分钟）"
echo "6️⃣ 在Telegram中发送 /start 测试"
echo ""
