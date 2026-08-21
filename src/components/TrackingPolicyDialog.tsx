import type { AppSettings } from '@shared/types'
import type { DeepPartial } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Card'
import { Modal } from '@/components/ui/Modal'
import { Select, type SelectOption } from '@/components/ui/Controls'

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
  settings: AppSettings
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  onClose: () => void
}

/**
 * The schedule tracking runs on, as an administrator sets it.
 *
 * Moved out of the tracked person's own Settings deliberately: how often a
 * screenshot is taken is the organisation's decision, while consenting and
 * stopping stay with whoever is at the machine. Both numbers are still shown to
 * them — a schedule they cannot see is a schedule they cannot judge.
 */
export function TrackingPolicyDialog({
  open,
  settings,
  onUpdate,
  onClose
}: TrackingPolicyDialogProps): React.JSX.Element {
  const { tracking } = settings

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

        <Field
          label="Screenshot interval"
          htmlFor="policy-interval"
          hint="How often a picture of the screen is taken, for the people screenshots are switched on for."
        >
          <Select
            id="policy-interval"
            value={tracking.screenshotIntervalMinutes}
            options={SCREENSHOT_INTERVALS}
            onValueChange={(screenshotIntervalMinutes) =>
              onUpdate({ tracking: { screenshotIntervalMinutes } })
            }
          />
        </Field>

        <Field
          label="Count as idle after"
          htmlFor="policy-idle"
          hint="Time without keyboard or mouse before the timeline says idle. Screenshots continue either way."
        >
          <Select
            id="policy-idle"
            value={tracking.idleAfterSeconds}
            options={IDLE_THRESHOLDS}
            onValueChange={(idleAfterSeconds) => onUpdate({ tracking: { idleAfterSeconds } })}
          />
        </Field>

        <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          This changes <span className="font-medium">this machine only</span>. Applying a
          schedule across everybody needs the server-side policy, which is not built yet — until
          then each machine carries its own.
        </p>
      </div>
    </Modal>
  )
}
