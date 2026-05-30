#!/usr/bin/env node
import crypto from 'node:crypto'

function usage() {
  console.log(`Usage:
  node scripts/generate-cloud-token.mjs --url https://jianghu.example.com --role member

Options:
  --url <url>          Public base URL. Used to print a launch link.
  --role <role>        member or user. Default: member.
  --days <n>           Token lifetime in days. Default: 7.
  --user <id>          Stable user id. Default: public-member.
  --email <email>      Optional email claim.
  --name <name>        Optional display name claim.

Required environment:
  COMPANY_CLOUD_JWT_SECRET
  COMPANY_CLOUD_INSTANCE_ID
`)
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage()
  process.exit(0)
}

const secret = (process.env.COMPANY_CLOUD_JWT_SECRET || '').trim()
const instanceId = (process.env.COMPANY_CLOUD_INSTANCE_ID || '').trim()
if (!secret || !instanceId) {
  usage()
  process.exitCode = 1
  process.exit()
}

const role = arg('role', 'member').toLowerCase()
if (!['member', 'user'].includes(role)) {
  console.error('Invalid --role. Use "member" or "user".')
  process.exit(1)
}

const daysRaw = Number(arg('days', '7'))
const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 7
const now = Math.floor(Date.now() / 1000)
const payload = {
  iss: 'company-cloud',
  aud: 'company-runtime',
  sub: arg('user', role === 'user' ? 'owner' : 'public-member'),
  instanceId,
  role,
  email: arg('email', undefined),
  emailVerified: Boolean(arg('email', '')),
  name: arg('name', role === 'user' ? 'Owner' : 'Public Member'),
  nbf: now - 30,
  exp: now + Math.round(days * 24 * 60 * 60),
}

for (const key of Object.keys(payload)) {
  if (payload[key] === undefined || payload[key] === '') delete payload[key]
}

const header = { alg: 'HS256', typ: 'JWT' }
const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`
const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url')
const token = `${signingInput}.${signature}`
const url = arg('url')

console.log(`role=${role}`)
console.log(`expires=${new Date(payload.exp * 1000).toISOString()}`)
console.log(`token=${token}`)
if (url) {
  const launch = new URL(url)
  launch.searchParams.set('token', token)
  console.log(`launch_url=${launch.toString()}`)
}
