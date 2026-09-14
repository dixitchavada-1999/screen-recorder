import { useCallback, useEffect, useState } from 'react'
import type { McpServerStatus } from '@shared/types'
import { log, unwrap } from '@/services/ipc'

export interface McpServerHandle {
  status: McpServerStatus | null
  loading: boolean
  regenerating: boolean
  refresh: () => Promise<void>
  regenerateToken: () => Promise<void>
}

/** The local MCP server's status, and the action that rotates its token. */
export function useMcpServer(): McpServerHandle {
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await unwrap(window.api.mcp.getStatus()))
    } catch (error) {
      log.warn('mcp', 'Could not read the local MCP server status', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const regenerateToken = useCallback(async () => {
    setRegenerating(true)
    try {
      setStatus(await unwrap(window.api.mcp.regenerateToken()))
    } finally {
      setRegenerating(false)
    }
  }, [])

  return { status, loading, regenerating, refresh, regenerateToken }
}
