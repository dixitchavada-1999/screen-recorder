import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** What will actually happen, in a sentence. Say what is lost. */
  description: string
  /** The wording on the button that goes through with it. */
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

/**
 * The last word before something is destroyed.
 *
 * Nothing here can be undone — a board takes its sections and every task on
 * them, a section takes its tasks — so the question is asked in a box that has
 * to be read, rather than in a second click on a button that was already under
 * the cursor.
 *
 * Cancel is the safe answer and comes first; the destructive button says what
 * it destroys rather than "OK", so the wrong one cannot be pressed on muscle
 * memory alone.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onClose
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      className="w-[min(26rem,calc(100vw-3rem))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-muted">{description}</p>
    </Modal>
  )
}
