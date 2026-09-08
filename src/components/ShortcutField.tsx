import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/utils/cn'

/**
 * The key that starts and stops a recording from anywhere on the machine.
 *
 * Captured by pressing it rather than typed, because the thing being asked for
 * is a key combination and the only unambiguous way to name one is to press it.
 * Typing `Ctrl+Space` into a box means writing the accelerator syntax correctly
 * and finding out it was wrong only when it silently fails to bind.
 *
 * Worth knowing, and said on screen: a global key is taken from every other
 * application while this one runs. Ctrl+Space is what Windows uses to switch
 * input methods and what most editors use for autocomplete.
 */
export function ShortcutField({
  value,
  onChange
}: {
  value: string
  onChange: (accelerator: string) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)

  return (
    <>
      <p className="text-sm font-medium text-ink">Start and stop recording</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">
        Works anywhere on this machine, with the app in the tray — and takes the key from every
        other application while it runs.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          onKeyDown={(event) => {
            if (!capturing) return
            event.preventDefault()

            if (event.key === 'Escape') {
              setCapturing(false)
              return
            }

            const accelerator = toAccelerator(event)
            if (!accelerator) return

            onChange(accelerator)
            setCapturing(false)
          }}
          className={cn(
            'min-w-40 rounded-xl border px-3 py-2 font-mono text-sm transition-colors',
            capturing
              ? 'border-accent bg-surface text-accent-strong'
              : 'border-hairline bg-surface text-ink hover:border-faint'
          )}
        >
          {capturing ? 'Press the keys…' : readableAccelerator(value) || 'None'}
        </button>

        {value && !capturing && (
          <Button size="sm" variant="ghost" onClick={() => onChange('')}>
            Turn off
          </Button>
        )}
      </div>
    </>
  )
}

/**
 * A key press as Electron's accelerator syntax, or null while it is only a
 * modifier.
 *
 * Modifiers arrive as key presses of their own, and binding "Control" alone
 * would swallow every shortcut on the machine — so a press without a real key
 * beside it is ignored rather than accepted.
 */
function toAccelerator(event: React.KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')

  const key = event.key

  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(key)) return null

  // Electron names the space bar rather than taking the character itself.
  const named = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key

  // A bare letter would bind that letter across the whole machine.
  if (parts.length === 0) return null

  return [...parts, named].join('+')
}

/** The same thing, as somebody would read it out. */
function readableAccelerator(accelerator: string): string {
  return accelerator.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ')
}
