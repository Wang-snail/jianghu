import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { webFetch, webSearch } from '../../shared/web-tools'

export function registerWebTools(server: McpServer): void {
  server.registerTool(
    'company_web_search',
    {
      title: 'Web Search',
      description: 'Search public web information and return the top results. RESPONSE STYLE: summarize briefly.',
      inputSchema: {
        query: z.string().min(1).describe('Search query')
      }
    },
    async ({ query }) => {
      try {
        const results = await webSearch(query)
        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No results found.' }] }
        }
        const text = results
          .map((r, index) => `${index + 1}. ${r.title}\n${r.url}\n${r.snippet}`)
          .join('\n\n')
        return { content: [{ type: 'text' as const, text }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Web search error: ${(e as Error).message}` }], isError: true }
      }
    }
  )

  server.registerTool(
    'company_web_fetch',
    {
      title: 'Web Fetch',
      description: 'Fetch a public URL and return clean markdown text. RESPONSE STYLE: summarize briefly.',
      inputSchema: {
        url: z.string().min(1).describe('Full URL, usually starting with https://')
      }
    },
    async ({ url }) => {
      try {
        return { content: [{ type: 'text' as const, text: await webFetch(url) }] }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `Web fetch error: ${(e as Error).message}` }], isError: true }
      }
    }
  )
}
