import { useState } from 'react'
import type { TrackedPerson } from '@shared/types'
import { TrackingPolicyDialog } from '@/components/TrackingPolicyDialog'
import { UserActivityDialog } from '@/components/UserActivityDialog'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Controls'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { useTrackedPeople } from '@/hooks/useTrackedPeople'
import { toSerializedError } from '@/services/ipc'
import { cn } from '@/utils/cn'

/**
 * The administrator's view of who is tracked.
 *
 * Both switches live on the person's row and are written to their profile, so
 * flipping one here reaches that person's machine on its own — no restart, no
 * local setting, nothing for them to undo.
 *
 * Reachable only by a super admin, and the database enforces that
 * independently: hiding the menu item is a courtesy, the policies are the
 * protection.
 */
export function UserActivity(): React.JSX.Element {
  const { people, loading, error, busy, setPolicy } = useTrackedPeople()
  const [viewing, setViewing] = useState<TrackedPerson | null>(null)
  const [policyOpen, setPolicyOpen] = useState(false)
  const { settings, updateSettings } = useSettings()
  const { push } = useToast()

  const change = async (
    person: TrackedPerson,
    patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean },
    what: string
  ): Promise<void> => {
    try {
      await setPolicy(person.id, patch)
      push({ tone: 'info', title: `${what} for ${person.name}` })
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({
        tone: 'error',
        title: failure.message,
        ...(failure.hint ? { description: failure.hint } : {})
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="User activity"
        description="Who is tracked, and what their day looked like. Switching these writes to the person's account — their machine picks it up within a couple of minutes."
        actions={
          <Button size="sm" variant="ghost" onClick={() => setPolicyOpen(true)}>
            Tracking settings
          </Button>
        }
      >
        {error ? (
          <div className="rounded-xl border border-record/40 bg-record/10 px-3 py-2.5">
            <p className="text-xs font-medium text-record-strong">{error.message}</p>
            {error.hint && <p className="mt-0.5 text-xs text-muted">{error.hint}</p>}
          </div>
        ) : loading ? (
          <p className="text-xs text-faint">Loading…</p>
        ) : people.length === 0 ? (
          <p className="text-xs text-faint">No accounts yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {people.map((person) => (
              <li
                key={person.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5',
                  person.trackingEnabled
                    ? 'border-warning/40 bg-warning/5'
                    : 'border-hairline bg-surface'
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      person.trackingEnabled ? 'bg-warning' : 'bg-faint'
                    )}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{person.name}</p>
                    <p className="truncate text-[11px] text-faint">
                      {person.email}
                      {person.role === 'super_admin' && ' · super admin'}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-4">
                  <Toggle
                    label="Tracking"
                    checked={person.trackingEnabled}
                    disabled={busy === person.id}
                    onCheckedChange={(trackingEnabled) =>
                      void change(
                        person,
                        { trackingEnabled },
                        trackingEnabled ? 'Tracking on' : 'Tracking off'
                      )
                    }
                  />

                  {/* Meaningless without tracking, and the server clears it
                      anyway — so it is disabled rather than quietly ignored. */}
                  <Toggle
                    label="Screenshots"
                    checked={person.screenshotsEnabled}
                    disabled={busy === person.id || !person.trackingEnabled}
                    onCheckedChange={(screenshotsEnabled) =>
                      void change(
                        person,
                        { screenshotsEnabled },
                        screenshotsEnabled ? 'Screenshots on' : 'Screenshots off'
                      )
                    }
                  />

                  <Button size="sm" variant="secondary" onClick={() => setViewing(person)}>
                    View activity
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

      </Card>

      <UserActivityDialog person={viewing} onClose={() => setViewing(null)} />

      {settings && (
        <TrackingPolicyDialog
          open={policyOpen}
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setPolicyOpen(false)}
        />
      )}
    </div>
  )
}
