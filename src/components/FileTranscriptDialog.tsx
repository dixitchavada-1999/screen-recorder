import { useEffect, useMemo, useState } from 'react'
import type { Transcript, TranscriptProgress } from '@shared/types'
import { TranscriptLines, transcriptAsText } from '@/components/TranscriptLines'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/context/ToastContext'
import { toSerializedError, unwrap } from '@/services/ipc'
import { cn } from '@/utils/cn'

interface FileTranscriptDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Transcribing something that was not recorded here.
 *
 * A file arrives already mixed, so unlike this app's own captures there is
 * usually no telling one voice from another — the lines have times and words
 * and no speaker. Where a file does keep its speakers on separate channels,
 * which some call recorders do, that is noticed and used.
 *
 * There is no player alongside, so nothing to seek: this is text to read and
 * copy. The timestamps still matter, because they are how somebody finds the
 * moment again in whatever they opened the file with.
 */
export function FileTranscriptDialog({
  open,
  onClose
}: FileTranscriptDialogProps): React.JSX.Element {
  const { push } = useToast()

  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [progress, setProgress] = useState<TranscriptProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [withTimes, setWithTimes] = useState(true)

  // Nothing carries over between two files.
  useEffect(() => {
    if (open) return
    setTranscript(null)
    setProgress(null)
    setError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.api.transcript.onProgress((update) => {
      setProgress(update.stage === 'done' || update.stage === 'failed' ? null : update)
    })
  }, [open])

  const asText = useMemo(
    () => (transcript ? transcriptAsText(transcript.segments, withTimes) : ''),
    [transcript, withTimes]
  )

  const choose = async (): Promise<void> => {
    setError(null)
    setTranscript(null)
    setProgress(null)

    try {
      const result = await unwrap(window.api.transcript.pickFile())
      // Null is a dismissed dialog, which is not worth saying anything about.
      if (result) setTranscript(result)
    } catch (caught) {
      setError(toSerializedError(caught).message)
    } finally {
      setProgress(null)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(asText)
      push({ tone: 'success', title: 'Transcript copied' })
    } catch {
      push({ tone: 'error', title: 'Could not copy', description: 'The clipboard refused.' })
    }
  }

  return (
    <Modal
      open={open}
      title="Transcribe a file"
      description={transcript?.sourceName || 'Any video or audio file on this machine'}
      onClose={onClose}
      className="w-[min(44rem,calc(100vw-3rem))]"
      footer={
        <>
          {transcript && (
            <Button variant="secondary" onClick={() => void copy()}>
              Copy all
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {/* ------------------------------ Working ------------------------------ */}
      {progress && (
        <div className="rounded-xl border border-hairline bg-surface p-3">
          <p className="text-xs text-ink">{progress.detail}…</p>

          <div className="mt-2 h-1 overflow-hidden rounded-full bg-canvas">
            <div
              className={cn(
                'h-full bg-accent transition-[width]',
                progress.percent === null && 'w-1/3 animate-pulse'
              )}
              style={progress.percent === null ? undefined : { width: `${progress.percent}%` }}
            />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            Reading happens on this machine, so nothing is uploaded — and it takes about as long
            as the file is, divided by ten. A long file is worth starting and leaving.
          </p>
        </div>
      )}

      {/* ------------------------------ Nothing yet -------------------------- */}
      {!progress && !transcript && (
        <div className="rounded-xl border border-dashed border-hairline p-6 text-center">
          <p className="text-xs leading-relaxed text-muted">
            Pick a video or audio file and read it as text. Whatever language was spoken, the
            transcript comes back in English.
          </p>

          <p className="mx-auto mt-2 max-w-md text-[11px] leading-relaxed text-faint">
            Lines from a file have no speaker names — the voices arrive already mixed together
            and cannot be told apart afterwards. Recordings made here do have them, because
            the two sides were kept on separate channels while recording.
          </p>

          {error && <p className="mt-3 text-xs text-record-strong">{error}</p>}

          <Button variant="primary" className="mt-4" onClick={() => void choose()}>
            Choose a file
          </Button>
        </div>
      )}

      {/* -------------------------------- The text --------------------------- */}
      {!progress && transcript && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-faint">
              {transcript.segments.length} lines · {Math.round(transcript.tookMs / 1000)}s to read
            </span>

            <span className="flex-1" />

            <button
              type="button"
              onClick={() => setWithTimes((current) => !current)}
              className="rounded-lg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {withTimes ? 'Hide times' : 'Show times'}
            </button>

            <Button size="sm" variant="ghost" onClick={() => void choose()}>
              Another file
            </Button>
          </div>

          {transcript.segments.length === 0 ? (
            <p className="rounded-xl border border-dashed border-hairline p-6 text-center text-xs leading-relaxed text-faint">
              No speech was found in that file. Music and silence are recognised as such and
              left out.
            </p>
          ) : (
            <TranscriptLines segments={transcript.segments} className="max-h-[24rem]" />
          )}
        </div>
      )}
    </Modal>
  )
}
