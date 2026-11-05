import { useEffect, useMemo, useState } from 'react'
import type { RecurrenceEnd, RecurrenceRule, RecurrencePreset } from '@shared/recurrence'
import { presetRule, describeRule } from '@shared/recurrence'
import { Select } from '@/components/ui/Controls'
import { DatePicker } from '@/components/ui/DatePicker'

/**
 * Chooses how a call repeats.
 *
 * The presets read off the anchor date — "Weekly on Wednesday", "Monthly on the
 * first Wednesday" — exactly like a calendar's own menu. "Custom" opens the full
 * rule: frequency, interval, which weekdays, and when it ends. The value handed
 * up is the rule the app stores, or null for a one-off.
 */

const WEEKDAYS_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDINAL = ['first', 'second', 'third', 'fourth', 'last']

export function RecurrencePicker({
  anchor,
  value,
  onChange,
  disabled = false
}: {
  anchor: Date
  value: RecurrenceRule | null
  onChange: (rule: RecurrenceRule | null) => void
  disabled?: boolean
}): React.JSX.Element {
  const [preset, setPreset] = useState<RecurrencePreset>('none')
  // The custom rule is kept even while a preset is selected, so switching to
  // Custom and back does not lose what was typed.
  const [custom, setCustom] = useState<RecurrenceRule>(() => defaultCustom(anchor))

  // A new call opens on "Does not repeat"; re-seed when the anchor day changes
  // so the preset labels (which name the weekday) stay truthful.
  useEffect(() => {
    if (!value) setPreset('none')
  }, [value])

  const options = useMemo(() => presetOptions(anchor), [anchor])

  const choose = (next: RecurrencePreset): void => {
    setPreset(next)
    if (next === 'custom') {
      onChange(custom)
    } else {
      onChange(presetRule(next, anchor))
    }
  }

  const changeCustom = (rule: RecurrenceRule): void => {
    setCustom(rule)
    onChange(rule)
  }

  return (
    <div className="grid gap-2">
      <Select
        value={preset}
        onValueChange={(v) => choose(v as RecurrencePreset)}
        options={options}
        disabled={disabled}
      />

      {preset === 'custom' && (
        <CustomEditor anchor={anchor} rule={custom} onChange={changeCustom} disabled={disabled} />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function presetOptions(anchor: Date): Array<{ value: RecurrencePreset; label: string }> {
  const wd = WEEKDAYS_LONG[anchor.getDay()]
  const nth = ORDINAL[Math.min(Math.ceil(anchor.getDate() / 7), 5) - 1]
  return [
    { value: 'none', label: 'Does not repeat' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: `Weekly on ${wd}` },
    { value: 'monthly', label: `Monthly on the ${nth} ${wd}` },
    { value: 'yearly', label: 'Annually' },
    { value: 'weekdays', label: 'Every weekday (Monday to Friday)' },
    { value: 'custom', label: 'Custom…' }
  ]
}

function defaultCustom(anchor: Date): RecurrenceRule {
  return {
    freq: 'weekly',
    interval: 1,
    byWeekday: [anchor.getDay()],
    monthlyMode: 'weekday',
    end: { type: 'never' }
  }
}

/* -------------------------------------------------------------------------- */
/*                                Custom editor                               */
/* -------------------------------------------------------------------------- */

function CustomEditor({
  anchor,
  rule,
  onChange,
  disabled
}: {
  anchor: Date
  rule: RecurrenceRule
  onChange: (rule: RecurrenceRule) => void
  disabled: boolean
}): React.JSX.Element {
  const set = (patch: Partial<RecurrenceRule>): void => onChange({ ...rule, ...patch })

  const toggleDay = (day: number): void => {
    const days = new Set(rule.byWeekday ?? [anchor.getDay()])
    if (days.has(day)) days.delete(day)
    else days.add(day)
    // Never let the set empty out — fall back to the anchor's own day.
    set({ byWeekday: days.size ? [...days].sort((a, b) => a - b) : [anchor.getDay()] })
  }

  return (
    <div className="grid gap-3 rounded-xl border border-hairline bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Every</span>
        <input
          type="number"
          min={1}
          max={999}
          value={rule.interval}
          disabled={disabled}
          onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })}
          className="h-8 w-16 rounded-lg border border-hairline bg-canvas-elevated px-2 text-sm text-ink focus:border-accent focus:outline-none"
        />
        <div className="w-32">
          <Select
            value={rule.freq}
            onValueChange={(v) =>
              set({ freq: v as RecurrenceRule['freq'] })
            }
            disabled={disabled}
            options={[
              { value: 'daily', label: rule.interval > 1 ? 'days' : 'day' },
              { value: 'weekly', label: rule.interval > 1 ? 'weeks' : 'week' },
              { value: 'monthly', label: rule.interval > 1 ? 'months' : 'month' },
              { value: 'yearly', label: rule.interval > 1 ? 'years' : 'year' }
            ]}
          />
        </div>
      </div>

      {rule.freq === 'weekly' && (
        <div>
          <span className="mb-1 block text-[11px] font-medium text-faint">Repeat on</span>
          <div className="flex gap-1">
            {WEEKDAYS_SHORT.map((label, day) => {
              const on = (rule.byWeekday ?? [anchor.getDay()]).includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  onClick={() => toggleDay(day)}
                  className={
                    'size-8 rounded-full text-xs font-medium transition-colors ' +
                    (on
                      ? 'bg-accent text-white'
                      : 'border border-hairline bg-canvas-elevated text-muted hover:text-ink')
                  }
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {rule.freq === 'monthly' && (
        <Select
          value={rule.monthlyMode ?? 'weekday'}
          onValueChange={(v) => set({ monthlyMode: v as 'date' | 'weekday' })}
          disabled={disabled}
          options={[
            {
              value: 'weekday',
              label: `On the ${ORDINAL[Math.min(Math.ceil(anchor.getDate() / 7), 5) - 1]} ${WEEKDAYS_LONG[anchor.getDay()]}`
            },
            { value: 'date', label: `On day ${anchor.getDate()}` }
          ]}
        />
      )}

      <EndEditor anchor={anchor} end={rule.end} onChange={(end) => set({ end })} disabled={disabled} />

      <p className="text-[11px] leading-relaxed text-faint">{describeRule(rule, anchor)}</p>
    </div>
  )
}

function EndEditor({
  anchor,
  end,
  onChange,
  disabled
}: {
  anchor: Date
  end: RecurrenceEnd
  onChange: (end: RecurrenceEnd) => void
  disabled: boolean
}): React.JSX.Element {
  const untilDefault = (): string => {
    const d = new Date(anchor)
    d.setMonth(d.getMonth() + 3)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  return (
    <div className="grid gap-2">
      <span className="text-[11px] font-medium text-faint">Ends</span>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-36">
          <Select
            value={end.type}
            onValueChange={(v) => {
              if (v === 'never') onChange({ type: 'never' })
              else if (v === 'until') onChange({ type: 'until', until: untilDefault() })
              else onChange({ type: 'count', count: 10 })
            }}
            disabled={disabled}
            options={[
              { value: 'never', label: 'Never' },
              { value: 'until', label: 'On date' },
              { value: 'count', label: 'After' }
            ]}
          />
        </div>

        {end.type === 'until' && (
          <div className="w-44">
            <DatePicker
              value={end.until}
              disabled={disabled}
              onChange={(until) => onChange({ type: 'until', until })}
            />
          </div>
        )}

        {end.type === 'count' && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="number"
              min={1}
              max={999}
              value={end.count}
              disabled={disabled}
              onChange={(e) => onChange({ type: 'count', count: Math.max(1, Number(e.target.value) || 1) })}
              className="h-8 w-16 rounded-lg border border-hairline bg-canvas-elevated px-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <span>occurrences</span>
          </div>
        )}
      </div>
    </div>
  )
}
