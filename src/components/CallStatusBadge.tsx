import type { ScheduledCallStatus } from '@shared/types'
import { cn } from '@/utils/cn'

const TONES: Record<ScheduledCallStatus, { label: string; className: string }> = {
  // Scheduled is the default state of every call, so it says nothing worth a
  // badge — the row's own styling already reads as "still ahead".
  scheduled: { label: '', className: '' },
  completed: { label: 'Done', className: 'border-positive/50 bg-positive/15 text-positive' },
  missed: { label: 'Missed', className: 'border-warning/50 bg-warning/15 text-warning' },
  cancelled: {
    label: 'Cancelled',
    className: 'border-record/50 bg-record/15 text-record-strong'
  }
}

/** Small marker on a call that is no longer simply "scheduled". */
export function CallStatusBadge({
  status,
  className
}: {
  status: ScheduledCallStatus
  className?: string
}): React.JSX.Element | null {
  const tone = TONES[status]
  if (!tone.label) return null

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        tone.className,
        className
      )}
    >
      {tone.label}
    </span>
  )
}
