import { useEffect, useState } from 'react'
import type { SerializedError, TrackingSchedule } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectOption } from '@/components/ui/Controls'
import { useToast } from '@/context/ToastContext'
import { toSerializedError, unwrap } from '@/services/ipc'

/** Offered intervals. Ten minutes is what the feature was specified at. */
const SCREENSHOT_INTERVALS: ReadonlyArray<SelectOption<number>> = [
  { value: 5, label: 'Every 5 minutes' },
  { value: 10, label: 'Every 10 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' }
]

const IDLE_THRESHOLDS: ReadonlyArray<SelectOption<number>> = [
  { value: 60, label: 'After 1 minute' },
  { value: 180, label: 'After 3 minutes' },
  { value: 300, label: 'After 5 minutes' },
  { value: 600, label: 'After 10 minutes' },
  { value: 900, label: 'After 15 minutes' }
]

interface TrackingPolicyDialogProps {
  open: boolean
  /** Without `team.manage` the schedule is shown and cannot be changed. */
  canManage: boolean
  onClose: () => void
}

/**
 * The schedule tracking runs on, as an administrator sets it.
 *
 * One row on the server for everybody tracked. Every machine reads it with the
 * rest of its policy, so a change here reaches each of them within a couple of
 * minutes — no restart and nothing for anyone to change on their side.
 */
export function TrackingPolicyDialog({
  open,
  canManage,
  onClose
}: TrackingPolicyDialogProps): React.JSX.Element {
  const { push } = useToast()
  const [schedule, setSchedule] = useState<TrackingSchedule | null>(null)
  const [error, setError] = useState<SerializedError | null>(null)
  const [saving, setSaving] = useState(false)

  // Read fresh each time it opens: somebody else may have changed it since.
  useEffect(() => {
    if (!open) return
    let cancelled = false

    void (async () => {
      try {
        const loaded = await unwrap(window.api.tracking.schedule())
        if (cancelled) return
        setSchedule(loaded)
        setError(null)
      } catch (caught) {
        if (!cancelled) setError(toSerializedError(caught))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open])

  const save = async (patch: Partial<TrackingSchedule>): Promise<void> => {
    if (!schedule) return
    const previous = schedule
    // Shown at once; put back if the server refuses.
    setSchedule({ ...schedule, ...patch })
    setSaving(true)

    try {
      setSchedule(await unwrap(window.api.tracking.setSchedule(patch)))
      push({
        tone: 'success',
        title: 'Tracking schedule saved',
        description: 'Every tracked machine picks it up within a couple of minutes.'
      })
    } catch (caught) {
      setSchedule(previous)
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

  return (
    <Modal
      open={open}
      title="Tracking settings"
      description="The schedule everyone tracked runs on"
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {/*
          Auto-start is not a choice here any more. Every installed device runs
          the recorder in the tray from boot — that is what makes tracking begin
          at login without anyone starting it — so this states the fact rather
          than offering a switch that could turn the rest of this off.
        */}
        <div className="rounded-xl border border-hairline bg-surface/60 px-4 py-3">
          <p className="text-sm font-medium text-ink">Starts with the system</p>
          <p className="mt-0.5 text-xs leading-relaxed text-faint">
            On every device this is installed on, the recorder opens hidden in the tray at
            login, so tracking runs from boot. Nothing appears on screen.
          </p>
        </div>

        {error ? (
          <div className="rounded-xl border border-record/40 bg-record/10 px-3 py-2.5">
            <p className="text-xs font-medium text-record-strong">{error.message}</p>
            {error.hint && <p className="mt-0.5 text-xs text-muted">{error.hint}</p>}
          </div>
        ) : !schedule ? (
          <p className="text-xs text-faint">Loading…</p>
        ) : (
          <>
            <Field
              label="Screenshot interval"
              htmlFor="policy-interval"
              hint="How often a picture of the screen is taken, for the people screenshots are switched on for. Key and click counts are grouped on the same interval."
            >
              <Select
                id="policy-interval"
                value={schedule.screenshotIntervalMinutes}
                options={withCurrent(SCREENSHOT_INTERVALS, schedule.screenshotIntervalMinutes, 'minutes')}
                disabled={!canManage || saving}
                onValueChange={(screenshotIntervalMinutes) =>
                  void save({ screenshotIntervalMinutes })
                }
              />
            </Field>

            <Field
              label="Count as idle after"
              htmlFor="policy-idle"
              hint="Time without keyboard or mouse before the timeline says idle. Screenshots continue either way; applications are only recorded while active."
            >
              <Select
                id="policy-idle"
                value={schedule.idleAfterSeconds}
                options={withCurrent(IDLE_THRESHOLDS, schedule.idleAfterSeconds, 'seconds')}
                disabled={!canManage || saving}
                onValueChange={(idleAfterSeconds) => void save({ idleAfterSeconds })}
              />
            </Field>

            <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
              {canManage
                ? 'Applies to everybody tracked, on every machine. Changes reach each machine within a couple of minutes.'
                : 'Changing the schedule needs the "Turn tracking and screenshots on or off" permission.'}
            </p>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * The offered options, plus the stored value if it is not one of them — set
 * directly in the database, say. A select that cannot show its own value would
 * silently display the first option instead.
 */
function withCurrent(
  options: ReadonlyArray<SelectOption<number>>,
  current: number,
  unit: 'minutes' | 'seconds'
): ReadonlyArray<SelectOption<number>> {
  if (options.some((option) => option.value === current)) return options
  return [...options, { value: current, label: `${current} ${unit}` }].sort(
    (a, b) => a.value - b.value
  )
}
