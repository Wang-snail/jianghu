import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import {
  getRoomCloudId,
  ensureCloudRoomToken,
  listCloudStations,
  execOnCloudStation,
  getCloudStationLogs,
  startCloudStation,
  stopCloudStation,
  deleteCloudStation,
  cancelCloudStation,
  getCloudCryptoPrices,
  cryptoCheckoutStation,
  cryptoRenewStation,
} from '../../shared/cloud-sync'
import { sendToken } from '../../shared/wallet'
import { CHAIN_CONFIGS } from '../../shared/constants'
import { recordPaymentAudit, formatPaymentAuditSuffix } from './payment-audit'

const CLOUD_BASE = process.env.COMPANY_LOCAL_BASE_URL || 'http://127.0.0.1:4700'

const CLOUD_ONLY = {
  content: [{
    type: 'text' as const,
    text: '当前是本地公司模式，不需要外部云站点。请使用本机任务、员工、文件和本地接口完成执行。'
  }]
}
const isCloudMode = (): boolean => process.env.COMPANY_DEPLOYMENT_MODE === 'cloud'

async function bootstrapRoomToken(roomId: number): Promise<void> {
  const db = getMcpDatabase()
  const room = queries.getRoom(db, roomId)
  if (!room) return
  await ensureCloudRoomToken({
    roomId: getRoomCloudId(roomId),
    name: room.name,
    goal: room.goal ?? null,
    visibility: room.visibility,
    referredByCode: room.referredByCode,
    keeperReferralCode: queries.getSetting(db, 'keeper_referral_code'),
  })
}

export function registerStationTools(server: McpServer): void {
  server.registerTool(
    'company_station_create',
    {
      title: '创建本地执行站',
      description: '在本地公司模式中说明可用的本机执行入口。不要引导用户购买或创建外部云服务。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        name: z.string().min(1).max(100).describe('执行站名称，例如 web-server 或 scraper-01'),
        tier: z.enum(['micro', 'small', 'medium', 'large']).describe(
          '本地兼容字段：micro、small、medium、large。项目内不产生真实世界费用。'
        )
      }
    },
    async ({ roomId }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const url = `${CLOUD_BASE}/stations?room=${encodeURIComponent(cloudRoomId)}`
      return {
        content: [{
          type: 'text' as const,
          text: `本地执行站入口：${url}\n\n本地公司模式请优先使用本机任务和员工执行。`
        }]
      }
    }
  )

  server.registerTool(
    'company_station_list',
    {
      title: '列出执行站',
      description: '列出当前公司的执行站。本地模式下请使用本机任务和员工执行。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        status: z.enum(['pending', 'active', 'stopped', 'canceling', 'past_due', 'error']).optional()
          .describe('按状态筛选')
      }
    },
    async ({ roomId, status }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const stations = await listCloudStations(cloudRoomId)
      const filtered = status ? stations.filter(s => s.status === status) : stations
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: '未找到执行站。' }] }
      }
      const list = filtered.map(s => ({
        id: s.id, name: s.stationName, tier: s.tier, status: s.status,
        monthlyCost: s.monthlyCost, createdAt: s.createdAt
      }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(list, null, 2) }] }
    }
  )

  server.registerTool(
    'company_station_start',
    {
      title: '启动执行站',
      description: '启动已停止的执行站。本地模式下请使用本机任务和员工执行。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('要启动的执行站 ID')
      }
    },
    async ({ roomId, id }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      await startCloudStation(cloudRoomId, id)
      return { content: [{ type: 'text' as const, text: `执行站 ${id} 已请求启动。` }] }
    }
  )

  server.registerTool(
    'company_station_stop',
    {
      title: '停止执行站',
      description: '停止运行中的执行站。本地模式下请使用本机任务和员工执行。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('要停止的执行站 ID')
      }
    },
    async ({ roomId, id }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      await stopCloudStation(cloudRoomId, id)
      return { content: [{ type: 'text' as const, text: `执行站 ${id} 已请求停止。` }] }
    }
  )

  server.registerTool(
    'company_station_delete',
    {
      title: '删除执行站',
      description: '删除执行站。本地模式下不销毁任何外部机器。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('要删除的执行站 ID')
      }
    },
    async ({ roomId, id }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      await deleteCloudStation(cloudRoomId, id)
      return {
        content: [{
          type: 'text' as const,
          text: `执行站 ${id} 已请求删除。`
        }]
      }
    }
  )

  server.registerTool(
    'company_station_cancel',
    {
      title: '取消执行站',
      description: '取消执行站。本地模式下只更新项目内状态。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('要取消的执行站 ID')
      }
    },
    async ({ roomId, id }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      await cancelCloudStation(cloudRoomId, id)
      return {
        content: [{
          type: 'text' as const,
          text: `执行站 ${id} 已请求取消。`
        }]
      }
    }
  )

  server.registerTool(
    'company_station_exec',
    {
      title: '在执行站运行命令',
      description: '在执行站运行命令并返回 stdout/stderr。本地模式请优先使用任务执行器。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('执行站 ID'),
        command: z.string().min(1).describe('要执行的命令')
      }
    },
    async ({ roomId, id, command }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const result = await execOnCloudStation(cloudRoomId, id, command)
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: '未能在执行站运行命令。' }],
          isError: true
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }, null, 2)
        }]
      }
    }
  )

  server.registerTool(
    'company_station_logs',
    {
      title: '执行站日志',
      description: '读取执行站近期日志。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('执行站 ID'),
        lines: z.number().int().positive().max(1000).optional().describe('日志行数，默认全部')
      }
    },
    async ({ roomId, id, lines }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const logs = await getCloudStationLogs(cloudRoomId, id, lines)
      if (logs === null) {
        return {
          content: [{ type: 'text' as const, text: '未能读取日志。' }],
          isError: true
        }
      }
      return { content: [{ type: 'text' as const, text: logs || '(no logs)' }] }
    }
  )

  server.registerTool(
    'company_station_status',
    {
      title: '执行站状态',
      description: '读取执行站状态。',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('执行站 ID')
      }
    },
    async ({ roomId, id }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)
      const stations = await listCloudStations(cloudRoomId)
      const station = stations.find(s => s.id === id)
      if (!station) {
        return {
          content: [{ type: 'text' as const, text: `执行站 ${id} 未找到` }],
          isError: true
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: station.id, name: station.stationName, tier: station.tier,
            status: station.status, monthlyCost: station.monthlyCost,
            currentPeriodEnd: station.currentPeriodEnd, createdAt: station.createdAt
          }, null, 2)
        }]
      }
    }
  )

  // ─── Crypto payment tools ──────────────────────────────────

  server.registerTool(
    'company_station_create_crypto',
    {
      title: 'Create Station (Crypto)',
      description: 'Pay for a new Station with USDC or USDT from the room wallet on any supported chain. '
        + 'Sends stablecoin to the 公司本地 treasury and provisions the Station automatically. '
        + 'Requires the room to have a wallet with sufficient balance. '
        + 'Crypto prices are 1.5x Stripe prices (micro $7.50, small $22.50, medium $60, large $150). '
        + 'Supported chains: base, ethereum, arbitrum, optimism, polygon. Tokens: usdc, usdt. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        name: z.string().min(1).max(100).describe('Station name (e.g., "web-server", "scraper-01")'),
        tier: z.enum(['micro', 'small', 'medium', 'large']).describe(
          'Station tier: micro ($7.50/mo crypto), small ($22.50/mo), medium ($60/mo), large ($150/mo)'
        ),
        encryptionKey: z.string().min(1).describe('Wallet encryption key for sending stablecoin'),
        chain: z.enum(['base', 'ethereum', 'arbitrum', 'optimism', 'polygon']).optional()
          .describe('Chain to pay on (default: base)'),
        token: z.enum(['usdc', 'usdt']).optional()
          .describe('Token to pay with (default: usdc)')
      }
    },
    async ({ roomId, name, tier, encryptionKey, chain, token }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      const selectedChain = chain ?? 'base'
      const selectedToken = token ?? 'usdc'

      const chainConfig = CHAIN_CONFIGS[selectedChain]
      if (!chainConfig) {
        return { content: [{ type: 'text' as const, text: `Unsupported chain: ${selectedChain}` }], isError: true }
      }
      const tokenConfig = chainConfig.tokens[selectedToken]
      if (!tokenConfig) {
        return { content: [{ type: 'text' as const, text: `Token ${selectedToken} not available on ${selectedChain}` }], isError: true }
      }

      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)

      // Step 1: Get crypto pricing from the configured remote endpoint
      const pricing = await getCloudCryptoPrices(cloudRoomId)
      if (!pricing) {
        return { content: [{ type: 'text' as const, text: 'Crypto payments are not available.' }], isError: true }
      }

      const tierInfo = pricing.tiers.find(t => t.tier === tier)
      if (!tierInfo) {
        return { content: [{ type: 'text' as const, text: `Unknown tier: ${tier}` }], isError: true }
      }

      // Step 2: Send stablecoin to treasury
      const db = getMcpDatabase()
      let txHash: string
      let auditSuffix = ''
      try {
        txHash = await sendToken(
          db, roomId, pricing.treasuryAddress,
          tierInfo.cryptoPrice.toString(), encryptionKey,
          selectedChain, tokenConfig.address, tokenConfig.decimals
        )
        const audit = recordPaymentAudit(
          db,
          roomId,
          `Station crypto payment: create "${name}" (${tier}), paid ${tierInfo.cryptoPrice} ${selectedToken.toUpperCase()} on ${selectedChain} to ${pricing.treasuryAddress}, tx: ${txHash}`
        )
        auditSuffix = formatPaymentAuditSuffix(audit)
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Token transfer failed: ${(e as Error).message}` }],
          isError: true
        }
      }

      // Step 3: Submit tx hash to Cloud for verification + provisioning
      const result = await cryptoCheckoutStation(cloudRoomId, tier, name, txHash, selectedChain)
      if (!result.ok) {
        return {
          content: [{
            type: 'text' as const,
            text: `Payment sent (tx: ${txHash}) but provisioning failed: ${result.error}. Contact support with this tx hash.${auditSuffix}`
          }],
          isError: true
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Station "${name}" (${tier}) provisioned via crypto. `
            + `Paid ${tierInfo.cryptoPrice} ${selectedToken.toUpperCase()} on ${selectedChain}, tx: ${txHash}, expires: ${result.currentPeriodEnd}${auditSuffix}`
        }]
      }
    }
  )

  server.registerTool(
    'company_station_renew_crypto',
    {
      title: 'Renew Station (Crypto)',
      description: 'Renew a crypto-paid Station 订阅 by sending USDC or USDT on any supported chain. '
        + 'Only works for Station originally paid with crypto. '
        + 'Extends the Station by 30 days. '
        + 'Supported chains: base, ethereum, arbitrum, optimism, polygon. Tokens: usdc, usdt. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence.',
      inputSchema: {
        roomId: z.number().describe('公司 ID'),
        id: z.number().describe('The Station 订阅 ID to renew'),
        encryptionKey: z.string().min(1).describe('Wallet encryption key for sending stablecoin'),
        chain: z.enum(['base', 'ethereum', 'arbitrum', 'optimism', 'polygon']).optional()
          .describe('Chain to pay on (default: base)'),
        token: z.enum(['usdc', 'usdt']).optional()
          .describe('Token to pay with (default: usdc)')
      }
    },
    async ({ roomId, id, encryptionKey, chain, token }) => {
      if (!isCloudMode()) return CLOUD_ONLY
      const selectedChain = chain ?? 'base'
      const selectedToken = token ?? 'usdc'

      const chainConfig = CHAIN_CONFIGS[selectedChain]
      if (!chainConfig) {
        return { content: [{ type: 'text' as const, text: `Unsupported chain: ${selectedChain}` }], isError: true }
      }
      const tokenConfig = chainConfig.tokens[selectedToken]
      if (!tokenConfig) {
        return { content: [{ type: 'text' as const, text: `Token ${selectedToken} not available on ${selectedChain}` }], isError: true }
      }

      await bootstrapRoomToken(roomId)
      const cloudRoomId = getRoomCloudId(roomId)

      // Get the Station to find its tier
      const stations = await listCloudStations(cloudRoomId)
      const station = stations.find(s => s.id === id)
      if (!station) {
        return { content: [{ type: 'text' as const, text: `Station ${id} 未找到.` }], isError: true }
      }

      // Get crypto pricing
      const pricing = await getCloudCryptoPrices(cloudRoomId)
      if (!pricing) {
        return { content: [{ type: 'text' as const, text: 'Crypto payments are not available.' }], isError: true }
      }

      const tierInfo = pricing.tiers.find(t => t.tier === station.tier)
      if (!tierInfo) {
        return { content: [{ type: 'text' as const, text: `Unknown tier: ${station.tier}` }], isError: true }
      }

      // Send stablecoin
      const db = getMcpDatabase()
      let txHash: string
      let auditSuffix = ''
      try {
        txHash = await sendToken(
          db, roomId, pricing.treasuryAddress,
          tierInfo.cryptoPrice.toString(), encryptionKey,
          selectedChain, tokenConfig.address, tokenConfig.decimals
        )
        const audit = recordPaymentAudit(
          db,
          roomId,
          `Station crypto payment: renew #${id} (${station.tier}), paid ${tierInfo.cryptoPrice} ${selectedToken.toUpperCase()} on ${selectedChain} to ${pricing.treasuryAddress}, tx: ${txHash}`
        )
        auditSuffix = formatPaymentAuditSuffix(audit)
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: `Token transfer failed: ${(e as Error).message}` }],
          isError: true
        }
      }

      // Submit renewal
      const result = await cryptoRenewStation(cloudRoomId, id, txHash, selectedChain)
      if (!result.ok) {
        return {
          content: [{
            type: 'text' as const,
            text: `Payment sent (tx: ${txHash}) but renewal failed: ${result.error}. Contact support with this tx hash.${auditSuffix}`
          }],
          isError: true
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Station ${id} renewed. Paid ${tierInfo.cryptoPrice} ${selectedToken.toUpperCase()} on ${selectedChain}, tx: ${txHash}, new expiry: ${result.currentPeriodEnd}${auditSuffix}`
        }]
      }
    }
  )
}
