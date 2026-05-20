/**
 * Rate limiting middleware for API endpoints
 *
 * Implements a token bucket algorithm with configurable limits per route/client.
 * Provides in-memory rate limiting with automatic cleanup of expired buckets.
 */

import type { IncomingMessage } from 'node:http'

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number
  /** Time window in milliseconds */
  windowMs: number
  /** Custom key generator (defaults to client IP) */
  keyGenerator?: (req: IncomingMessage) => string
  /** Whether to skip successful requests from counting against the limit */
  skipSuccessfulRequests?: boolean
  /** Custom handler when rate limit is exceeded */
  handler?: (req: IncomingMessage) => { status: number; data: unknown }
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
}

interface RateBucket {
  count: number
  resetAt: number
}

// Default rate limit configurations
export const DEFAULT_LIMITS = {
  // General API endpoints: 100 requests per minute
  api: { maxRequests: 100, windowMs: 60_000 },
  // Expensive operations (e.g., LLM calls): 10 requests per minute
  expensive: { maxRequests: 10, windowMs: 60_000 },
  // Webhooks: 30 requests per minute (existing behavior)
  webhook: { maxRequests: 30, windowMs: 60_000 },
  // Authentication endpoints: 10 requests per 5 minutes
  auth: { maxRequests: 10, windowMs: 300_000 },
} as const

// In-memory store for rate limit buckets
const rateBuckets = new Map<string, RateBucket>()

// Cleanup interval: remove expired buckets every 2 minutes
const CLEANUP_INTERVAL_MS = 120_000

setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) {
      rateBuckets.delete(key)
      cleaned++
    }
  }
  if (cleaned > 0 && process.env.COMPANY_DEBUG_RATE_LIMIT) {
    console.log(`[RateLimit] Cleaned up ${cleaned} expired buckets`)
  }
}, CLEANUP_INTERVAL_MS).unref()

/**
 * Extract client IP address from request
 */
function getClientIp(req: IncomingMessage): string {
  // Check for forwarded headers (for proxied requests)
  const forwardedFor = req.headers['x-forwarded-for']
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, use the first one
    const firstIp = (typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0]).split(',')[0].trim()
    if (firstIp) return firstIp
  }

  // Check for real IP header
  const realIp = req.headers['x-real-ip']
  if (realIp) {
    const ip = typeof realIp === 'string' ? realIp : realIp[0]
    if (ip) return ip.trim()
  }

  // Fall back to remote address
  const socket = req.socket
  if (socket && socket.remoteAddress) {
    return socket.remoteAddress
  }

  // Ultimate fallback
  return 'unknown'
}

/**
 * Create a rate limiter for a specific route or use case
 */
export function createRateLimiter(config: RateLimitConfig) {
  const {
    maxRequests,
    windowMs,
    keyGenerator = (req: IncomingMessage) => getClientIp(req),
    skipSuccessfulRequests = false,
    handler,
  } = config

  return function rateLimit(req: IncomingMessage): RateLimitResult {
    // Configuration options (unused in current implementation but available for future use)
    void skipSuccessfulRequests
    void handler
    const key = `${keyGenerator(req)}:${maxRequests}:${windowMs}`
    const now = Date.now()

    let bucket = rateBuckets.get(key)

    // Create new bucket if expired or doesn't exist
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs }
      rateBuckets.set(key, bucket)
    }

    // Check if limit exceeded
    const allowed = bucket.count < maxRequests

    if (allowed) {
      bucket.count++
    }

    const remaining = Math.max(0, maxRequests - bucket.count)

    if (process.env.COMPANY_DEBUG_RATE_LIMIT && !allowed) {
      console.log(
        `[RateLimit] Limit exceeded for ${key}: ${bucket.count}/${maxRequests} (resets at ${new Date(bucket.resetAt).toISOString()})`
      )
    }

    return {
      allowed,
      limit: maxRequests,
      remaining,
      resetAt: bucket.resetAt,
    }
  }
}

/**
 * Rate limiter specifically for API endpoints
 */
export const apiRateLimiter = createRateLimiter({
  ...DEFAULT_LIMITS.api,
  handler: () => ({ status: 429, data: { error: 'Too many requests. Please try again later.' } }),
})

/**
 * Rate limiter for expensive operations (LLM calls, etc.)
 */
export const expensiveRateLimiter = createRateLimiter({
  ...DEFAULT_LIMITS.expensive,
  keyGenerator: (req) => {
    // Use API token for more granular limiting if available
    const authHeader = req.headers['authorization']
    if (authHeader && typeof authHeader === 'string') {
      const token = authHeader.replace(/^Bearer\s+/i, '').slice(0, 16)
      return `expensive:${token}`
    }
    return `expensive:${getClientIp(req)}`
  },
  handler: () => ({
    status: 429,
    data: { error: 'Rate limit exceeded for expensive operations. Please wait before trying again.' },
  }),
})

/**
 * Rate limiter for authentication endpoints
 */
export const authRateLimiter = createRateLimiter({
  ...DEFAULT_LIMITS.auth,
  handler: () => ({
    status: 429,
    data: { error: 'Too many authentication attempts. Please try again later.' },
  }),
})

/**
 * Get rate limit info for response headers
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': new Date(result.resetAt).toISOString(),
  }
}

/**
 * Reset rate limit for a specific key (for testing/admin purposes)
 */
export function resetRateLimit(key: string): void {
  rateBuckets.delete(key)
}

/**
 * Get current rate limit statistics
 */
export function getRateLimitStats(): { totalBuckets: number; buckets: Array<{ key: string; count: number; resetAt: number }> } {
  return {
    totalBuckets: rateBuckets.size,
    buckets: Array.from(rateBuckets.entries()).map(([key, bucket]) => ({
      key,
      count: bucket.count,
      resetAt: bucket.resetAt,
    })),
  }
}
