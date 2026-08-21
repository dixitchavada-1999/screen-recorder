import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { recordingController, type RecorderSnapshot } from '@/services/recording-controller'

/** Subscribes the component tree to the recording controller's state. */
export function useRecorder(): RecorderSnapshot {
  return useSyncExternalStore(recordingController.subscribe, recordingController.getSnapshot)
}

/**
 * Polls live audio levels with `requestAnimationFrame`.
 *
 * Kept out of the recorder snapshot on purpose: meters update ~60 times a
 * second and would otherwise re-render the whole application.
 */
export function useAudioLevels(active: boolean): { microphone: number; systemAudio: number } {
  const [levels, setLevels] = useState({ microphone: 0, systemAudio: 0 })
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      setLevels({ microphone: 0, systemAudio: 0 })
      return
    }

    let lastUpdate = 0

    const tick = (timestamp: number): void => {
      // Throttle to ~20 Hz; the eye cannot follow more and it keeps CPU low.
      if (timestamp - lastUpdate > 50) {
        lastUpdate = timestamp
        setLevels(recordingController.readLevels())
      }
      frame.current = requestAnimationFrame(tick)
    }

    frame.current = requestAnimationFrame(tick)

    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [active])

  return levels
}
