import type { TrackingSettings } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

interface TrackingConsentDialogProps {
  open: boolean
  tracking: TrackingSettings
  /** Where finished captures are sent, in the words the user would use. */
  destination: string
  /**
   * Present only where the screen is a decision — the administrator switching
   * tracking on. Omitted for the person being tracked, who is being told rather
   * than asked, and for whom a button that pretends otherwise would be a lie.
   */
  onAccept?: () => void
  onClose: () => void
}

/**
 * The disclosure shown before activity tracking can be switched on.
 *
 * Written to be read, not clicked through: every line answers a question
 * somebody would reasonably ask about being recorded — what is taken, how
 * often, when it stops, where it goes and who reads it. The agree button is the
 * only route to `consentGiven`, so this dialog is the single place where the
 * app can start capturing anything.
 *
 * If a line here stops being true of the build, this dialog is wrong and has to
 * change with it. It is not boilerplate.
 */
export function TrackingConsentDialog({
  open,
  tracking,
  destination,
  onAccept,
  onClose
}: TrackingConsentDialogProps): React.JSX.Element {
  const everyMinutes = tracking.screenshotIntervalMinutes
  const idleMinutes = Math.round(tracking.idleAfterSeconds / 60)
  const deciding = onAccept !== undefined

  return (
    <Modal
      open={open}
      title={deciding ? 'Before activity tracking starts' : 'What activity tracking records'}
      description={
        deciding
          ? 'Everyone this is switched on for will be shown the same screen.'
          : 'Set by your administrator for this machine.'
      }
      onClose={onClose}
      footer={
        deciding ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" onClick={onAccept}>
              Turn tracking on
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4 text-sm leading-relaxed text-muted">
        <Item label="What is recorded">
          Whether this machine is being used. Every minute the app checks how long it has been
          since the keyboard or mouse was touched, and stores that as stretches of{' '}
          <span className="text-ink">active</span> and <span className="text-ink">idle</span>{' '}
          time. It does not record what you type.
        </Item>

        <Item label="Screenshots">
          A picture of your screen every {everyMinutes} minutes, for as long as the machine is
          on — including while it is idle. Screenshots are only taken if an administrator has
          switched them on for your account; if they have not, the app records activity and no
          images at all. Settings always shows which of the two is running.
        </Item>

        <Item label="When it runs">
          From the moment the system starts until it shuts down. Not while the machine is off,
          and not after you switch tracking off here.
        </Item>

        <Item label="Where it goes">
          {destination}. Screenshots are stored privately — they are not public links, and they
          are not shared with anyone outside your organisation.
        </Item>

        <Item label="Who can read it">
          Administrators of your organisation. Other people using this app cannot see your
          activity or your screenshots.
        </Item>

        <Item label="Stopping">
          {deciding
            ? 'Switching it off stops capture before the next screenshot. Nothing is taken afterwards.'
            : 'Your administrator switches this on and off. The tray always shows which it is.'}
        </Item>

        <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs">
          Idle means {idleMinutes} {idleMinutes === 1 ? 'minute' : 'minutes'} without keyboard or
          mouse. Both this and the screenshot interval are shown, and can be changed, in
          Settings.
        </p>
      </div>
    </Modal>
  )
}

function Item({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-1 sm:grid-cols-[8.5rem_1fr] sm:gap-4">
      <span className="text-xs font-medium uppercase tracking-wide text-faint">{label}</span>
      <p className="min-w-0">{children}</p>
    </div>
  )
}
