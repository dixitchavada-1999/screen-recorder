import { useEffect, useState } from 'react'
import type { PermissionInfo, TrackedPerson, UserPermission } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/context/ToastContext'
import { useRoles } from '@/hooks/useRoles'
import { toSerializedError, unwrap } from '@/services/ipc'
import { cn } from '@/utils/cn'

/** How a module's key reads as a heading. Anything unlisted uses its own key. */
const MODULE_LABELS: Record<string, string> = {
  tasks: 'Task Manager',
  project: 'Inside a project',
  roles: 'Roles'
}

/** The three answers a single permission can have for one person. */
type Setting = 'inherit' | 'allow' | 'deny'

interface UserPermissionsDialogProps {
  person: TrackedPerson | null
  onClose: () => void
}

/**
 * What one person may do, over and above their role.
 *
 * Roles answer "what does somebody like this get?" and cannot answer "what does
 * *this* person get?". Making a role for every exception ends as twenty roles
 * nobody can tell apart, so the exceptions live here instead.
 *
 * Three states rather than a checkbox, because two of them are not the same
 * thing: **Role** is "whatever their role says, now and if it changes", while
 * **Allow** and **Deny** are this person's own answer and outlive any role
 * change. A tick box could not tell those apart, and the difference is the
 * whole reason to be on this screen.
 *
 * Nothing is written until Save — one call, not one per box.
 */
export function UserPermissionsDialog({
  person,
  onClose
}: UserPermissionsDialogProps): React.JSX.Element {
  const roles = useRoles()
  const { push } = useToast()

  const [settings, setSettings] = useState<Record<string, Setting>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const role = roles.roles.find((entry) => entry.key === person?.roleKey) ?? null

  useEffect(() => {
    if (!person) return

    let cancelled = false
    setLoading(true)
    setDirty(false)

    void unwrap(window.api.roles.userPermissions(person.id))
      .then((overrides: UserPermission[]) => {
        if (cancelled) return
        const next: Record<string, Setting> = {}
        for (const entry of overrides) {
          next[entry.permissionKey] = entry.granted ? 'allow' : 'deny'
        }
        setSettings(next)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        const failure = toSerializedError(caught)
        push({ tone: 'error', title: failure.message })
        setSettings({})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [person, push])

  const set = (key: string, setting: Setting): void => {
    setDirty(true)
    setSettings((current) => {
      const next = { ...current }
      // "Role" is the absence of an answer, so it is stored by not storing it.
      if (setting === 'inherit') delete next[key]
      else next[key] = setting
      return next
    })
  }

  /** What this person actually ends up with, which is what they will see. */
  const effective = (permission: PermissionInfo): boolean => {
    if (role?.fullAccess) return true
    const setting = settings[permission.key]
    if (setting === 'allow') return true
    if (setting === 'deny') return false
    return role?.permissions.includes(permission.key) ?? false
  }

  const save = async (): Promise<void> => {
    if (!person) return

    setSaving(true)
    try {
      await unwrap(
        window.api.roles.setUserPermissions(
          person.id,
          Object.entries(settings).map(([permissionKey, setting]) => ({
            permissionKey,
            granted: setting === 'allow'
          }))
        )
      )

      const count = Object.keys(settings).length
      push({
        tone: 'info',
        title: `${person.name} updated`,
        description:
          count === 0
            ? `Back on whatever ${role?.label ?? 'their role'} allows.`
            : `${count} ${count === 1 ? 'exception' : 'exceptions'} to their role.`
      })
      onClose()
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({
        tone: 'error',
        title: failure.message,
        ...(failure.hint ? { description: failure.hint } : {})
      })
    } finally {
      setSaving(false)
    }
  }

  const grouped = new Map<string, PermissionInfo[]>()
  for (const permission of roles.catalogue) {
    const list = grouped.get(permission.module) ?? []
    list.push(permission)
    grouped.set(permission.module, list)
  }

  return (
    <Modal
      open={person !== null}
      title={person ? `What ${person.name} may do` : 'Permissions'}
      description={role ? `On the ${role.label} role` : ''}
      onClose={onClose}
      className="w-[min(42rem,calc(100vw-3rem))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {dirty ? 'Cancel' : 'Close'}
          </Button>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      {loading && <p className="text-xs text-faint">Loading…</p>}

      {!loading && role?.fullAccess && (
        <p className="mb-3 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-accent-strong">
          This role answers yes to everything, so nothing set here would change what they can do.
        </p>
      )}

      {!loading &&
        [...grouped.entries()].map(([module, permissions]) => (
          <section key={module} className="mb-4 last:mb-0">
            <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-faint">
              {MODULE_LABELS[module] ?? module}
            </h3>

            <ul className="overflow-hidden rounded-xl border border-hairline">
              {permissions.map((permission) => {
                const setting = settings[permission.key] ?? 'inherit'
                const fromRole = role?.permissions.includes(permission.key) ?? false

                return (
                  <li
                    key={permission.key}
                    className="flex flex-wrap items-center gap-3 border-b border-hairline px-3 py-2.5 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">{permission.label}</p>
                      <p className="text-[11px] text-faint">
                        {effective(permission) ? 'Allowed' : 'Not allowed'}
                        {setting === 'inherit'
                          ? ` — from their role`
                          : ` — set for ${person?.name.split(' ')[0] ?? 'them'}`}
                      </p>
                    </div>

                    <div
                      role="radiogroup"
                      aria-label={permission.label}
                      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5"
                    >
                      {(
                        [
                          ['inherit', fromRole ? 'Role ✓' : 'Role ✕'],
                          ['allow', 'Allow'],
                          ['deny', 'Deny']
                        ] as ReadonlyArray<[Setting, string]>
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={setting === value}
                          disabled={role?.fullAccess}
                          onClick={() => set(permission.key, value)}
                          className={cn(
                            'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                            setting === value
                              ? value === 'deny'
                                ? 'bg-record text-white'
                                : value === 'allow'
                                  ? 'bg-accent text-white'
                                  : 'bg-canvas-elevated text-ink'
                              : 'text-muted hover:text-ink'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
    </Modal>
  )
}
