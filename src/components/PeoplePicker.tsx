import { useEffect, useMemo, useRef, useState } from 'react'
import { useRoster } from '@/hooks/useRoster'
import { cn } from '@/utils/cn'

interface PeoplePickerProps {
  id: string
  label: string
  /** Nexus ids. */
  selected: string[]
  onChange: (nexusIds: string[]) => void
  placeholder?: string
  emptyLabel?: string
  /**
   * Keep the roster shut until it is asked for.
   *
   * For a form that is mostly about something else — a task, where the people
   * are one field among six — fifty names unrolled by default push everything
   * that matters below the fold. Off, for a dialog whose whole purpose is
   * picking people and where a closed list would be a click in the way.
   */
  collapsible?: boolean
}

/**
 * Choosing people from the Nexus staff roster.
 *
 * The roster, not this app's accounts — the same identity every other feature
 * here is keyed by. Somebody can be given work, or put on a board, before they
 * have ever opened the recorder, and it is waiting for them when they do.
 * Leavers are left out: `useRoster` keeps them so old records still show a name,
 * but nothing new should be addressed to somebody who has gone.
 *
 * The list is always open, and sits in the flow rather than floating over it.
 * A dropdown here was worse than useless: it is absolutely positioned, the
 * dialogs this appears in scroll their own content, and the list was therefore
 * clipped to whatever room was left below the search box — two names out of
 * fifty-four. Both places this is used are dialogs whose whole purpose is
 * picking people, so there is nothing for a closed list to make room for.
 */
export function PeoplePicker({
  id,
  label,
  selected,
  onChange,
  placeholder = 'Search by name',
  emptyLabel = 'nobody yet',
  collapsible = false
}: PeoplePickerProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(!collapsible)
  const { people, loading } = useRoster()

  /*
   * Back to the top whenever the search changes.
   *
   * Without this the list keeps whatever offset the last scroll left it at, so
   * typing a name can leave you looking at the middle of the matches with the
   * one you searched for above the fold — which reads as the search having
   * found nothing.
   */
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [filter])

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return people
    return people.filter((person) => person.name.toLowerCase().includes(needle))
  }, [people, filter])

  const nameOf = useMemo(
    () => new Map(people.map((person) => [person.nexusId, person.name])),
    [people]
  )

  const toggle = (nexusId: string): void => {
    onChange(
      selected.includes(nexusId)
        ? selected.filter((entry) => entry !== nexusId)
        : [...selected, nexusId]
    )
  }

  /* Acts on what is in front of the person: a search narrows what this means. */
  const allShownSelected =
    matches.length > 0 && matches.every((person) => selected.includes(person.nexusId))

  const toggleShown = (): void => {
    const shown = matches.map((person) => person.nexusId)
    onChange(
      allShownSelected
        ? selected.filter((nexusId) => !shown.includes(nexusId))
        : [...new Set([...selected, ...shown])]
    )
  }

  return (
    <>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-muted">
          {label}
        </label>

        <span className="text-[11px] text-faint">
          {selected.length > 0 ? `${selected.length} selected` : emptyLabel}
        </span>
      </div>

      {open && (
        <input
          id={id}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={placeholder}
          className="selectable w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink transition-colors hover:border-faint focus:border-accent"
        />
      )}

      {/*
        Who has been picked, above the list rather than below it. With fifty
        names to scroll past, a choice made at the bottom is otherwise the one
        thing you cannot see while making the next one — and with the list shut
        these chips are the only trace of the choice at all.
      */}
      {selected.length > 0 && (
        <ul className={cn('flex flex-wrap gap-1', open && 'mt-2')}>
          {selected.map((nexusId) => (
            <li key={nexusId}>
              <button
                type="button"
                onClick={() => toggle(nexusId)}
                title="Remove"
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

      {collapsible && (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'w-full rounded-xl border border-dashed border-hairline px-3 py-2 text-xs transition-colors',
            'text-muted hover:border-faint hover:text-ink',
            selected.length > 0 && 'mt-2'
          )}
        >
          {open ? 'Done' : selected.length > 0 ? 'Add or remove people' : '+ Assign people'}
        </button>
      )}

      {open && (
      <div
        ref={listRef}
        className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-hairline bg-surface/40"
      >
        {loading && <p className="px-3 py-3 text-xs text-faint">Loading people…</p>}

        {!loading && matches.length === 0 && (
          <p className="px-3 py-3 text-xs text-faint">
            {people.length === 0 ? 'Nobody to choose from yet.' : 'Nobody matches that.'}
          </p>
        )}

        {!loading && matches.length > 0 && (
          <>
            {/* Sticky: with fifty names below it, this is otherwise scrolled
                away exactly when a search has made it worth pressing. */}
            <button
              type="button"
              onClick={toggleShown}
              className="sticky top-0 z-10 w-full border-b border-hairline bg-canvas-elevated px-3 py-2 text-left text-[11px] font-medium text-accent-strong transition-colors hover:bg-surface"
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
                        checked ? 'bg-accent/10' : 'hover:bg-canvas-elevated'
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
    </>
  )
}
