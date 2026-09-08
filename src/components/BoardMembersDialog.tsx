import { useEffect, useState } from 'react'
import type { TaskPerson } from '@shared/types'
import { PeoplePicker } from '@/components/PeoplePicker'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/context/ToastContext'
import { toSerializedError } from '@/services/ipc'

interface BoardMembersDialogProps {
  open: boolean
  members: TaskPerson[]
  onClose: () => void
  onSave: (nexusIds: string[]) => Promise<TaskPerson[]>
}

/**
 * Who is on a board.
 *
 * Membership is what visibility runs on: somebody taken off here stops seeing
 * the board and everything on it at the next read, and the database agrees —
 * this is not a filter over data they still receive.
 *
 * Which is also why taking the last person off is worth thinking twice about: a
 * board with nobody on it is visible to a super admin alone.
 */
export function BoardMembersDialog({
  open,
  members,
  onClose,
  onSave
}: BoardMembersDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const { push } = useToast()

  useEffect(() => {
    if (!open) return
    setSelected(members.map((person) => person.nexusId))
  }, [open, members])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const saved = await onSave(selected)
      push({
        tone: 'info',
        title: 'Project updated',
        description:
          saved.length === 0
            ? 'Nobody is on this project — only a super admin can see it now.'
            : `${saved.length} ${saved.length === 1 ? 'person' : 'people'} on this project.`
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

  return (
    <Modal
      open={open}
      title="Who is on this project"
      description="Only these people can see it, and everything on it."
      onClose={onClose}
      className="w-[min(34rem,calc(100vw-3rem))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <PeoplePicker
        id="board-members"
        label="Members"
        selected={selected}
        onChange={setSelected}
        placeholder="Search by name"
        emptyLabel="nobody yet"
      />
    </Modal>
  )
}
