import { useMemo, useState } from 'react'
import { TranscriptLines, transcriptAsText } from '@/components/TranscriptLines'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/context/ToastContext'
import { useTranscript } from '@/hooks/useTranscript'
import { cn } from '@/utils/cn'

interface TranscriptPanelProps {
  recordingId: string | null
  /** Jumps the player to a moment, in seconds. */
  onSeek: (seconds: number) => void
}

/**
 * What was said in a recording, and who said it.
 *
 * Every line carries the moment it was spoken, and clicking one moves the video
 * there — which is the whole reason a transcript beats a summary: it is an index
 * into the recording, not a replacement for it.
 *
 * Speakers come from the audio channels rather than from guessing at voices.
 * The microphone was recorded hard left and system sound hard right, so "you"
 * and "them" are a fact about where the sound came from.
 *
 * The text is always English, whatever was spoken. The panel says so before the
 * job starts and names the language it heard afterwards — otherwise a Gujarati
 * conversation coming back in English reads as the wrong transcript rather than
 * as a translated one.
 */
export function TranscriptPanel({
  recordingId,
  onSeek
}: TranscriptPanelProps): React.JSX.Element {
  const { transcript, availability, progress, loading, error, start, cancel, remove } =
    useTranscript(recordingId)
  const { push } = useToast()

  const [withTimes, setWithTimes] = useState(true)

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      push({ tone: 'success', title: `${what} copied` })
    } catch {
      push({ tone: 'error', title: 'Could not copy', description: 'The clipboard refused.' })
    }
  }

  const asText = useMemo(
    () => (transcript ? transcriptAsText(transcript.segments, withTimes) : ''),
    [transcript, withTimes]
  )

  if (loading) return <p className="text-xs text-faint">Loading…</p>

  /* ---------------------------- Nothing to offer --------------------------- */

  if (!availability.hasAudio) {
    return (
      <Note>
        This recording has no audio, so there is nothing to transcribe. Switch the microphone
        or system sound on in the Recorder before the next one.
      </Note>
    )
  }

  if (!availability.engineReady) {
    return <Note>The speech engine is missing from this installation.</Note>
  }

  /* ------------------------------- Running -------------------------------- */

  if (progress) {
    return (
      <div className="rounded-xl border border-hairline bg-surface p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-ink">{progress.detail}…</p>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>

        <div className="mt-2 h-1 overflow-hidden rounded-full bg-canvas">
          <div
            className={cn(
              'h-full bg-accent transition-[width]',
              // No measurable length yet — a bar that sits at zero reads as
              // stuck, so it paces instead.
              progress.percent === null && 'w-1/3 animate-pulse'
            )}
            style={progress.percent === null ? undefined : { width: `${progress.percent}%` }}
          />
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          This runs on this machine, so nothing is sent anywhere — and it takes a while.
        </p>
      </div>
    )
  }

  /* ------------------------------ Not made yet ---------------------------- */

  if (!transcript) {
    return (
      <div className="rounded-xl border border-dashed border-hairline p-4 text-center">
        <p className="text-xs leading-relaxed text-muted">
          Read the conversation as text, with each line linked to the moment it was said.
          Whatever language was spoken, the transcript comes back in English.
        </p>

        {error && <p className="mt-2 text-xs text-record-strong">{error.message}</p>}

        <Button
          size="sm"
          variant="primary"
          className="mt-3"
          disabled={availability.busy}
          onClick={() => void start()}
        >
          {availability.busy ? 'Another one is running' : 'Transcribe'}
        </Button>
      </div>
    )
  }

  /* -------------------------------- The text ------------------------------ */

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-faint">
          {transcript.segments.length} lines · {Math.round(transcript.tookMs / 1000)}s to read
          {transcript.detectedLanguage &&
            transcript.detectedLanguage !== 'en' &&
            ` · translated from ${languageName(transcript.detectedLanguage)}`}
        </span>

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => setWithTimes((current) => !current)}
          className="rounded-lg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink"
        >
          {withTimes ? 'Hide times' : 'Show times'}
        </button>

        <Button size="sm" variant="secondary" onClick={() => void copy(asText, 'Transcript')}>
          Copy all
        </Button>

        <Button size="sm" variant="ghost" onClick={() => void remove()}>
          Delete
        </Button>
      </div>

      <TranscriptLines
        segments={transcript.segments}
        onSeek={onSeek}
        className="max-h-[22rem]"
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-xl border border-dashed border-hairline p-4 text-center text-xs leading-relaxed text-faint">
      {children}
    </p>
  )
}

/**
 * The language Whisper heard, as somebody would say it.
 *
 * `Intl.DisplayNames` knows every code Whisper can return, so there is no list
 * here to fall behind one; the code itself is the fallback on the rare platform
 * that cannot name it.
 */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}
