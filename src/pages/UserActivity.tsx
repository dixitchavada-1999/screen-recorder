import { useState } from 'react'
import type { TrackedPerson } from '@shared/types'
import { TrackingPolicyDialog } from '@/components/TrackingPolicyDialog'
import { UserPermissionsDialog } from '@/components/UserPermissionsDialog'
import { UserActivityDialog } from '@/components/UserActivityDialog'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Select, Toggle } from '@/components/ui/Controls'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { useRoles } from '@/hooks/useRoles'
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
  const { people, loading, error, busy, setPolicy, refresh } = useTrackedPeople()
  const [viewing, setViewing] = useState<TrackedPerson | null>(null)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [changingRole, setChangingRole] = useState<string | null>(null)
  const [permissionsFor, setPermissionsFor] = useState<TrackedPerson | null>(null)
  const { settings, updateSettings } = useSettings()
  const { user, can } = useAuth()
  const { push } = useToast()

  // The roles a person can be moved onto. Read here rather than passed in,
  // because this is the only screen that hands one out.
  const roles = useRoles()

  const assign = async (person: TrackedPerson, roleKey: string): Promise<void> => {
    setChangingRole(person.id)
    try {
      await window.api.roles.setUserRole(person.id, roleKey).then((result) => {
        if (!result.ok) throw result.error
      })
      await refresh()

      const label = roles.roles.find((role) => role.key === roleKey)?.label ?? roleKey
      push({
        tone: 'info',
        title: `${person.name} is now ${label}`,
        description: 'Their app picks it up the next time they open the window.'
      })
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({
        tone: 'error',
        title: failure.message,
        ...(failure.hint ? { description: failure.hint } : {})
      })
    } finally {
      setChangingRole(null)
    }
  }

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
                    <p className="truncate text-[11px] text-faint">{person.email}</p>
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

                  {/*
                    Their own row has no picker. A super admin who could demote
                    themselves is one mis-click from a system nobody can
                    administer — the server refuses it too.
                  */}
                  {can('roles.assign') && person.id !== user?.id && roles.roles.length > 0 && (
                    <Select
                      aria-label={`Role for ${person.name}`}
                      value={person.roleKey}
                      disabled={changingRole === person.id}
                      options={roles.roles.map((role) => ({
                        value: role.key,
                        label: role.label
                      }))}
                      onValueChange={(roleKey) => void assign(person, roleKey)}
                      className="h-8 w-36 text-xs"
                    />
                  )}

                  {/*
                    Their role decides most of it; this is for the one person it
                    does not fit. Beside the role picker on purpose — the two
                    are the same question asked at different resolutions.
                  */}
                  {can('roles.assign') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setPermissionsFor(person)}
                    >
                      Permissions
                    </Button>
                  )}

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

      <UserPermissionsDialog person={permissionsFor} onClose={() => setPermissionsFor(null)} />

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
