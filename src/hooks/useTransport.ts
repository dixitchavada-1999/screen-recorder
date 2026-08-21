import { useCallback, useMemo } from 'react'
import type { FinalizeResult } from '@shared/types'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { unwrap } from '@/services/ipc'
import { recordingController } from '@/services/recording-controller'
import { selectionStore } from '@/services/selection-store'

export interface Transport {
  start: () => Promise<void>
  /** Resolves with the saved recording, or null when the run failed. */
  stop: () => Promise<FinalizeResult | null>
  pause: () => void
  resume: () => void
  cancel: () => Promise<void>
}

/**
 * The single implementation of the transport controls.
 *
 * Both the on-screen buttons and the tray menu route through here, so the two
 * can never drift apart — a recording started from the tray behaves exactly
 * like one started from the window, notifications included.
 */
export function useTransport(): Transport {
  const { settings } = useSettings()
  const { push } = useToast()

  const start = useCallback(async () => {
    const source = selectionStore.getSnapshot()

    if (!source) {
      push({
        tone: 'warning',
        title: 'No capture source selected',
        description: 'Open the app and choose a screen or window first.'
      })
      return
    }
    if (!settings) return

    try {
      await recordingController.start(source, settings)
    } catch {
      // The failure is surfaced through the controller's error state.
    }
  }, [settings, push])

  const stop = useCallback(async (): Promise<FinalizeResult | null> => {
    const result = await recordingController.stop()
    if (!result) return null

    push({
      tone: 'success',
      title: 'Recording saved',
      description: result.outputPath,
      actions: [
        {
          label: 'Show in folder',
          onClick: () => void unwrap(window.api.shell.revealItem(result.outputPath))
        }
      ]
    })

    if (result.usedFallbackEncoder) {
      push({
        tone: 'warning',
        title: 'Hardware encoding was unavailable',
        description: 'The recording was encoded on the CPU instead.'
      })
    }

    return result
  }, [push])

  const cancel = useCallback(async () => {
    await recordingController.cancel()
    push({ tone: 'info', title: 'Recording discarded' })
  }, [push])

  const pause = useCallback(() => recordingController.pause(), [])
  const resume = useCallback(() => recordingController.resume(), [])

  return useMemo(
    () => ({ start, stop, pause, resume, cancel }),
    [start, stop, pause, resume, cancel]
  )
}
