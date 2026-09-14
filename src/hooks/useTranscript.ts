import { useCallback, useEffect, useState } from 'react'
import type { SerializedError, Transcript, TranscriptProgress } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

interface Availability {
  /** Whether whisper.cpp is present at all. */
  engineReady: boolean
  /** Whether this recording kept a voice track to read. */
  hasAudio: boolean
  /** Whether this recording is the one being transcribed. */
  running: boolean
  /** Whether any recording is — they run one at a time. */
  busy: boolean
}

interface UseTranscriptResult {
  transcript: Transcript | null
  availability: Availability
  progress: TranscriptProgress | null
  loading: boolean
  error: SerializedError | null
  start: () => Promise<void>
  cancel: () => void
  remove: () => Promise<void>
}

const UNKNOWN: Availability = {
  engineReady: false,
  hasAudio: false,
  running: false,
  busy: false
}

/**
 * One recording's transcript: what exists, what is running, and what can start.
 *
 * Progress arrives as an event from the main process rather than by polling,
 * because the work is minutes long and the window may be closed and reopened
 * while it runs — the job belongs to the app, not to this panel.
 */
export function useTranscript(recordingId: string | null): UseTranscriptResult {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [availability, setAvailability] = useState<Availability>(UNKNOWN)
  const [progress, setProgress] = useState<TranscriptProgress | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async (id: string) => {
    const [stored, state] = await Promise.all([
      unwrap(window.api.transcript.get(id)),
      unwrap(window.api.transcript.availability(id))
    ])
    setTranscript(stored)
    setAvailability(state)
  }, [])

  // Reset first, then load — otherwise the previous recording's transcript sits
  // on screen under the new one's title for the length of the round trip.
  useEffect(() => {
    setTranscript(null)
    setProgress(null)
    setError(null)
    setAvailability(UNKNOWN)

    if (!recordingId) return

    let cancelled = false
    setLoading(true)

    void refresh(recordingId)
      .catch((caught: unknown) => {
        if (!cancelled) setError(toSerializedError(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [recordingId, refresh])

  /*
   * Progress for whichever recording is showing.
   *
   * The event carries its own id, so a job running for one recording cannot
   * paint a progress bar onto another that happens to be open.
   */
  useEffect(() => {
    if (!recordingId) return

    return window.api.transcript.onProgress((update) => {
      if (update.id !== recordingId) return
      setProgress(update.stage === 'done' || update.stage === 'failed' ? null : update)
    })
  }, [recordingId])

  const start = useCallback(async () => {
    if (!recordingId) return

    setError(null)
    setProgress({ id: recordingId, stage: 'queued', percent: null, detail: 'Starting' })
    setAvailability((current) => ({ ...current, running: true, busy: true }))

    try {
      setTranscript(await unwrap(window.api.transcript.start(recordingId)))
    } catch (caught) {
      setError(toSerializedError(caught))
    } finally {
      setProgress(null)
      await refresh(recordingId).catch(() => undefined)
    }
  }, [recordingId, refresh])

  const cancel = useCallback(() => {
    if (!recordingId) return
    void unwrap(window.api.transcript.cancel(recordingId)).catch(() => undefined)
  }, [recordingId])

  const remove = useCallback(async () => {
    if (!recordingId) return
    await unwrap(window.api.transcript.remove(recordingId))
    setTranscript(null)
    await refresh(recordingId).catch(() => undefined)
  }, [recordingId, refresh])

  return { transcript, availability, progress, loading, error, start, cancel, remove }
}
