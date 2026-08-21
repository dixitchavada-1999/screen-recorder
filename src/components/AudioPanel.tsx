import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppSettings, CaptureSource } from '@shared/types'
import type { DeepPartial } from '@shared/api'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Controls'
import { cn } from '@/utils/cn'
import { useAudioLevels } from '@/hooks/useRecorder'
import { audioTester, type TestTarget } from '@/services/audio-tester'
import type { AudioStatus } from '@/services/recording-controller'

interface AudioPanelProps {
  settings: AppSettings
  status: AudioStatus
  live: boolean
  selectedSource: CaptureSource | null
  supportsNativeLoopback: boolean
  onUpdate: (patch: DeepPartial<AppSettings>) => void
}

/**
 * Audio sources, live meters, and a device check for each input.
 *
 * During a recording the meters read from the mixer's analysers, so they show
 * exactly what is being written to the file. Outside a recording, the test
 * controls open their own short-lived streams to prove the inputs work before
 * the user commits to a take.
 */
export function AudioPanel({
  settings,
  status,
  live,
  selectedSource,
  supportsNativeLoopback,
  onUpdate
}: AudioPanelProps): React.JSX.Element {
  const recordingLevels = useAudioLevels(live)
  const test = useSyncExternalStore(audioTester.subscribe, audioTester.getSnapshot)
  const testLevel = useTestLevel(test.phase === 'monitoring' || test.phase === 'recording')

  // A test must never fight with a recording for the same device.
  useEffect(() => {
    if (live && test.target) void audioTester.stop()
  }, [live, test.target])

  // Release the device when the panel unmounts (e.g. navigating to Settings).
  useEffect(() => {
    return () => {
      void audioTester.stop()
    }
  }, [])

  /**
   * A failed test keeps its `target` so the error stays on screen, but it is
   * not running — the button must offer "Test" again rather than "Stop test".
   */
  const isTestRunning = (target: TestTarget): boolean =>
    test.target === target && test.phase !== 'idle'

  const toggleTest = useCallback(
    (target: TestTarget) => {
      if (test.target === target && test.phase !== 'idle') {
        void audioTester.stop()
        return
      }
      void audioTester.start(target, settings, selectedSource, supportsNativeLoopback)
    },
    [test.target, test.phase, settings, selectedSource, supportsNativeLoopback]
  )

  return (
    <Card title="Audio" description="Both sources are mixed into one stereo track.">
      <div className="flex flex-col gap-4">
        <AudioSource
          label="Microphone"
          description="Your narration."
          enabled={settings.audio.microphoneEnabled}
          onEnabledChange={(microphoneEnabled) => onUpdate({ audio: { microphoneEnabled } })}
          level={test.target === 'microphone' ? testLevel : recordingLevels.microphone}
          active={
            test.target === 'microphone'
              ? test.phase !== 'idle'
              : live && status.microphoneActive
          }
          testing={isTestRunning('microphone')}
          disabled={live}
          onToggleTest={() => toggleTest('microphone')}
        />

        {test.target === 'microphone' && <TestPanel target="microphone" test={test} />}

        <div className="border-t border-hairline pt-3">
          <AudioSource
            label="System audio"
            description="Everything you can hear from the machine."
            enabled={settings.audio.systemAudioEnabled}
            onEnabledChange={(systemAudioEnabled) =>
              onUpdate({ audio: { systemAudioEnabled } })
            }
            level={test.target === 'systemAudio' ? testLevel : recordingLevels.systemAudio}
            active={
              test.target === 'systemAudio'
                ? test.phase !== 'idle'
                : live && status.systemAudioActive
            }
            testing={isTestRunning('systemAudio')}
            disabled={live}
            onToggleTest={() => toggleTest('systemAudio')}
          />
        </div>

        {test.target === 'systemAudio' && <TestPanel target="systemAudio" test={test} />}

        {status.note && !test.target && (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
            {status.note}
          </p>
        )}
      </div>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*                                One input row                               */
/* -------------------------------------------------------------------------- */

interface AudioSourceProps {
  label: string
  description: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  level: number
  active: boolean
  testing: boolean
  disabled: boolean
  onToggleTest: () => void
}

function AudioSource({
  label,
  description,
  enabled,
  onEnabledChange,
  level,
  active,
  testing,
  disabled,
  onToggleTest
}: AudioSourceProps): React.JSX.Element {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Toggle
            label={label}
            description={description}
            checked={enabled}
            onCheckedChange={onEnabledChange}
          />
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <LevelMeter level={level} active={active} enabled={enabled} />
        <Button
          size="sm"
          variant={testing ? 'primary' : 'ghost'}
          onClick={onToggleTest}
          disabled={disabled}
          title={
            disabled
              ? 'Testing is unavailable while a recording is running'
              : `Check that ${label.toLowerCase()} is working`
          }
        >
          {testing ? 'Stop test' : 'Test'}
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*                             Expanded test panel                            */
/* -------------------------------------------------------------------------- */

function TestPanel({
  target,
  test
}: {
  target: TestTarget
  test: ReturnType<typeof audioTester.getSnapshot>
}): React.JSX.Element {
  if (test.error) {
    return (
      <p className="rounded-lg border border-record/40 bg-record/10 px-3 py-2 text-xs leading-relaxed text-record-strong">
        {test.error}
      </p>
    )
  }

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
      {target === 'microphone' ? (
        <MicrophoneTest test={test} />
      ) : (
        <SystemAudioTest test={test} />
      )}
    </div>
  )
}

function MicrophoneTest({
  test
}: {
  test: ReturnType<typeof audioTester.getSnapshot>
}): React.JSX.Element {
  return (
    <>
      <p className="text-xs leading-relaxed text-muted">
        {test.phase === 'starting' && 'Opening the microphone…'}
        {test.phase === 'monitoring' &&
          'Speak — the bar above should move. Record a sample to hear how you sound.'}
        {test.phase === 'recording' &&
          `Recording a sample… ${test.secondsLeft}s left. Say a few words.`}
        {test.phase === 'ready' && 'Play it back. If it sounds right, you are ready to record.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {test.phase === 'monitoring' && (
          <Button size="sm" variant="secondary" onClick={() => audioTester.recordSample()}>
            Record a 5s sample
          </Button>
        )}

        {test.phase === 'recording' && (
          <Button size="sm" variant="secondary" onClick={() => audioTester.finishSample()}>
            Stop early
          </Button>
        )}

        {test.phase === 'ready' && test.clipUrl && (
          <>
            {/* Native controls give play, scrub and volume at no cost. */}
            <audio src={test.clipUrl} controls autoPlay className="h-8 min-w-0 flex-1" />
            <Button size="sm" variant="ghost" onClick={() => audioTester.clearSample()}>
              Retry
            </Button>
          </>
        )}
      </div>
    </>
  )
}

function SystemAudioTest({
  test
}: {
  test: ReturnType<typeof audioTester.getSnapshot>
}): React.JSX.Element {
  return (
    <>
      <p className="text-xs leading-relaxed text-muted">
        {test.phase === 'starting'
          ? 'Opening the system-audio loopback…'
          : 'Play any sound on your machine — or use the test tone — and watch the bar above.'}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={test.tonePlaying || test.phase === 'starting'}
          onClick={() => audioTester.playTone()}
        >
          {test.tonePlaying ? 'Playing tone…' : 'Play test tone'}
        </Button>
        <span className="text-[11px] text-faint">
          A flat bar while sound is playing means system audio is not being captured.
        </span>
      </div>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*                                 Level meter                                */
/* -------------------------------------------------------------------------- */

/**
 * Peak meter with a perceptual curve — a linear scale spends most of its width
 * on levels nobody can hear.
 */
function LevelMeter({
  level,
  active,
  enabled
}: {
  level: number
  active: boolean
  enabled: boolean
}): React.JSX.Element {
  const scaled = active ? Math.min(1, level ** 0.6) : 0
  const clipping = scaled > 0.94

  return (
    <div className="flex flex-1 items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-75 ease-out',
            clipping ? 'bg-record' : 'bg-positive'
          )}
          style={{ width: `${scaled * 100}%` }}
        />
      </div>
      <span
        className={cn(
          'w-10 shrink-0 text-right text-[10px] uppercase tracking-wide',
          !enabled ? 'text-faint' : active ? 'text-positive' : 'text-faint'
        )}
      >
        {!enabled ? 'Off' : active ? 'Live' : 'Idle'}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/** Polls the tester's level at ~20 Hz, outside React's state for the meter. */
function useTestLevel(active: boolean): number {
  const [level, setLevel] = useState(0)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      setLevel(0)
      return
    }

    let lastUpdate = 0

    const tick = (timestamp: number): void => {
      if (timestamp - lastUpdate > 50) {
        lastUpdate = timestamp
        setLevel(audioTester.readLevel())
      }
      frame.current = requestAnimationFrame(tick)
    }

    frame.current = requestAnimationFrame(tick)

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [active])

  return level
}
