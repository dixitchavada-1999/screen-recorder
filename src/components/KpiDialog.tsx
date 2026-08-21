import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/context/ToastContext'
import { useRoster } from '@/hooks/useRoster'
import { toSerializedError } from '@/services/ipc'
import { cn } from '@/utils/cn'

const MAX_LENGTH = 2000

interface KpiDialogProps {
  open: boolean
  onClose: () => void
  onSave: (body: string, nexusIds: string[]) => Promise<void>
}

/**
 * Writing one OKR note and choosing who it lands on.
 *
 * The audience comes first and the text second, which is the order the decision
 * is actually made in: an administrator opens this because of something they
 * want a particular group of people to know.
 *
 * Nothing is saved until both halves exist — a note addressed to nobody would
 * be written into the table and appear on no dashboard at all, which looks from
 * the outside exactly like the feature being broken.
 *
 * The audience is the Nexus staff roster, not the people who happen to have
 * signed into this app. That is the point: a target is set for a member of
 * staff, and it is waiting for them the first time they open the recorder.
 * Leavers are left out — `useRoster` keeps them for naming old records, but
 * nothing new should be addressed to somebody who has gone.
 *
 * The list is read here rather than passed in because this component is only
 * ever mounted for a super admin. Reading it a level up would mean everybody
 * else's dashboard also asked for it.
 */
export function KpiDialog({ open, onClose, onSave }: KpiDialogProps): React.JSX.Element {
  const [body, setBody] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const { push } = useToast()
  const { people, loading: peopleLoading } = useRoster()

  // A fresh dialog every time it is opened. Reopening it to find the last
  // note's text and audience still in place would be a way to send something
  // twice without meaning to.
  useEffect(() => {
    if (!open) return
    setBody('')
    setSelected([])
    setFilter('')
    setListOpen(false)
  }, [open])

  /*
   * The list stays shut until it is asked for.
   *
   * Fifty-four names unrolled by default pushed the note itself off the bottom
   * of the dialog, which put the two halves of one decision on two screens.
   * Closed, the whole thing fits at once: the search, who has been picked so
   * far, and the box being written in.
   */
  const peopleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!listOpen) return

    const handle = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && !peopleRef.current?.contains(target)) setListOpen(false)
    }

    document.addEventListener('pointerdown', handle)
    return () => document.removeEventListener('pointerdown', handle)
  }, [listOpen])

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return people

    return people.filter((person) => person.name.toLowerCase().includes(needle))
  }, [people, filter])

  const nameOf = useMemo(
    () => new Map(people.map((person) => [person.nexusId, person.name])),
    [people]
  )

  const toggle = (id: string): void => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    )
    // Clear the search once a name is picked, so the box is ready for the next
    // one rather than still holding the last query.
    setFilter('')
  }

  /* Acts on what is in front of the person: a search narrows what this means. */
  const allShownSelected =
    matches.length > 0 && matches.every((person) => selected.includes(person.nexusId))

  const toggleShown = (): void => {
    const shown = matches.map((person) => person.nexusId)

    setSelected((current) =>
      allShownSelected
        ? current.filter((id) => !shown.includes(id))
        : [...new Set([...current, ...shown])]
    )
  }

  const ready = body.trim().length > 0 && selected.length > 0

  const save = async (): Promise<void> => {
    if (!ready) return

    setSaving(true)
    try {
      await onSave(body.trim(), selected)
      push({
        tone: 'info',
        title: 'OKR added',
        description: `Now on ${selected.length} ${selected.length === 1 ? 'dashboard' : 'dashboards'}.`
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
      title="Add OKR"
      description="Pick who it is for, then write it. It appears on their dashboard."
      onClose={onClose}
      className="w-[min(38rem,calc(100vw-3rem))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!ready} onClick={() => void save()}>
            Add OKR
          </Button>
        </>
      }
    >
      {/* ------------------------------- People ------------------------------ */}

      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor="kpi-people" className="text-xs font-medium text-muted">
          Who is this for?
        </label>

        <span className="text-[11px] text-faint">
          {selected.length > 0 ? `${selected.length} selected` : 'nobody yet'}
        </span>
      </div>

      <div ref={peopleRef} className="relative">
        <input
          id="kpi-people"
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value)
            setListOpen(true)
          }}
          onFocus={() => setListOpen(true)}
          onKeyDown={(event) => {
            // While the list is down, Escape belongs to it. Left alone, the
            // dialog's own handler would read one press as "throw all of this
            // away" and close everything.
            if (event.key === 'Escape' && listOpen) {
              event.preventDefault()
              event.stopPropagation()
              setListOpen(false)
            }
          }}
          placeholder={listOpen ? 'Search by name' : 'Click to choose people'}
          className="selectable w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink transition-colors hover:border-faint focus:border-accent"
        />

        {listOpen && (
          <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-hairline bg-canvas-elevated shadow-2xl shadow-black/50">
            {peopleLoading && <p className="px-3 py-3 text-xs text-faint">Loading people…</p>}

            {!peopleLoading && matches.length === 0 && (
              <p className="px-3 py-3 text-xs text-faint">
                {people.length === 0 ? 'Nobody to choose from yet.' : 'Nobody matches that.'}
              </p>
            )}

            {!peopleLoading && matches.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={toggleShown}
                  className="w-full border-b border-hairline px-3 py-2 text-left text-[11px] font-medium text-accent-strong transition-colors hover:bg-surface"
                >
                  {allShownSelected ? 'Clear these' : `Select all ${matches.length}`}
                </button>

                <ul>
                  {matches.map((person) => {
                    const checked = selected.includes(person.nexusId)

                    return (
                      <li key={person.nexusId}>
                        <label
                          className={cn(
                            'flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors',
                            checked ? 'bg-accent/10' : 'hover:bg-surface'
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(person.nexusId)}
                            className="size-4 shrink-0 accent-current text-accent-strong"
                          />

                          <span className="min-w-0 flex-1 truncate text-sm text-ink">
                            {person.name}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {/*
        Who has been picked, on screen whether the list is open or shut. With it
        shut, a bare count would be the only trace of a choice that is about to
        land on those people's dashboards.
      */}
      {selected.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {selected.map((nexusId) => (
            <li key={nexusId}>
              <button
                type="button"
                onClick={() => toggle(nexusId)}
                title="Remove from this note"
                className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2.5 pr-1.5 text-[11px] text-accent-strong transition-colors hover:border-accent"
              >
                {nameOf.get(nexusId) ?? nexusId}
                <span aria-hidden="true" className="text-sm leading-none">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* -------------------------------- Note ------------------------------- */}

      <label htmlFor="kpi-body" className="mb-1.5 mt-4 block text-xs font-medium text-muted">
        OKR / note
      </label>

      <textarea
        id="kpi-body"
        rows={5}
        maxLength={MAX_LENGTH}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="e.g. Target for August — 20 client calls a day, logged in the Call Manager by 6pm."
        className="selectable w-full resize-y rounded-xl border border-hairline bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition-colors hover:border-faint focus:border-accent"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            void save()
          }
        }}
      />

      <p className="mt-1 text-right text-[11px] text-faint">
        {body.length} / {MAX_LENGTH}
      </p>
    </Modal>
  )
}
