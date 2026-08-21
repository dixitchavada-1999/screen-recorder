import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface TooltipProps {
  /** The text to show. Also what the wrapped control should announce. */
  label: string
  /** Which side of the control the bubble sits on. */
  side?: 'top' | 'bottom'
  children: ReactNode
  className?: string
}

/**
 * A hover label for a control, replacing the browser's own `title`.
 *
 * Two reasons not to use `title` here. A disabled button receives no pointer
 * events, so its native tooltip never appears — and a disabled button is
 * exactly the one whose label matters most, because it has to explain why it
 * cannot be pressed. The hover therefore belongs to this wrapper, which is not
 * disabled. The second reason is timing: the native tooltip takes about a
 * second to appear and looks nothing like the rest of the app.
 *
 * CSS-only, through Tailwind's named group, so hovering costs no re-render.
 * `focus-within` covers the keyboard, where there is no hover to have.
 */
export function Tooltip({
  label,
  side = 'bottom',
  children,
  className
}: TooltipProps): React.JSX.Element {
  return (
    <span className={cn('group/tooltip relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          // Never in the way of the pointer: the bubble sits under the cursor's
          // path to the button, and catching a click there would swallow it.
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2',
          'w-max max-w-56 rounded-lg border border-hairline bg-canvas-elevated',
          'px-2.5 py-1.5 text-center text-xs leading-snug text-ink shadow-lg shadow-black/40',
          // Held back briefly so that sweeping the pointer across a row of
          // buttons does not flash a label for each one in turn.
          'opacity-0 transition-opacity delay-300 duration-100',
          'group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100',
          side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
        )}
      >
        {label}
      </span>
    </span>
  )
}
