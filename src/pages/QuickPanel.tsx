import { useCallback, useEffect, useState } from 'react'
import type { ScheduledCall, SerializedError, TaskDueToday } from '@shared/types'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { ToastProvider } from '@/context/ToastContext'
import { toSerializedError, unwrap } from '@/services/ipc'
import { cn } from '@/utils/cn'

/**
 * The quick panel the floating button opens, in its own window.
 *
 * Today at a glance: a tab each for today's calls and the tasks due today.
 * Read only — anything more is one click away in the app, and "View all"
 * opens the app on the section the current tab summarises.
 *
 * The window is built once at startup and kept hidden, so "on mount" would
 * mean "this morning". It re-reads every couple of minutes in the background
 * and again each time it slides in, and only redraws what actually changed.
 */
export function QuickPanelRoot(): React.JSX.Element {
  return (
    <ToastProvider>
      <AuthProvider>
        <QuickPanel />
      </AuthProvider>
    </ToastProvider>
  )
}

/** One section's worth of data, loaded independently of the others. */
interface Loaded<T> {
  items: T[]
  error: SerializedError | null
  loading: boolean
}

/** How often the hidden panel re-reads, so it opens on something recent. */
const BACKGROUND_REFRESH_MS = 2 * 60_000

/** Whether a fresh answer says exactly what is already on screen. */
function same<T>(a: Loaded<T>, b: Loaded<T>): boolean {
  return a.loading === b.loading && JSON.stringify([a.items, a.error]) === JSON.stringify([b.items, b.error])
}

const initial = <T,>(): Loaded<T> => ({ items: [], error: null, loading: true })

async function load<T>(request: () => Promise<T[]>): Promise<Loaded<T>> {
  try {
    return { items: await request(), error: null, loading: false }
  } catch (caught) {
    return { items: [], error: toSerializedError(caught), loading: false }
  }
}

/** Local midnight to the next, the same day the dashboard's "due today" means. */
function todayRange(): { from: string; to: string } {
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}

function QuickPanel(): React.JSX.Element {
  const { user, loading: authLoading, can } = useAuth()
  const canTasks = can('tasks.view')
  const canCalls = can('calendar.view')

  /*
   * Calls and tasks share one space, a tab each. Only the tabs
   * this person may see are offered; the choice is kept between openings,
   * because the window is never torn down.
   */
  const [tab, setTab] = useState<PanelTab>('calls')

  const [tasks, setTasks] = useState<Loaded<TaskDueToday>>(initial)
  const [calls, setCalls] = useState<Loaded<ScheduledCall>>(initial)

  /*
   * Keyed on who is signed in, not on the account object. Focusing the panel
   * re-reads the account (AuthProvider), which hands back a new object with the
   * same contents every time — keyed on that, every open fetched twice and the
   * lists visibly redrew a moment after the panel appeared.
   */
  const userId = user?.id ?? null

  /** Reads both, and puts them on screen together in one render. */
  const refresh = useCallback(async (): Promise<void> => {
    if (!userId) return

    const [nextTasks, nextCalls] = await Promise.all([
      canTasks ? load(() => unwrap(window.api.tasks.dueToday())) : null,
      canCalls ? load(() => unwrap(window.api.calls.list(todayRange(), 'assigned'))) : null
    ])

    // Only what actually changed is put back. The panel opens on what it last
    // showed, so an identical answer must not redraw it under the person.
    if (nextTasks) setTasks((current) => (same(current, nextTasks) ? current : nextTasks))
    if (nextCalls) setCalls((current) => (same(current, nextCalls) ? current : nextCalls))
  }, [userId, canTasks, canCalls])

  // First load, and again whenever who is signed in or what they may see changes.
  useEffect(() => {
    void refresh()
  }, [refresh])

  /*
   * Kept current in the background too, so opening it is instant and what it
   * opens on is at most a couple of minutes old. Opening it re-reads as well,
   * and anything new lands in place a moment later.
   */
  useEffect(() => {
    const timer = setInterval(() => void refresh(), BACKGROUND_REFRESH_MS)
    const unsubscribe = window.api.panel.onShown(() => void refresh())
    return () => {
      clearInterval(timer)
      unsubscribe()
    }
  }, [refresh])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') window.api.panel.hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tabs: Array<{ id: PanelTab; label: string; count: number }> = [
    ...(canCalls ? [{ id: 'calls' as const, label: "Today's calls", count: calls.items.length }] : []),
    ...(canTasks ? [{ id: 'tasks' as const, label: "Today's tasks", count: tasks.items.length }] : [])
  ]
  // Falls back to whichever tab is on offer when the chosen one is not.
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : (tabs[0]?.id ?? 'calls')

  const today = new Date().toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  })

  return (
    <div className="h-full p-px">
      <div
        className="flex h-full flex-col overflow-hidden rounded-xl border border-hairline bg-canvas-elevated shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-ink">Today</h1>
            <p className="truncate text-[11px] text-faint">{today}</p>
          </div>

          <button
            type="button"
            onClick={() => window.api.panel.openApp()}
            className="rounded-lg border border-hairline px-2.5 py-1 text-xs text-muted transition hover:bg-surface hover:text-ink"
          >
            Open app
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {authLoading ? (
            <Empty>Loading…</Empty>
          ) : !user ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted">Sign in to see your calls and tasks.</p>
              <button
                type="button"
                onClick={() => window.api.panel.openApp()}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-strong"
              >
                Open app to sign in
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {tabs.length === 0 && <Empty>Nothing to show here.</Empty>}

              {tabs.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <div role="tablist" className="flex gap-1 rounded-lg bg-surface/60 p-0.5">
                      {tabs.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          role="tab"
                          aria-selected={entry.id === activeTab}
                          onClick={() => setTab(entry.id)}
                          className={cn(
                            'rounded-md px-2.5 py-1 text-xs font-medium transition',
                            entry.id === activeTab
                              ? 'bg-accent/15 text-accent-strong'
                              : 'text-muted hover:text-ink'
                          )}
                        >
                          {entry.label}
                          {entry.count > 0 && (
                            <span className="ml-1.5 font-normal text-faint">{entry.count}</span>
                          )}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => window.api.panel.openApp(activeTab)}
                      className="text-[11px] text-accent-strong transition hover:text-ink"
                    >
                      View all
                    </button>
                  </div>

                  {activeTab === 'calls' ? (
                    <List data={calls} empty="No calls today.">
                      {(call) => <CallRow key={call.id} call={call} />}
                    </List>
                  ) : (
                    <List data={tasks} empty="Nothing due today.">
                      {(task) => <TaskRow key={task.id} task={task} />}
                    </List>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const TILE = 'rounded-lg border border-hairline bg-surface/60 px-3 py-2.5'

/** The panel's two tabs; each is also the app section "View all" opens. */
type PanelTab = 'calls' | 'tasks'

/** A section's items, or why there are none: failed, still loading, or empty. */
function List<T>({
  data,
  empty,
  children
}: {
  data: Loaded<T>
  empty: string
  children: (item: T) => React.ReactNode
}): React.JSX.Element {
  if (data.error) {
    return (
      <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
        {data.error.message}
        {data.error.hint ? ` — ${data.error.hint}` : ''}
      </p>
    )
  }

  if (data.loading && data.items.length === 0) return <Empty>Loading…</Empty>
  if (data.items.length === 0) return <Empty>{empty}</Empty>

  return <ul className="flex flex-col gap-2">{data.items.map(children)}</ul>
}

function TaskRow({ task }: { task: TaskDueToday }): React.JSX.Element {
  return (
    <li className={TILE}>
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 break-words text-[13px] font-medium leading-snug text-ink">
          {task.title}
        </p>
        {task.priority !== 'normal' && (
          <span
            className={cn(
              'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] capitalize',
              task.priority === 'urgent' || task.priority === 'high'
                ? 'border-record/40 text-record-strong'
                : 'border-hairline text-muted'
            )}
          >
            {task.priority}
          </span>
        )}
      </div>
      <p className="mt-1 truncate text-[11px] text-faint">{task.boardName}</p>
    </li>
  )
}

function CallRow({ call }: { call: ScheduledCall }): React.JSX.Element {
  const start = new Date(call.startsAt)
  const end = new Date(start.getTime() + call.durationMinutes * 60_000)
  const now = Date.now()
  const live = call.status === 'scheduled' && start.getTime() <= now && now < end.getTime()
  const time = (at: Date): string => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <li className={cn(TILE, 'flex items-center gap-3', call.status === 'cancelled' && 'opacity-60')}>
      <div className="w-14 shrink-0 text-center">
        <p className={cn('text-[13px] font-semibold', live ? 'text-positive' : 'text-ink')}>
          {time(start)}
        </p>
        <p className="text-[10px] text-faint">{call.durationMinutes} min</p>
      </div>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[13px] font-medium text-ink',
            call.status === 'cancelled' && 'line-through'
          )}
        >
          {call.title}
        </p>
        <p className="truncate text-[11px] text-faint">
          {live ? 'Happening now' : call.status !== 'scheduled' ? `${call.status.charAt(0).toUpperCase()}${call.status.slice(1)}` : `until ${time(end)}`}
          {call.assignees.length > 0 && ` · ${call.assignees.map((person) => person.name).join(', ')}`}
        </p>
      </div>
    </li>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg border border-dashed border-hairline px-3 py-3 text-center text-xs text-faint">
      {children}
    </p>
  )
}
