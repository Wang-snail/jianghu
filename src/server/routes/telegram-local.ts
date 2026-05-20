/**
 * 完全本地化的Telegram验证系统
 * 不依赖任何江湖本地服务
 * 使用验证码方式，类似OpenAI
 */

import type { Router } from '../router'
import type Database from 'better-sqlite3'
import * as queries from '../../shared/db-queries'

// ==================== 数据库键名 ====================
const TELEGRAM_ID_KEY = 'zuzu_telegram_id'
const TELEGRAM_USERNAME_KEY = 'zuzu_telegram_username'
const TELEGRAM_FIRST_NAME_KEY = 'zuzu_telegram_first_name'
const TELEGRAM_VERIFIED_AT_KEY = 'zuzu_telegram_verified_at'
const TELEGRAM_VERIFICATION_CODE_KEY = 'zuzu_telegram_code'
const TELEGRAM_VERIFICATION_EXPIRES_KEY = 'zuzu_telegram_expires'

// ==================== 配置 ====================
const BOT_TOKEN = process.env.ZUZU_TELEGRAM_BOT_TOKEN || ''
const BOT_USERNAME = process.env.ZUZU_TELEGRAM_BOT_USERNAME || 'chong_zu_bot'
const VERIFICATION_CODE_TTL_MINUTES = 15

if (!BOT_TOKEN) {
  console.warn('⚠️  ZUZU_TELEGRAM_BOT_TOKEN 未设置 - 本地Telegram功能将不可用')
}

// ==================== 类型定义 ====================
interface TelegramMessage {
  message_id: number
  from: {
    id: number
    is_bot: boolean
    first_name: string
    username?: string
  }
  chat: {
    id: number
    type: string
  }
  text?: string
  date: number
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

// ==================== 工具函数 ====================

/**
 * 生成6位数验证码
 */
function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * 发送Telegram消息
 */
async function sendTelegramMessage(chatId: number | string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const data = await response.json() as { ok: boolean; description?: string }

    if (!data.ok) {
      return { ok: false, error: data.description }
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '未知错误'
    }
  }
}

/**
 * 设置Telegram Webhook
 */
async function setWebhook(webhookUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        drop_pending_updates: true
      }),
      signal: AbortSignal.timeout(15_000),
    })

    const data = await response.json() as { ok: boolean; description?: string }

    if (!data.ok) {
      return { ok: false, error: data.description }
    }

    console.log(`✅ Telegram Webhook已设置: ${webhookUrl}`)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '未知错误'
    }
  }
}

/**
 * 获取Webhook信息
 */
async function getWebhookInfo(): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
    const response = await fetch(url)
    const data = await response.json() as { ok: boolean; result?: any; description?: string }

    if (!data.ok) {
      return { ok: false, error: data.description }
    }

    return { ok: true, result: data.result }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '未知错误'
    }
  }
}

/**
 * 删除Webhook
 */
async function deleteWebhook(): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`
    const response = await fetch(url)
    const data = await response.json() as { ok: boolean; description?: string }

    if (!data.ok) {
      return { ok: false, error: data.description }
    }

    console.log('✅ Telegram Webhook已删除')
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '未知错误'
    }
  }
}

// ==================== 核心业务逻辑 ====================

/**
 * 生成本地验证码
 */
export async function generateLocalVerificationCode(
  db: Database.Database
): Promise<{ code: string; expiresAt: string; error?: string }> {
  try {
    const code = generateVerificationCode()
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000).toISOString()

    // 保存到数据库
    queries.setSetting(db, TELEGRAM_VERIFICATION_CODE_KEY, code)
    queries.setSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY, expiresAt)

    console.log(`📱 生成了Telegram验证码: ${code} (过期: ${expiresAt})`)

    return { code, expiresAt }
  } catch (error) {
    return {
      code: '',
      expiresAt: '',
      error: error instanceof Error ? error.message : '生成验证码失败'
    }
  }
}

/**
 * 验证验证码
 */
export async function verifyCode(
  db: Database.Database,
  code: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // 获取保存的验证码
    const savedCode = queries.getSetting(db, TELEGRAM_VERIFICATION_CODE_KEY)
    const expiresAt = queries.getSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY)

    if (!savedCode) {
      return { success: false, error: '未找到待验证的验证码' }
    }

    // 检查是否过期
    if (expiresAt) {
      const expiresAtMs = new Date(expiresAt).getTime()
      if (expiresAtMs < Date.now()) {
        // 清除过期的验证码
        queries.setSetting(db, TELEGRAM_VERIFICATION_CODE_KEY, '')
        queries.setSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY, '')
        return { success: false, error: '验证码已过期' }
      }
    }

    // 验证码匹配
    if (code !== savedCode) {
      return { success: false, error: '验证码错误' }
    }

    // 验证成功！清除验证码
    queries.setSetting(db, TELEGRAM_VERIFICATION_CODE_KEY, '')
    queries.setSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY, '')

    console.log('✅ Telegram验证码验证成功')
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '验证失败'
    }
  }
}

/**
 * 保存Telegram用户信息（验证成功后调用）
 */
export async function saveTelegramUser(
  db: Database.Database,
  userId: string,
  username: string,
  firstName: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const verifiedAt = new Date().toISOString()

    queries.setSetting(db, TELEGRAM_ID_KEY, userId)
    queries.setSetting(db, TELEGRAM_USERNAME_KEY, username)
    queries.setSetting(db, TELEGRAM_FIRST_NAME_KEY, firstName)
    queries.setSetting(db, TELEGRAM_VERIFIED_AT_KEY, verifiedAt)

    console.log(`✅ Telegram用户已保存: ${username} (${userId})`)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '保存用户信息失败'
    }
  }
}

/**
 * 获取验证状态
 */
export function getVerificationStatus(db: Database.Database): {
  verified: boolean
  telegramId?: string
  username?: string
  firstName?: string
  verifiedAt?: string
} {
  const telegramId = queries.getSetting(db, TELEGRAM_ID_KEY)
  const username = queries.getSetting(db, TELEGRAM_USERNAME_KEY)
  const firstName = queries.getSetting(db, TELEGRAM_FIRST_NAME_KEY)
  const verifiedAt = queries.getSetting(db, TELEGRAM_VERIFIED_AT_KEY)

  return {
    verified: Boolean(telegramId),
    telegramId: telegramId || undefined,
    username: username || undefined,
    firstName: firstName || undefined,
    verifiedAt: verifiedAt || undefined
  }
}

/**
 * 断开Telegram
 */
export function disconnectTelegram(db: Database.Database): void {
  queries.setSetting(db, TELEGRAM_ID_KEY, '')
  queries.setSetting(db, TELEGRAM_USERNAME_KEY, '')
  queries.setSetting(db, TELEGRAM_FIRST_NAME_KEY, '')
  queries.setSetting(db, TELEGRAM_VERIFIED_AT_KEY, '')
  queries.setSetting(db, TELEGRAM_VERIFICATION_CODE_KEY, '')
  queries.setSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY, '')

  console.log('✅ Telegram已断开')
}

// ==================== Webhook处理 ====================

/**
 * 处理Telegram Webhook消息
 */
export async function handleTelegramWebhook(
  db: Database.Database,
  update: TelegramUpdate
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!update.message) {
      return { ok: true }
    }

    const message = update.message
    const chatId = message.chat.id
    const userId = String(message.from.id)
    const username = message.from.username || message.from.first_name
    const text = message.text?.trim() || ''

    console.log(`📨 Telegram消息: ${text} (from: ${username}, userId: ${userId})`)

    // 检查是否有待验证的验证码
    const savedCode = queries.getSetting(db, TELEGRAM_VERIFICATION_CODE_KEY)
    const expiresAt = queries.getSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY)

    if (savedCode && expiresAt) {
      // 检查是否过期
      const expiresAtMs = new Date(expiresAt).getTime()
      const isExpired = expiresAtMs < Date.now()

      if (!isExpired && text === savedCode) {
        // 验证码匹配！
        const saveResult = await saveTelegramUser(db, userId, username, message.from.first_name)

        if (saveResult.ok) {
          await sendTelegramMessage(chatId, `✅ 验证成功！\n\n您的 Telegram 已成功连接到江湖系统。\n\n我是天机阁助手。\n\n可用命令:\n/start - 查看帮助\n/status - 查看江湖状态\n\n现在可以直接发送消息，我会通过本地接口处理事情。`)
          console.log(`✅ 用户 ${username} (${userId}) 验证成功`)
          return { ok: true }
        } else {
          await sendTelegramMessage(chatId, `❌ 验证失败: ${saveResult.error}`)
          return { ok: false, error: saveResult.error }
        }
      } else if (isExpired) {
        // 验证码过期，清除
        queries.setSetting(db, TELEGRAM_VERIFICATION_CODE_KEY, '')
        queries.setSetting(db, TELEGRAM_VERIFICATION_EXPIRES_KEY, '')
      }
    }

    // 检查用户是否已验证
    const verifiedId = queries.getSetting(db, TELEGRAM_ID_KEY)

    if (!verifiedId) {
      // 未验证，提示用户
      await sendTelegramMessage(chatId, `未验证\n\n请先在江湖界面中生成验证码，然后在此输入。`)
      return { ok: true }
    }

    if (verifiedId !== userId) {
      // 用户ID不匹配
      await sendTelegramMessage(chatId, `❌ 未授权\n\n此 Telegram 账号未绑定到江湖系统。\n\n您的ID: ${userId}\n已绑定的ID: ${verifiedId}`)
      return { ok: true }
    }

    // 已验证，处理命令和消息
    await handleVerifiedUser(db, chatId, text)

    return { ok: true }
  } catch (error) {
    console.error('处理Telegram Webhook错误:', error)
    return {
      ok: false,
      error: error instanceof Error ? error.message : '处理消息失败'
    }
  }
}

/**
 * 处理已验证用户的消息
 */
async function handleVerifiedUser(
  db: Database.Database,
  chatId: number,
  text: string
): Promise<void> {
  // 处理命令
  if (text === '/start') {
    await sendTelegramMessage(chatId, `欢迎使用江湖！\n\n我是天机阁助手。\n\n当前功能:\n/start - 显示此帮助\n/status - 查看江湖状态\n/rooms - 列出所有帮派\n\n您可以直接发送消息，我会通过本地接口处理事情。`)
    return
  }

  if (text === '/help') {
    await sendTelegramMessage(chatId, `江湖天机阁助手\n\n命令列表:\n/start - 开始使用\n/status - 查看江湖状态\n/rooms - 列出帮派\n\n直接发送消息即可与我交流，我会通过本地接口处理事情。`)
    return
  }

  if (text === '/status') {
    const rooms = queries.listRooms(db)
    if (rooms.length === 0) {
      await sendTelegramMessage(chatId, `江湖状态\n\n暂无帮派。\n\n请先在天机阁发布委托。`)
    } else {
      const roomList = rooms.map((r: any) => `• ${r.name} (${r.status})`).join('\n')
      await sendTelegramMessage(chatId, `江湖状态\n\n共 ${rooms.length} 个帮派:\n${roomList}`)
    }
    return
  }

  if (text === '/rooms') {
    const rooms = queries.listRooms(db)
    if (rooms.length === 0) {
      await sendTelegramMessage(chatId, `帮派列表\n\n暂无帮派。`)
    } else {
      let message = `🏠 房间列表\n\n`
      rooms.forEach((r: any, index: number) => {
        message += `${index + 1}. ${r.name}\n   状态: ${r.status}\n`
      })
      await sendTelegramMessage(chatId, message)
    }
    return
  }

  // 其他消息 - 简单回复
  await sendTelegramMessage(chatId, `收到您的消息\n\n内容: ${text}\n\n天机阁会通过本地接口处理，并在有结果后回传。`)
}

// ==================== 路由定义 ====================

/**
 * 导出本地Telegram路由
 */
export function initLocalTelegramRoutes(router: Router): void {
  // 生成验证码
  router.post('/api/telegram-local/verify/generate', async (ctx) => {
    const result = await generateLocalVerificationCode(ctx.db)

    if (result.error) {
      return {
        data: { ok: false, error: result.error }
      }
    }

    return {
      data: {
        ok: true,
        code: result.code,
        expiresAt: result.expiresAt,
        message: `请在Telegram中向 @${BOT_USERNAME} 发送验证码: ${result.code}`
      }
    }
  })

  // 验证验证码
  router.post('/api/telegram-local/verify', async (ctx) => {
    const body = (ctx.body as Record<string, unknown>) ?? {}
    const code = typeof body.code === 'string' ? body.code.trim() : ''

    if (!code) {
      return { status: 400, error: '请提供验证码' }
    }

    const result = await verifyCode(ctx.db, code)
    return {
      data: result
    }
  })

  // 检查验证状态
  router.get('/api/telegram-local/status', async (ctx) => {
    const status = getVerificationStatus(ctx.db)
    return {
      data: {
        ok: true,
        ...status
      }
    }
  })

  // 断开Telegram
  router.post('/api/telegram-local/disconnect', async (ctx) => {
    disconnectTelegram(ctx.db)
    return {
      data: { ok: true }
    }
  })

  // 设置Webhook
  router.post('/api/telegram-local/setup-webhook', async (ctx) => {
    const body = (ctx.body as Record<string, unknown>) ?? {}
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''

    if (!baseUrl) {
      return { status: 400, error: '请提供baseUrl' }
    }

    const webhookUrl = `${baseUrl}/api/telegram-local/webhook`
    const result = await setWebhook(webhookUrl)

    if (!result.ok) {
      return {
        data: { ok: false, error: result.error }
      }
    }

    return {
      data: {
        ok: true,
        webhookUrl,
        message: 'Webhook设置成功'
      }
    }
  })

  // 获取Webhook信息
  router.get('/api/telegram-local/webhook/info', async (_ctx) => {
    const result = await getWebhookInfo()
    return {
      data: result
    }
  })

  // 删除Webhook
  router.post('/api/telegram-local/webhook/delete', async (_ctx) => {
    const result = await deleteWebhook()
    return {
      data: result
    }
  })

  // 处理Telegram Webhook
  router.post('/api/telegram-local/webhook', async (ctx) => {
    try {
      const update = ctx.body as TelegramUpdate
      const result = await handleTelegramWebhook(ctx.db, update)

      if (!result.ok) {
        return { status: 500, error: result.error }
      }

      return {
        data: { ok: true }
      }
    } catch (error) {
      console.error('处理Telegram Webhook错误:', error)
      return {
        status: 500,
        error: error instanceof Error ? error.message : '处理失败'
      }
    }
  })

  // 测试发送消息
  router.post('/api/telegram-local/test', async (ctx) => {
    const status = getVerificationStatus(ctx.db)

    if (!status.verified || !status.telegramId) {
      return {
        data: { ok: false, error: '未验证的Telegram账号' }
      }
    }

    const result = await sendTelegramMessage(
      status.telegramId,
      `🧪 测试消息\n\n时间: ${new Date().toLocaleString('zh-CN')}\n状态: 正常`
    )

    return {
      data: result
    }
  })
}
