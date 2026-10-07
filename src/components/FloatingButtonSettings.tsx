import { FLOATING_BUTTON_COLORS } from '@shared/presets'
import { Card, Field } from '@/components/ui/Card'
import { useSettings } from '@/context/SettingsContext'
import { cn } from '@/utils/cn'

const SELECTED = 'ring-2 ring-accent-strong ring-offset-2 ring-offset-canvas-elevated'

/**
 * The floating button's colour.
 *
 * Kept on this machine like the window settings beside it: the button is part
 * of this desktop, not of the account. The main process repaints it as soon as
 * the setting changes.
 */
export function FloatingButtonSettings(): React.JSX.Element {
  const { settings, updateSettings } = useSettings()

  if (!settings) return <Card title="Floating button">{null}</Card>

  const current = settings.floatingButton.color.toLowerCase()
  const custom = !FLOATING_BUTTON_COLORS.some((color) => color === current)
  const choose = (color: string): void => void updateSettings({ floatingButton: { color } })

  return (
    <Card
      title="Floating button"
      description="The round button on the desktop that opens today's calls and tasks"
    >
      <Field
        label="Background colour"
        hint="Changes the button straight away. Pick one of these, or any colour with the last swatch."
      >
        <div className="flex flex-wrap items-center gap-2">
          {FLOATING_BUTTON_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use ${color}`}
              aria-pressed={color === current}
              onClick={() => choose(color)}
              className={cn(
                'h-7 w-7 rounded-full border border-white/10 transition',
                color === current ? SELECTED : 'hover:scale-110'
              )}
              style={{ backgroundColor: color }}
            />
          ))}

          {/* Any other colour. The native picker hides behind this swatch. */}
          <label
            title="Custom colour"
            className={cn(
              'relative flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-hairline text-xs text-muted transition hover:scale-110',
              custom && SELECTED
            )}
            style={custom ? { backgroundColor: current, borderStyle: 'solid' } : undefined}
          >
            {!custom && '+'}
            <input
              type="color"
              value={current}
              onChange={(event) => choose(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </Field>
    </Card>
  )
}
