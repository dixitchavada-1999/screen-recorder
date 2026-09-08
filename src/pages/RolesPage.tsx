import { useEffect, useMemo, useState } from 'react'
import type { AppRole } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { useRoles } from '@/hooks/useRoles'
import { toSerializedError } from '@/services/ipc'
import { cn } from '@/utils/cn'

/** How a module's key reads as a heading. Anything unlisted uses its own key. */
const MODULE_LABELS: Record<string, string> = {
  tasks: 'Task Manager',
  project: 'Inside a project',
  roles: 'Roles'
}

/**
 * Roles, and what each one may do.
 *
 * The screen that makes access something a person edits rather than something a
 * release changes. Pick a role on the left, tick what it carries on the right.
 *
 * Ticks are collected, not sent. Writing on every box meant a round trip per
 * click — seven of them to set up a role, each one a moment where the screen
 * was waiting on the server. So the boxes edit a draft, and Save writes the
 * whole set once.
 *
 * The buttons only exist while the draft differs from what is stored, so there
 * is never a Save that would do nothing, and their appearing is itself the
 * signal that something is unsaved.
 *
 * A super admin sees the permission list greyed out against their own role.
 * That is not an oversight: `full_access` is not a permission and is not this
 * screen's to switch off, because switching it off is how nobody gets back in.
 */
export function RolesPage(): React.JSX.Element {
  const roles = useRoles()
  const { can } = useAuth()
  const { push } = useToast()

  /*
   * Reading the roles and changing them are two different permissions, so this
   * screen has a read-only shape: somebody can be shown what each role may do
   * without being able to alter it.
   */
  const canManage = can('roles.manage')

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AppRole | null>(null)

  /** The ticks as they stand on screen. Null while they match what is stored. */
  const [draft, setDraft] = useState<string[] | null>(null)
  /** A role waiting to be opened, once the unsaved draft is answered for. */
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  /*
   * Which modules are unrolled.
   *
   * Shut to begin with, and kept across a change of role — somebody working
   * through "Inside a project" for three roles in a row should not have to open
   * it three times. The count in each header is what makes a shut module still
   * worth reading.
   */
  const [openModules, setOpenModules] = useState<string[]>([])

  // Whatever is first, until something is chosen — a screen that opens on
  // nothing makes you click once before it says anything at all.
  useEffect(() => {
    if (selectedKey === null && roles.roles.length > 0) setSelectedKey(roles.roles[0]!.key)
  }, [roles.roles, selectedKey])

  const selected = roles.roles.find((role) => role.key === selectedKey) ?? null

  /** What the boxes show: the draft if one is being edited, otherwise the truth. */
  const shown = draft ?? selected?.permissions ?? []

  const dirty =
    draft !== null &&
    selected !== null &&
    (draft.length !== selected.permissions.length ||
      draft.some((key) => !selected.permissions.includes(key)))

  /*
   * Opening another role while a draft is unsaved asks first. Discarding it
   * silently would lose work at the one moment somebody is certain they made
   * some — the ticks are still on the screen they are leaving.
   */
  const open = (key: string): void => {
    if (key === selectedKey) return

    if (dirty) {
      setPendingKey(key)
      return
    }

    setDraft(null)
    setSelectedKey(key)
  }

  const grouped = useMemo(() => {
    const byModule = new Map<string, typeof roles.catalogue>()
    for (const permission of roles.catalogue) {
      const list = byModule.get(permission.module) ?? []
      list.push(permission)
      byModule.set(permission.module, list)
    }
    return [...byModule.entries()]
  }, [roles.catalogue])

  /** How many a role carries — the draft's count for the one being edited. */
  const countOf = (role: AppRole): number =>
    role.key === selectedKey && draft !== null ? draft.length : role.permissions.length

  const report = (caught: unknown): void => {
    const failure = toSerializedError(caught)
    push({
      tone: 'error',
      title: failure.message,
      ...(failure.hint ? { description: failure.hint } : {})
    })
  }

  const add = async (): Promise<void> => {
    const clean = name.trim()
    if (!clean) {
      setAdding(false)
      return
    }

    setBusy(true)
    try {
      const role = await roles.create(clean)
      setName('')
      setAdding(false)
      setDraft(null)
      setSelectedKey(role.key)
    } catch (caught) {
      report(caught)
    } finally {
      setBusy(false)
    }
  }

  /** Local only. Nothing leaves the window until Save. */
  const toggle = (permission: string): void => {
    if (!selected || selected.fullAccess || !canManage) return

    setDraft(
      shown.includes(permission)
        ? shown.filter((key) => key !== permission)
        : [...shown, permission]
    )
  }

  const save = async (): Promise<void> => {
    if (!selected || draft === null) return

    setSaving(true)
    try {
      await roles.setPermissions(selected.key, draft)
      setDraft(null)
      push({
        tone: 'info',
        title: `${selected.label} updated`,
        description: 'Everybody on this role is affected from their next action.'
      })
    } catch (caught) {
      report(caught)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!confirmDelete) return

    setBusy(true)
    try {
      await roles.remove(confirmDelete.key)
      if (selectedKey === confirmDelete.key) setSelectedKey(null)
      setConfirmDelete(null)
    } catch (caught) {
      report(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Roles"
      description={
        canManage
          ? 'What each role may do. Saved changes take effect at once, for everybody on that role.'
          : 'What each role may do. You can read this, but not change it.'
      }
      actions={
        canManage &&
        !adding && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            + New role
          </Button>
        )
      }
    >
      {adding && (
        <div className="mb-4 flex items-center gap-2">
          <input
            autoFocus
            value={name}
            maxLength={60}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add()
              if (event.key === 'Escape') {
                setName('')
                setAdding(false)
              }
            }}
            placeholder="e.g. Project viewer"
            className="selectable min-w-0 flex-1 rounded-xl border border-accent bg-surface px-3 py-2 text-sm text-ink"
          />

          <Button size="sm" variant="primary" loading={busy} onClick={() => void add()}>
            Create
          </Button>
        </div>
      )}

      {roles.loading && <p className="text-xs text-faint">Loading roles…</p>}

      {!roles.loading && roles.error && (
        <p className="text-xs text-record-strong">{roles.error.message}</p>
      )}

      {!roles.loading && !roles.error && (
        <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          {/* ------------------------------ Roles ----------------------------- */}
          <ul className="flex h-fit flex-col gap-1">
            {roles.roles.map((role) => (
              <li key={role.key}>
                <button
                  type="button"
                  onClick={() => open(role.key)}
                  className={cn(
                    'w-full rounded-xl px-3 py-2 text-left transition-colors',
                    role.key === selectedKey
                      ? 'bg-accent/15 text-accent-strong'
                      : 'text-muted hover:bg-surface hover:text-ink'
                  )}
                >
                  <span className="block truncate text-sm font-medium">{role.label}</span>
                  <span className="block text-[11px] text-faint">
                    {role.fullAccess
                      ? 'everything'
                      : `${countOf(role)} ${countOf(role) === 1 ? 'permission' : 'permissions'}${
                          role.key === selectedKey && dirty ? ' · unsaved' : ''
                        }`}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {/* --------------------------- Permissions -------------------------- */}
          <div className="min-w-0">
            {selected === null && <p className="text-xs text-faint">Pick a role.</p>}

            {selected && (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{selected.label}</p>
                    <p className="text-[11px] text-faint">
                      {selected.builtIn ? 'Built in — cannot be renamed or removed' : selected.key}
                    </p>
                  </div>

                  {canManage && !selected.builtIn && (
                    <Button size="sm" variant="danger" onClick={() => setConfirmDelete(selected)}>
                      Delete role
                    </Button>
                  )}
                </div>

                {selected.fullAccess && (
                  <p className="mb-3 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-accent-strong">
                    This role answers yes to everything, and that cannot be edited here. It is what
                    keeps this screen reachable — a super admin who could switch it off would be one
                    click from locking everybody out.
                  </p>
                )}

                {grouped.map(([module, permissions]) => {
                  const unrolled = openModules.includes(module)
                  const held = permissions.filter(
                    (permission) => selected.fullAccess || shown.includes(permission.key)
                  ).length

                  return (
                  <section key={module} className="mb-2 overflow-hidden rounded-xl border border-hairline last:mb-0">
                    <h3>
                      <button
                        type="button"
                        aria-expanded={unrolled}
                        onClick={() =>
                          setOpenModules((current) =>
                            current.includes(module)
                              ? current.filter((entry) => entry !== module)
                              : [...current, module]
                          )
                        }
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
                          unrolled ? 'bg-surface' : 'hover:bg-surface'
                        )}
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className={cn(
                            'size-3.5 shrink-0 text-faint transition-transform',
                            unrolled && 'rotate-90'
                          )}
                        >
                          <path d="M7 4l6 6-6 6V4z" />
                        </svg>

                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                          {MODULE_LABELS[module] ?? module}
                        </span>

                        {/* What a shut module is still able to say. */}
                        <span
                          className={cn(
                            'shrink-0 rounded-md px-1.5 py-0.5 text-[11px]',
                            held === 0
                              ? 'text-faint'
                              : held === permissions.length
                                ? 'bg-accent/15 text-accent-strong'
                                : 'bg-canvas-elevated text-muted'
                          )}
                        >
                          {held} of {permissions.length}
                        </span>
                      </button>
                    </h3>

                    {unrolled && (
                    <ul className="border-t border-hairline">
                      {permissions.map((permission) => {
                        const on = selected.fullAccess || shown.includes(permission.key)

                        return (
                          <li key={permission.key} className="border-b border-hairline last:border-0">
                            <label
                              className={cn(
                                'flex items-start gap-2.5 px-3 py-2.5 transition-colors',
                                selected.fullAccess || !canManage
                                  ? 'cursor-default opacity-60'
                                  : 'cursor-pointer hover:bg-surface'
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={selected.fullAccess || !canManage}
                                onChange={() => toggle(permission.key)}
                                className="mt-0.5 size-4 shrink-0 accent-current text-accent-strong"
                              />

                              <span className="min-w-0">
                                <span className="block text-sm text-ink">{permission.label}</span>
                                {permission.description && (
                                  <span className="block text-[11px] leading-relaxed text-faint">
                                    {permission.description}
                                  </span>
                                )}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                    )}
                  </section>
                  )
                })}
              </>
            )}
          </div>
        </div>
      )}

      {/*
        Only here while there is something to save. A permanent bar with a
        greyed-out Save teaches people to ignore the one place the screen tells
        them something is pending.
      */}
      {dirty && selected && (
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-hairline pt-3">
          <p className="mr-auto text-xs text-muted">
            Unsaved changes to <span className="text-ink">{selected.label}</span>.
          </p>

          <Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingKey !== null}
        title="Leave without saving?"
        description={
          selected
            ? `The changes to "${selected.label}" have not been saved. Opening another role throws them away.`
            : 'Unsaved changes will be lost.'
        }
        confirmLabel="Discard changes"
        onConfirm={() => {
          setDraft(null)
          setSelectedKey(pendingKey)
          setPendingKey(null)
        }}
        onClose={() => setPendingKey(null)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this role?"
        description={
          confirmDelete
            ? `"${confirmDelete.label}" goes for good. Anybody still on it has to be moved first.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete role"
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(null)}
      />
    </Card>
  )
}
