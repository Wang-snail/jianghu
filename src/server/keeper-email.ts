/**
 * Sends email through the configured local relay endpoint.
 * "admin" is resolved to the configured admin inbox when a relay is available.
 */
import * as queries from '../shared/db-queries'
import { getRoomCloudId, getStoredCloudRoomToken, ensureCloudRoomToken } from '../shared/cloud-sync'
import { insertClerkMessageAndEmit } from './clerk-message-events'

function getCloudApiBase(): string {
  return (process.env.COMPANY_CLOUD_API ?? 'http://127.0.0.1:4700/api/local-sync-disabled').replace(/\/+$/, '')
}

function getSettingTrimmed(db: Parameters<typeof queries.getSetting>[0], key: string): string {
  return (queries.getSetting(db, key) ?? '').trim()
}

function getKeeperUserNumber(db: Parameters<typeof queries.getSetting>[0]): number | null {
  const raw = getSettingTrimmed(db, 'keeper_user_number')
  if (!/^\d{5,6}$/.test(raw)) return null
  return Number.parseInt(raw, 10)
}

async function getAnyCloudRoomAuth(
  db: Parameters<typeof queries.getSetting>[0],
): Promise<{ cloudRoomId: string; roomToken: string } | null> {
  const rooms = queries.listRooms(db)
  if (rooms.length === 0) return null

  const keeperReferralCode = getSettingTrimmed(db, 'keeper_referral_code') || null

  for (const room of rooms) {
    const cloudRoomId = getRoomCloudId(room.id)
    let roomToken = getStoredCloudRoomToken(cloudRoomId)
    if (!roomToken) {
      const hasToken = await ensureCloudRoomToken({
        roomId: cloudRoomId,
        name: room.name,
        goal: room.goal ?? null,
        visibility: room.visibility,
        referredByCode: room.referredByCode,
        keeperReferralCode,
      })
      if (!hasToken) continue
      roomToken = getStoredCloudRoomToken(cloudRoomId)
    }
    if (!roomToken) continue
    return { cloudRoomId, roomToken }
  }

  return null
}

/**
 * Send email from clerk.{userNumber}@email.company.ai to any address.
 * Pass "admin" as `to` to send to the configured admin inbox.
 */
export async function sendKeeperEmail(
  db: Parameters<typeof queries.getSetting>[0],
  to: string,
  content: string,
  subject?: string,
): Promise<boolean> {
  const auth = await getAnyCloudRoomAuth(db)
  if (!auth) return false

  const userNumber = getKeeperUserNumber(db)

  const res = await fetch(`${getCloudApiBase()}/contacts/clerk-send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Room-Token': auth.roomToken,
    },
    body: JSON.stringify({
      roomId: auth.cloudRoomId,
      userNumber,
      to,
      subject: subject ?? 'Message from Clerk',
      body: content,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return false

  const payload = await res.json().catch(() => ({})) as { email?: string }
  const sent = payload.email === 'sent'
  if (sent) {
    insertClerkMessageAndEmit(db, 'assistant', content, 'email')
  }
  return sent
}
