/**
 * Rate limiting middleware tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createRateLimiter,
  apiRateLimiter,
  expensiveRateLimiter,
  authRateLimiter,
  getRateLimitHeaders,
  resetRateLimit,
  getRateLimitStats,
  DEFAULT_LIMITS,
} from '../../middleware/rate-limit'

// Mock IncomingMessage
class MockIncomingMessage {
  method = 'GET'
  headers: Record<string, string | string[]> = {}
  socket = {
    remoteAddress: '127.0.0.1',
  }

  constructor(opts: Partial<MockIncomingMessage> = {}) {
    Object.assign(this, opts)
  }
}

describe('Rate Limiter', () => {
  beforeEach(() => {
    // Clear all rate limit buckets before each test
    const stats = getRateLimitStats()
    for (const bucket of stats.buckets) {
      resetRateLimit(bucket.key)
    }
  })

  describe('createRateLimiter', () => {
    it('should allow requests within limit', () => {
      const limiter = createRateLimiter({
        maxRequests: 5,
        windowMs: 1000,
      })

      const req = new MockIncomingMessage()
      const result = limiter(req)

      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(4)
      expect(result.limit).toBe(5)
    })

    it('should block requests exceeding limit', () => {
      const limiter = createRateLimiter({
        maxRequests: 3,
        windowMs: 1000,
      })

      const req = new MockIncomingMessage()

      // First 3 requests should be allowed
      expect(limiter(req).allowed).toBe(true)
      expect(limiter(req).allowed).toBe(true)
      expect(limiter(req).allowed).toBe(true)

      // 4th request should be blocked
      const result = limiter(req)
      expect(result.allowed).toBe(false)
      expect(result.remaining).toBe(0)
    })

    it('should reset bucket after window expires', async () => {
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowMs: 100, // Short window for testing
      })

      const req = new MockIncomingMessage()

      // Exhaust limit
      expect(limiter(req).allowed).toBe(true)
      expect(limiter(req).allowed).toBe(true)
      expect(limiter(req).allowed).toBe(false)

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      // Should be allowed again
      expect(limiter(req).allowed).toBe(true)
    })

    it('should use custom key generator', () => {
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        keyGenerator: (req) => {
          const authHeader = req.headers['authorization']
          if (authHeader && typeof authHeader === 'string') {
            return `user:${authHeader.slice(-10)}`
          }
          return 'anonymous'
        },
      })

      const req1 = new MockIncomingMessage({
        headers: { authorization: 'Bearer token123' },
      })
      const req2 = new MockIncomingMessage({
        headers: { authorization: 'Bearer token456' },
      })

      // Each user should have their own limit
      expect(limiter(req1).allowed).toBe(true)
      expect(limiter(req1).allowed).toBe(true)
      expect(limiter(req1).allowed).toBe(false)

      // Different token should still be allowed
      expect(limiter(req2).allowed).toBe(true)
    })

    it('should extract X-Forwarded-For header', () => {
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        keyGenerator: (req) => req.headers['x-forwarded-for'] as string || 'unknown',
      })

      const req1 = new MockIncomingMessage({
        headers: { 'x-forwarded-for': '192.168.1.100' },
      })
      const req2 = new MockIncomingMessage({
        headers: { 'x-forwarded-for': '192.168.1.200' },
      })

      // Each IP should have its own limit
      expect(limiter(req1).allowed).toBe(true)
      expect(limiter(req1).allowed).toBe(true)
      expect(limiter(req1).allowed).toBe(false)

      // Different IP should still be allowed
      expect(limiter(req2).allowed).toBe(true)
    })
  })

  describe('apiRateLimiter', () => {
    it('should use default API limits', () => {
      const req = new MockIncomingMessage()
      const result = apiRateLimiter(req)

      expect(result.limit).toBe(DEFAULT_LIMITS.api.maxRequests)
      expect(result.allowed).toBe(true)
    })
  })

  describe('expensiveRateLimiter', () => {
    it('should use token from auth header when available', () => {
      const req = new MockIncomingMessage({
        headers: { authorization: 'Bearer abc123def456' },
      })
      const result = expensiveRateLimiter(req)

      expect(result.allowed).toBe(true)
      expect(result.limit).toBe(DEFAULT_LIMITS.expensive.maxRequests)
    })

    it('should fall back to IP when no auth header', () => {
      const req = new MockIncomingMessage()
      const result = expensiveRateLimiter(req)

      expect(result.allowed).toBe(true)
    })
  })

  describe('authRateLimiter', () => {
    it('should use strict auth limits', () => {
      const req = new MockIncomingMessage()
      const result = authRateLimiter(req)

      expect(result.limit).toBe(DEFAULT_LIMITS.auth.maxRequests)
      expect(result.allowed).toBe(true)
    })
  })

  describe('getRateLimitHeaders', () => {
    it('should convert result to headers object', () => {
      const result = {
        allowed: true,
        limit: 100,
        remaining: 95,
        resetAt: Date.now() + 60000,
      }
      const headers = getRateLimitHeaders(result)

      expect(headers['X-RateLimit-Limit']).toBe('100')
      expect(headers['X-RateLimit-Remaining']).toBe('95')
      expect(headers['X-RateLimit-Reset']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('resetRateLimit', () => {
    it('should reset specific bucket', () => {
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowMs: 1000,
      })
      const req = new MockIncomingMessage()

      // Exhaust limit
      limiter(req)
      limiter(req)
      const blocked = limiter(req)
      expect(blocked.allowed).toBe(false)

      // Reset and try again
      const key = '127.0.0.1:2:1000'
      resetRateLimit(key)

      const result = limiter(req)
      expect(result.allowed).toBe(true)
    })
  })

  describe('getRateLimitStats', () => {
    it('should return bucket statistics', () => {
      const limiter = createRateLimiter({
        maxRequests: 10,
        windowMs: 1000,
      })
      const req = new MockIncomingMessage()

      limiter(req)
      limiter(req)

      const stats = getRateLimitStats()
      expect(stats.totalBuckets).toBeGreaterThan(0)
      expect(stats.buckets).toBeDefined()
      expect(stats.buckets.length).toBeGreaterThan(0)
    })
  })

  describe('X-Forwarded-For handling', () => {
    it('should handle multiple IPs in X-Forwarded-For', () => {
      const limiter = createRateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        keyGenerator: (req) => {
          const forwarded = req.headers['x-forwarded-for']
          if (forwarded && typeof forwarded === 'string') {
            return forwarded.split(',')[0].trim()
          }
          return 'unknown'
        },
      })

      const req = new MockIncomingMessage({
        headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.1, 192.0.2.1' },
      })

      // Should use first IP
      const result1 = limiter(req)
      expect(result1.allowed).toBe(true)

      const result2 = limiter(req)
      expect(result2.allowed).toBe(true)

      const result3 = limiter(req)
      expect(result3.allowed).toBe(false)
    })
  })
})
