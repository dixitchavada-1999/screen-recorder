import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useToast } from '@/context/ToastContext'
import { useGoogleAccounts } from '@/hooks/useGoogleAccounts'
import { toSerializedError, unwrap } from '@/services/ipc'
import { cn } from '@/utils/cn'
import { formatTimestamp } from '@/utils/format'

interface GoogleAccountsProps {
  /** False when the build carries no OAuth client; the section explains itself. */
  configured: boolean
}

/**
 * Connected Google Calendars.
 *
 * Deliberately a list rather than a single switch: the common case is a person
 * with a work address and one or two personal ones, all of whose meetings
 * belong in the same schedule. Each connection gets its own colour, which is
 * what identifies its calls once they are mixed into the calendar.
 *
 * Nothing is ever written back to Google — the app only reads.
 */
export function GoogleAccounts({ configured }: GoogleAccountsProps): React.JSX.Element {
  const { accounts, loading, busy, connect, disconnect } = useGoogleAccounts()
  const { push } = useToast()
  const [refreshing, setRefreshing] = useState(false)

  /**
   * Pulls this month again from every connected calendar.
   *
   * The Call Manager refreshes as you move through it, but that only helps
   * somebody already looking at the schedule. This is the same sync, offered
   * where a person is thinking about the accounts themselves — and it is what
   * reconnecting an account used to be misused for.
   */
  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const now = new Date()
      const from = new Date(now.getFullYear(), now.getMonth(), 1)
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 1)

      const result = await unwrap(
        window.api.google.sync({ from: from.toISOString(), to: to.toISOString() })
      )

      const changed = result.imported + result.updated + result.removed

      if (result.failures.length > 0) {
        push({
          tone: 'warning',
          title: `${result.failures.length} calendar${result.failures.length === 1 ? '' : 's'} could not be read`,
          description: result.failures.map((failure) => failure.email).join(', ')
        })
        return
      }

      push({
        tone: 'success',
        title: changed === 0 ? 'Calendars are up to date' : 'Calendars refreshed',
        description:
          changed === 0
            ? 'Nothing has changed since the last check.'
            : `${result.imported} added, ${result.updated} updated, ${result.removed} removed.`
      })
    } catch (caught) {
      push({ tone: 'error', title: toSerializedError(caught).message })
    } finally {
      setRefreshing(false)
    }
  }

  const handleConnect = async (reconnecting?: string): Promise<void> => {
    try {
      const account = await connect(reconnecting)
      push({
        tone: 'success',
        title: reconnecting ? `${account.email} reconnected` : `${account.email} connected`,
        description: reconnecting
          ? 'Its calendar is being read again.'
          : 'Its upcoming calls will appear in your calendar.'
      })
    } catch (caught) {
      const error = toSerializedError(caught)
      push({
        tone: 'error',
        title: error.message,
        ...(error.hint ? { description: error.hint } : {})
      })
    }
  }

  const handleDisconnect = async (email: string): Promise<void> => {
    try {
      await disconnect(email)
      push({
        tone: 'info',
        title: `${email} disconnected`,
        description: 'The calls imported from it have been removed.'
      })
    } catch (caught) {
      push({ tone: 'error', title: toSerializedError(caught).message })
    }
  }

  if (!configured) {
    return (
      <Card
        title="Google Calendar"
        description="Import calls from your Google calendars"
      >
        <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
          This build was packaged without a Google OAuth client, so the
          integration is unavailable. Add one in{' '}
          <code className="text-ink">electron/main/config/google.ts</code> and rebuild.
        </p>
      </Card>
    )
  }

  const connecting = busy === '__connecting__'

  return (
    <Card
      title="Google Calendar"
      description="Connect an account and its meetings become calls here. Read-only — nothing is written back."
      actions={
        <>
          {accounts.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              loading={refreshing}
              onClick={() => void handleRefresh()}
              title="Check every connected calendar for changes to this month"
            >
              Refresh
            </Button>
          )}

          <Button size="sm" variant="secondary" loading={connecting} onClick={() => void handleConnect()}>
            {accounts.length === 0 ? 'Connect account' : 'Connect another'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="text-xs text-faint">Loading…</p>
      ) : accounts.length === 0 ? (
        <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
          No calendars connected. Connect as many Google accounts as you like — every
          account&apos;s meetings land in the same schedule, each in its own colour.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li
              key={account.email}
              className={cn(
                'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5',
                account.expired
                  ? 'border-warning/40 bg-warning/5'
                  : 'border-hairline bg-surface'
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {/* The same colour this account's calls are drawn in. */}
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: account.color }}
                />
                <div className="min-w-0">
                  <p className="truncate text-xs text-ink">{account.email}</p>
                  {account.expired ? (
                    <p className="text-[11px] text-warning">
                      Google stopped renewing access — reconnect to resume syncing.
                    </p>
                  ) : (
                    <p className="text-[11px] text-faint">
                      Connected {formatTimestamp(Date.parse(account.connectedAt))}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                {account.expired && (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === account.email}
                    onClick={() => void handleConnect(account.email)}
                  >
                    Reconnect
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === account.email && !account.expired}
                  onClick={() => void handleDisconnect(account.email)}
                >
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {connecting && (
        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          Finish signing in in your browser. Pick the account you want to add — Google
          shows the chooser every time, so you can connect several.
        </p>
      )}
    </Card>
  )
}
