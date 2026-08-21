import { useCallback, useEffect, useState } from 'react'
import { listAudioInputsGrouped, type AudioInputDevice } from '@/services/audio-devices'
import { log } from '@/services/ipc'

interface UseAudioDevicesResult {
  microphones: AudioInputDevice[]
  monitors: AudioInputDevice[]
  loading: boolean
  refresh: () => Promise<void>
}

/**
 * Enumerates audio inputs and keeps the list current.
 *
 * `devicechange` fires when a headset is plugged in or a Bluetooth device
 * connects, so the settings dropdowns stay accurate without a manual refresh.
 */
export function useAudioDevices(): UseAudioDevicesResult {
  const [microphones, setMicrophones] = useState<AudioInputDevice[]>([])
  const [monitors, setMonitors] = useState<AudioInputDevice[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const grouped = await listAudioInputsGrouped()
      setMicrophones(grouped.microphones)
      setMonitors(grouped.monitors)
    } catch (error) {
      log.warn('audio-devices', 'Could not enumerate audio inputs', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()

    const handler = (): void => {
      void refresh()
    }

    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler)
    }
  }, [refresh])

  return { microphones, monitors, loading, refresh }
}
