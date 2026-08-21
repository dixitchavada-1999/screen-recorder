import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'

/** Held back long enough that sweeping across a week does not flash a card per call. */
const DELAY_MS = 250

/** Distance between the thing being hovered and its card. */
const GAP = 10

/** Kept off every edge of the window by this much. */
const MARGIN = 8

/**
 * What the card opens next to: the pointer, or the target's own box.
 *
 * `DOMRect` satisfies this, so an element can be handed over as it is; a
 * pointer becomes a rectangle with no width or height at all.
 */
interface Anchor {
  left: number
  right: number
  top: number
  bottom: number
}

interface HoverCardProps {
  /** What the card says. Rendered only while it is open. */
  card: React.ReactNode
  /** Classes for the wrapper, which stands exactly where the target is drawn. */
  className?: string
  /** The wrapper's position, for a target the grid places absolutely. */
  style?: React.CSSProperties
  /**
   * A card that carries a table rather than a few lines, and needs the room.
   *
   * Still only as wide as its content: this raises the ceiling, it does not set
   * the width.
   */
  wide?: boolean
  /** Nothing to say — the wrapper renders, the card never opens. */
  disabled?: boolean
  children: React.ReactNode
}

/**
 * A card that opens beside whatever it wraps, on hover or on focus.
 *
 * Rendered into `document.body` rather than beside its target, because the
 * calendars scroll and anything drawn inside them would be cut off at the
 * container's edge — worst exactly where the card is most needed, at the first
 * and last hours of the day. A portal with fixed coordinates escapes that; the
 * price is measuring the position by hand instead of leaving it to the layout.
 *
 * The card never takes the pointer. If it did, moving onto it would count as
 * leaving the target, and the card would close under the cursor.
 */
export function HoverCard({
  card,
  className,
  style,
  disabled = false,
  wide = false,
  children
}: HoverCardProps): React.JSX.Element {
  /** What the card is opening next to, and null whenever it is closed. */
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /*
   * The pointer's last position inside this target, and null when it got here
   * by keyboard.
   *
   * Read when the card finally opens rather than when the pointer arrived: a
   * day-view row is the width of the window, and a card pinned to where the
   * pointer entered it would open a screen away from where the pointer now is.
   */
  const pointer = useRef<Anchor | null>(null)

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pointer.current = null
    setAnchor(null)
    setPlaced(null)
  }, [])

  const show = useCallback(
    (element: HTMLElement) => {
      if (disabled) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(
        // The pointer if there is one, the target itself if there is not.
        () => setAnchor(pointer.current ?? element.getBoundingClientRect()),
        DELAY_MS
      )
    },
    [disabled]
  )

  // A pending card must not appear after its target has gone — moving to
  // another week would otherwise leave one hanging over the new one.
  useEffect(() => hide, [hide])

  // Nothing left to say, nothing left to show.
  useEffect(() => {
    if (disabled) hide()
  }, [disabled, hide])

  /*
   * Beside the target, then nudged back inside the window.
   *
   * Measured once the card is in the document rather than guessed from a fixed
   * size: the content decides its height, and a card near the bottom of the
   * screen has to know that height before it can sit clear of the edge. The
   * same pass handles a narrow window, where "beside" becomes "wherever it
   * fits".
   */
  useLayoutEffect(() => {
    if (!anchor || !bubble.current) return

    const box = bubble.current.getBoundingClientRect()

    // To the right by preference, to the left when that side has no room for
    // it. The pointer is a point, so "beside" means beside the cursor.
    let left = anchor.right + GAP
    if (left + box.width > window.innerWidth - MARGIN) left = anchor.left - GAP - box.width
    if (left < MARGIN) left = MARGIN

    // Below by preference, above when the bottom of the window is too close.
    let top = anchor.bottom + GAP
    if (top + box.height > window.innerHeight - MARGIN) top = anchor.top - GAP - box.height
    if (top + box.height > window.innerHeight - MARGIN) {
      top = window.innerHeight - box.height - MARGIN
    }
    if (top < MARGIN) top = MARGIN

    setPlaced({ left, top })
  }, [anchor])

  /*
   * Scrolling or resizing moves the target out from under its card.
   *
   * Closing beats recalculating: the pointer has left the target by then
   * anyway, and a card that follows the grid as it scrolls reads as something
   * stuck to the screen rather than a label for whatever is under the cursor.
   */
  useEffect(() => {
    if (!anchor) return

    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)

    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [anchor, hide])

  return (
    <div
      className={className}
      style={style}
      onMouseEnter={(event) => {
        pointer.current = pointAt(event.clientX, event.clientY)
        show(event.currentTarget)
      }}
      // Cheap: a ref, no re-render. It only has to be right at the moment the
      // card opens.
      onMouseMove={(event) => {
        if (!anchor) pointer.current = pointAt(event.clientX, event.clientY)
      }}
      onMouseLeave={hide}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={hide}
    >
      {children}

      {anchor !== null &&
        createPortal(
          <div
            ref={bubble}
            role="tooltip"
            className={cn(
              'pointer-events-none fixed z-50 rounded-xl border border-hairline',
              'bg-canvas-elevated px-3 py-2.5 shadow-lg shadow-black/40',
              // As wide as it needs to be and no wider: a card with a short
              // title and one name should not carry a column of empty space
              // beside it. The cap keeps a long title from running across the
              // window, and in a small window it is the window that decides.
              'w-max',
              wide
                ? 'max-w-[min(34rem,calc(100vw-1rem))]'
                : 'max-w-[min(18rem,calc(100vw-1rem))]',
              // Cut rather than allowed to grow past the bottom of the screen.
              'max-h-[calc(100vh-1rem)] overflow-hidden',
              // Invisible for the one frame between being measured and being
              // placed, so nothing is seen jumping into position.
              'transition-opacity duration-100',
              placed ? 'opacity-100' : 'opacity-0'
            )}
            style={{
              left: placed?.left ?? anchor.right + GAP,
              top: placed?.top ?? anchor.top
            }}
          >
            {card}
          </div>,
          document.body
        )}
    </div>
  )
}

/** The cursor as an anchor: a rectangle of no size, where the pointer is. */
function pointAt(x: number, y: number): Anchor {
  return { left: x, right: x, top: y, bottom: y }
}
