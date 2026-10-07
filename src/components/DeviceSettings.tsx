import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SerializedError, ThisDevice, UntrackedDevice } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/context/ToastContext'
import { toSerializedError, unwrap } from '@/services/ipc'
import { formatTimestamp } from '@/utils/format'

/**
 * This computer's id and the list of computers that are never tracked.
 *
 * Both appear only when the server says this account may manage the list —
 * nobody else sees either card, or any hint that a list exists. The server
 * checks again on every change, so hiding them is not the boundary.
 */
export function DeviceSettings(): React.JSX.Element {
  const [device, setDevice] = useState<ThisDevice | null>(null)
  const [canManage, setCanManage] = useState(false)
  const { push } = useToast()

  useEffect(() => {
    void (async () => {
      try {
        setDevice(await unwrap(window.api.devices.this()))
        setCanManage(await unwrap(window.api.devices.canManage()))
      } catch {
        // Nothing to show is the honest answer; neither card is essential.
      }
    })()
  }, [])

  const copy = async (): Promise<void> => {
    if (!device) return
    try {
      await navigator.clipboard.writeText(device.machineId)
      push({ tone: 'success', title: 'Device ID copied' })
    } catch {
      push({ tone: 'error', title: 'Could not copy — select the ID and copy it by hand.' })
    }
  }

  // Nothing at all for anybody else — not even an empty space.
  if (!canManage) return <></>

  return (
    <>
      <Card title="This device" description="The name and ID to use on the untracked list">
        {device ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[16rem] flex-1 rounded-xl border border-hairline bg-surface px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                {device.hostname}
              </p>
              <p className="selectable mt-0.5 truncate font-mono text-xs text-ink">{device.machineId}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              Copy ID
            </Button>
          </div>
        ) : (
          <p className="text-xs text-faint">Loading…</p>
        )}
      </Card>

      <UntrackedDevices thisMachineId={device?.machineId ?? null} />

      <UninstallPassword />
    </>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * The password the uninstaller asks for, on every machine.
 *
 * Typed here and hashed by the app before it is sent; the password itself is
 * never stored, shown or sent anywhere. Machines pick the change up within a
 * few minutes and keep it for when they are offline.
 */
function UninstallPassword(): React.JSX.Element {
  const { push } = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        setUpdatedAt((await unwrap(window.api.devices.uninstallPasswordInfo())).updatedAt)
      } catch {
        // Only the "last changed" line depends on it.
      }
    })()
  }, [])

  const tooShort = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && password !== confirm
  const ready = password.length >= 8 && password === confirm

  const save = async (): Promise<void> => {
    if (!ready) return
    setSaving(true)
    try {
      const info = await unwrap(window.api.devices.setUninstallPassword(password))
      setUpdatedAt(info.updatedAt)
      setPassword('')
      setConfirm('')
      push({
        tone: 'success',
        title: 'Uninstall password changed',
        description: 'Every machine picks it up within a few minutes.'
      })
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({ tone: 'error', title: failure.message, ...(failure.hint ? { description: failure.hint } : {}) })
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'h-9 rounded-xl border border-hairline bg-surface px-3 text-xs text-ink transition-colors hover:border-faint focus:border-accent'

  return (
    <Card
      collapsible
      title="Uninstall password"
      description="Asked for before the app can be uninstalled from any computer"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
            <span className="text-[11px] text-faint">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1">
            <span className="text-[11px] text-faint">Type it again</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className={inputClass}
            />
          </label>
          <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!ready}>
            Change password
          </Button>
        </div>

        {(tooShort || mismatch) && (
          <p className="text-[11px] text-record-strong">
            {tooShort ? 'Use at least 8 characters.' : 'The two do not match.'}
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-faint">
          {updatedAt
            ? `Last changed ${formatTimestamp(Date.parse(updatedAt))}. `
            : 'Not changed here yet — machines use the password their installer was built with. '}
          The password is never shown or stored; only a scrambled form of it reaches the machines.
        </p>
      </form>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * One computer on the list.
 *
 * A computer can be several installations — the app reinstalled leaves a new
 * id behind under the same name — and adding it by name adds all of them. They
 * are shown, and removed, together: one row, one Remove.
 */
interface Computer {
  key: string
  name: string
  hostname: string | null
  machineIds: string[]
  people: string | null
  lastSeenAt: string | null
}

function groupByComputer(list: UntrackedDevice[]): Computer[] {
  const byKey = new Map<string, Computer>()

  for (const item of list) {
    const key = item.hostname ? `host:${item.hostname.toLowerCase()}` : `id:${item.machineId}`
    const existing = byKey.get(key)

    if (!existing) {
      byKey.set(key, {
        key,
        name: item.label || item.hostname || 'Unknown computer',
        hostname: item.hostname,
        machineIds: [item.machineId],
        people: item.people,
        lastSeenAt: item.lastSeenAt
      })
      continue
    }

    existing.machineIds.push(item.machineId)
    const people = new Set(
      [existing.people, item.people].flatMap((value) => (value ? value.split(', ') : []))
    )
    existing.people = people.size > 0 ? [...people].join(', ') : null
    if (item.lastSeenAt && (!existing.lastSeenAt || item.lastSeenAt > existing.lastSeenAt)) {
      existing.lastSeenAt = item.lastSeenAt
    }
  }

  return [...byKey.values()]
}

function UntrackedDevices({ thisMachineId }: { thisMachineId: string | null }): React.JSX.Element {
  const { push } = useToast()
  const [list, setList] = useState<UntrackedDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)
  const [machineId, setMachineId] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<Computer | null>(null)

  const computers = useMemo(() => groupByComputer(list), [list])

  const refresh = useCallback(async () => {
    try {
      setList(await unwrap(window.api.devices.listUntracked()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const report = (caught: unknown): void => {
    const failure = toSerializedError(caught)
    push({ tone: 'error', title: failure.message, ...(failure.hint ? { description: failure.hint } : {}) })
  }

  const add = async (): Promise<void> => {
    setSaving(true)
    try {
      await unwrap(window.api.devices.addUntracked(machineId, label || null))
      push({
        tone: 'success',
        title: 'Device will no longer be tracked',
        description: 'It stops within a couple of minutes, whoever is signed in on it.'
      })
      setMachineId('')
      setLabel('')
      await refresh()
    } catch (caught) {
      report(caught)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (computer: Computer): Promise<void> => {
    // Off the screen at once, so it cannot be clicked twice; the reload below
    // puts back anything the server did not actually remove.
    setList((current) => current.filter((item) => !computer.machineIds.includes(item.machineId)))

    try {
      await unwrap(window.api.devices.removeUntracked(computer.machineIds))
      push({
        tone: 'info',
        title: `${computer.name} is tracked again`,
        description: 'Removed from the list. Its user’s switches apply again within a couple of minutes.'
      })
    } catch (caught) {
      report(caught)
    } finally {
      await refresh()
    }
  }

  const inputClass =
    'selectable h-9 rounded-xl border border-hairline bg-surface px-3 text-xs text-ink transition-colors hover:border-faint focus:border-accent'

  return (
    <Card
      collapsible
      title="Untracked devices"
      description="Computers that record nothing — no activity, no screenshots — whoever signs in on them"
    >
      <div className="flex flex-col gap-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <label className="flex min-w-[18rem] flex-[2] flex-col gap-1">
            <span className="text-[11px] text-faint">Computer name or device ID</span>
            <input
              value={machineId}
              onChange={(event) => setMachineId(event.target.value)}
              placeholder="LAPTOP-NG8LJRD8, or the ID from Settings → This device"
              className={`${inputClass} font-mono`}
              spellCheck={false}
            />
          </label>
          <label className="flex min-w-[10rem] flex-1 flex-col gap-1">
            <span className="text-[11px] text-faint">Name (optional)</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Home PC"
              maxLength={100}
              className={inputClass}
            />
          </label>
          <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!machineId.trim()}>
            Add device
          </Button>
        </form>

        {thisMachineId && !list.some((item) => item.machineId === thisMachineId) && (
          <button
            type="button"
            onClick={() => setMachineId(thisMachineId)}
            className="self-start text-[11px] text-accent-strong hover:underline"
          >
            Use this computer’s ID
          </button>
        )}

        {error ? (
          <div className="rounded-xl border border-record/40 bg-record/10 px-3 py-2.5">
            <p className="text-xs font-medium text-record-strong">{error.message}</p>
            {error.hint && <p className="mt-0.5 text-xs text-muted">{error.hint}</p>}
          </div>
        ) : loading ? (
          <p className="text-xs text-faint">Loading…</p>
        ) : computers.length === 0 ? (
          <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs text-muted">
            No devices yet. Every computer is tracked according to its user’s switches.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline/60 rounded-xl border border-hairline bg-surface">
            {computers.map((computer) => (
              <li key={computer.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    {computer.name}
                    {thisMachineId && computer.machineIds.includes(thisMachineId) && (
                      <span className="ml-2 rounded-full border border-accent/50 bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-strong">
                        this computer
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-faint">
                    {[
                      computer.hostname && computer.hostname !== computer.name ? computer.hostname : null,
                      computer.people,
                      computer.lastSeenAt
                        ? `last seen ${formatTimestamp(Date.parse(computer.lastSeenAt))}`
                        : 'not seen yet',
                      computer.machineIds.length > 1 ? `${computer.machineIds.length} installations` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {computer.machineIds.map((id) => (
                    <p key={id} className="truncate font-mono text-[11px] text-faint">
                      {id}
                    </p>
                  ))}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(computer)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={removing !== null}
        title="Remove this computer from the list?"
        description={`${removing?.name ?? 'This computer'} is deleted from the list${
          removing && removing.machineIds.length > 1 ? `, all ${removing.machineIds.length} installations` : ''
        }, and records again according to its user's Activity and Screenshots switches.`}
        confirmLabel="Remove"
        onConfirm={() => {
          if (removing) void remove(removing)
          setRemoving(null)
        }}
        onClose={() => setRemoving(null)}
      />
    </Card>
  )
}
