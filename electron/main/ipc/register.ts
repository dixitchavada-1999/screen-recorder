import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import { IPC } from '@shared/ipc'
import type { DeepPartial } from '@shared/api'
import type {
  ActivityDay,
  AppInfo,
  AppRole,
  CallScope,
  RosterPerson,
  AppSettings,
  AuthUser,
  FinalizeRequest,
  GoogleAccount,
  GoogleCalendarSyncResult,
  KpiNote,
  TaskBoard,
  TaskBoardDetail,
  TaskCardInput,
  TaskCardMove,
  TaskDueToday,
  WhisperModelKey,
  TaskNote,
  LogPayload,
  MediaPermissions,
  PermissionInfo,
  PermissionKind,
  RecorderStateSync,
  ScheduledCallInput,
  ScheduledCallRange,
  ScheduledCallStatus,
  SignInInput,
  TrackedPerson,
  TrackingPolicy,
  UpdateStatus,
  UserPermission
} from '@shared/types'
import { isGoogleConfigured } from '../config/google'
import { handled } from '../lib/errors'
import { logger } from '../lib/logger'
import {
  currentUser,
  refreshAccount,
  restoreSession,
  signIn,
  signOut,
  signOutEverywhere
} from '../services/auth'
import {
  createCall,
  deleteCall,
  deleteCallsFromGoogleAccount,
  listCalls,
  listRoster,
  setCallStatus,
  updateCall
} from '../services/calls'
import { createKpiNote, deleteKpiNote, listKpiNotes } from '../services/kpi'
import {
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  listUserPermissions,
  renameRole,
  setRolePermissions,
  setUserPermissions,
  setUserRole
} from '../services/roles'
import {
  addCardNote,
  createBoard,
  createCard,
  createList,
  deleteBoard,
  deleteCard,
  deleteCardNote,
  deleteList,
  listBoards,
  listCardNotes,
  listTasksDueToday,
  moveCard,
  readBoard,
  renameBoard,
  renameList,
  setBoardMembers,
  updateCard
} from '../services/tasks'
import { refreshReminderPrefs, resetReminderPrefs } from '../services/reminder-prefs'
import { requestRosterSync } from '../services/roster'
import {
  connectGoogleAccount,
  disconnectGoogleAccount,
  listGoogleAccounts
} from '../services/google-accounts'
import { syncGoogleCalendars } from '../services/google-calendar'
import { readActivityDay } from '../services/activity-day'
import { currentPolicy, refreshPolicy } from '../services/tracking-policy'
import { listTrackedPeople, setTrackingPolicyFor } from '../services/tracked-people'
import { refreshReminders } from '../services/reminders'
import { getStatus as getMcpStatus, regenerateToken as regenerateMcpToken } from '../services/mcp-server'
import { getFfmpegVersion, resolveFfmpegPath } from '../services/ffmpeg-locator'
import {
  chooseLibraryFolder,
  defaultLibraryDirectory,
  deleteRecording,
  exportRecording,
  forgetRecording,
  libraryDirectory,
  listRecordings,
  openLibraryFolder,
  setRecordingNote
} from '../services/library'
import {
  abortSession,
  beginSession,
  discardOrphan,
  finalizeSession,
  listOrphanRecordings,
  restoreOrphan,
  writeChunk,
  writeVoiceChunk
} from '../services/recording-session'
import {
  cancelTranscript,
  fileIdFor,
  transcribeFile,
  transcribeRecording,
  transcriptIsRunning
} from '../services/transcribe'
import { deleteTranscript, readTranscript, writeTranscript } from '../services/transcript-store'
import { hasVoiceTrack } from '../services/voice-track'
import { whisperIsAvailable } from '../services/whisper-locator'
import { modelStatuses } from '../services/whisper-model'
import {
  getMediaPermissions,
  openPrivacySettings,
  requestAccessibilityAccess,
  requestMicrophoneAccess
} from '../services/permissions'
import { settingsStore } from '../services/settings-store'
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  updateStatus
} from '../services/updater'
import { listCaptureSources, resolveCaptureSource } from '../services/sources'
import { updateShortcutState } from '../services/shortcuts'
import { updateTrayState } from '../services/tray'
import { hideMainWindow, setCaptureExclusion } from '../window'

const SCOPE = 'ipc'

/**
 * Registers every IPC handler exactly once.
 *
 * All request handlers are wrapped by `handled()`, which converts thrown
 * `AppError`s into serialisable `IpcResult` values. That keeps error codes
 * intact across the context bridge instead of collapsing them into Electron's
 * generic "Error invoking remote method" string.
 */
export function registerIpcHandlers(): void {
  /* ------------------------------- App info ------------------------------- */

  ipcMain.handle(
    IPC.APP_INFO,
    handled(SCOPE, async (): Promise<AppInfo> => {
      const [ffmpegPath, ffmpegVersion] = await Promise.all([
        resolveFfmpegPath(),
        getFfmpegVersion()
      ])

      return {
        version: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        chromeVersion: process.versions.chrome ?? 'unknown',
        platform: process.platform,
        ffmpegPath,
        ffmpegVersion,
        logDirectory: logger.getDirectory(),
        recordingsDirectory: libraryDirectory(),
        defaultRecordingsDirectory: defaultLibraryDirectory(),
        // Only Windows exposes desktop loopback audio through getUserMedia.
        supportsNativeLoopback: process.platform === 'win32',
        googleConfigured: isGoogleConfigured()
      }
    })
  )

  /* -------------------------------- Updates ------------------------------- */

  ipcMain.handle(
    IPC.UPDATE_STATUS,
    handled(SCOPE, (): UpdateStatus => updateStatus())
  )

  ipcMain.handle(
    IPC.UPDATE_CHECK,
    handled(SCOPE, (): Promise<UpdateStatus> => checkForUpdates())
  )

  ipcMain.handle(
    IPC.UPDATE_DOWNLOAD,
    handled(SCOPE, (): Promise<UpdateStatus> => downloadUpdate())
  )

  ipcMain.handle(
    IPC.UPDATE_INSTALL,
    handled(SCOPE, (): void => installUpdate())
  )

  /* ------------------------------- Settings ------------------------------- */

  ipcMain.handle(
    IPC.SETTINGS_GET,
    handled(SCOPE, (): AppSettings => settingsStore.get())
  )

  ipcMain.handle(
    IPC.SETTINGS_UPDATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, patch: DeepPartial<AppSettings>) =>
      settingsStore.update(patch)
    )
  )

  ipcMain.handle(
    IPC.SETTINGS_RESET,
    handled(SCOPE, (): AppSettings => settingsStore.reset())
  )

  // Broadcast changes so every open window stays in sync.
  settingsStore.on('changed', (settings: AppSettings) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.EVENT_SETTINGS_CHANGED, settings)
      }
    }
  })

  /* -------------------------------- Sources ------------------------------- */

  ipcMain.handle(
    IPC.SOURCES_LIST,
    handled(
      SCOPE,
      (
        _event: Electron.IpcMainInvokeEvent,
        options?: { thumbnailWidth?: number; includeWindows?: boolean }
      ) => listCaptureSources(options ?? {})
    )
  )

  ipcMain.handle(
    IPC.SOURCES_RESOLVE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, sourceId: string) =>
      resolveCaptureSource(String(sourceId))
    )
  )

  /* ------------------------------ Permissions ------------------------------ */

  ipcMain.handle(
    IPC.PERMISSIONS_GET,
    handled(SCOPE, (): MediaPermissions => getMediaPermissions())
  )

  ipcMain.handle(
    IPC.PERMISSIONS_REQUEST_MICROPHONE,
    handled(SCOPE, (): Promise<MediaPermissions> => requestMicrophoneAccess())
  )

  ipcMain.handle(
    IPC.PERMISSIONS_REQUEST_ACCESSIBILITY,
    handled(SCOPE, (): MediaPermissions => requestAccessibilityAccess())
  )

  ipcMain.handle(
    IPC.PERMISSIONS_OPEN_SETTINGS,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, kind: PermissionKind) =>
      openPrivacySettings(
        kind === 'microphone' || kind === 'accessibility' ? kind : 'screen'
      )
    )
  )

  /* -------------------------------- Accounts ------------------------------- */

  /**
   * The session, restoring one from disk on the first ask.
   *
   * The promise is cached rather than an "already started" flag: React mounts
   * effects twice in development, so a second call arrives while the first is
   * still restoring. A flag would send that caller an empty answer and the UI
   * would show "Log in" for an account that was about to come back. Every
   * caller now awaits the same restore.
   */
  let sessionRestore: Promise<AuthUser | null> | null = null

  ipcMain.handle(
    IPC.AUTH_REFRESH,
    handled(SCOPE, (): Promise<AuthUser | null> => refreshAccount())
  )

  ipcMain.handle(
    IPC.AUTH_SESSION,
    handled(SCOPE, async () => {
      sessionRestore ??= restoreSession().then((restored) => {
        // The reminder scheduler started before there was a session to read a
        // schedule with. This is the first moment it can arm anything.
        if (restored) void refreshReminders()

        /*
         * And the first moment the tracking policy can be settled either way.
         *
         * Unconditional, unlike the line above. A restore that failed is the
         * more interesting case: it means this machine is signed in but cannot
         * reach the server, which is exactly when the policy falls back to the
         * one it remembers. Refreshing only on success would leave an offline
         * machine recording nothing until the next poll, or all day.
         */
        void refreshPolicy()
        // And the first moment this person's chosen warnings can be put where
        // the server can read them.
        if (restored) void refreshReminderPrefs()
        return restored
      })

      await sessionRestore
      // Read through afterwards: by now a sign-in may have replaced it.
      return currentUser()
    })
  )

  ipcMain.handle(
    IPC.AUTH_SIGN_IN,
    handled(SCOPE, async (_event: Electron.IpcMainInvokeEvent, input: SignInInput) => {
      const user = await signIn(input)
      // The schedule only becomes readable now, so this is the first chance to
      // arm anything.
      void refreshReminders()
      // And the first chance to learn what this account is meant to record.
      void refreshPolicy()
      // A different person's profile has not been told their warnings yet.
      resetReminderPrefs()
      void refreshReminderPrefs()
      return user
    })
  )

  ipcMain.handle(
    IPC.AUTH_SIGN_OUT,
    handled(SCOPE, async () => {
      await signOut()
      // Drops every armed reminder: the schedule is no longer ours to announce.
      void refreshReminders()
      // Stops tracking with it — there is no longer an account to file it under.
      void refreshPolicy()
    })
  )

  ipcMain.handle(
    IPC.AUTH_SIGN_OUT_ALL,
    handled(SCOPE, () => signOutEverywhere())
  )

  /*
   * No sign-up, rename or password change.
   *
   * All three belong to Nexus. Handlers that answered them here would either do
   * nothing anybody wanted — a second account, a name overwritten at the next
   * sign-in — or change a password that is not the one people sign in with.
   */

  /* --------------------------- Google Calendar ----------------------------- */

  ipcMain.handle(
    IPC.GOOGLE_ACCOUNTS,
    handled(SCOPE, (): Promise<GoogleAccount[]> => listGoogleAccounts())
  )

  ipcMain.handle(
    IPC.GOOGLE_CONNECT,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, reconnecting?: string): Promise<GoogleAccount> =>
        connectGoogleAccount(typeof reconnecting === 'string' ? reconnecting : undefined)
    )
  )

  ipcMain.handle(
    IPC.GOOGLE_DISCONNECT,
    handled(SCOPE, async (_event: Electron.IpcMainInvokeEvent, email: string) => {
      // Local state first: the account must go even if Supabase is unreachable
      // or nobody is signed in, otherwise the user is stuck with an entry they
      // cannot remove.
      await disconnectGoogleAccount(String(email))

      try {
        await deleteCallsFromGoogleAccount(String(email))
      } catch (error) {
        logger.warn(SCOPE, 'Imported calls were left behind', { email, error })
      }
    })
  )

  ipcMain.handle(
    IPC.GOOGLE_SYNC,
    handled(
      SCOPE,
      (
        _event: Electron.IpcMainInvokeEvent,
        range: ScheduledCallRange
      ): Promise<GoogleCalendarSyncResult> => syncGoogleCalendars(range)
    )
  )

  /* --------------------------- Activity tracking --------------------------- */

  ipcMain.handle(
    IPC.TRACKING_POLICY,
    handled(SCOPE, (): TrackingPolicy => currentPolicy())
  )

  ipcMain.handle(
    IPC.TRACKING_PEOPLE,
    handled(SCOPE, (): Promise<TrackedPerson[]> => listTrackedPeople())
  )

  ipcMain.handle(
    IPC.TRACKING_SET_POLICY,
    handled(
      SCOPE,
      async (
        _event: Electron.IpcMainInvokeEvent,
        userId: string,
        patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean }
      ): Promise<TrackedPerson> => {
        const person = await setTrackingPolicyFor(String(userId), patch)

        // An administrator changing their own policy should see it take effect
        // now rather than at the next poll.
        if (currentUser()?.id === person.id) void refreshPolicy()

        return person
      }
    )
  )

  ipcMain.handle(
    IPC.TRACKING_DAY,
    handled(
      SCOPE,
      (
        _event: Electron.IpcMainInvokeEvent,
        userId: string,
        from: string,
        to: string
      ): Promise<ActivityDay> => readActivityDay(String(userId), String(from), String(to))
    )
  )

  /* -------------------------------- KPI notes ------------------------------ */

  ipcMain.handle(
    IPC.KPI_LIST,
    handled(SCOPE, (): Promise<KpiNote[]> => listKpiNotes())
  )

  ipcMain.handle(
    IPC.KPI_CREATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, body: string, nexusIds: string[]) =>
      createKpiNote(body, Array.isArray(nexusIds) ? nexusIds : [])
    )
  )

  ipcMain.handle(
    IPC.KPI_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, id: string) => deleteKpiNote(id))
  )

  ipcMain.handle(
    IPC.TASKS_NOTES,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, cardId: string): Promise<TaskNote[]> =>
        listCardNotes(String(cardId))
    )
  )

  ipcMain.handle(
    IPC.TASKS_NOTE_ADD,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, cardId: string, body: string) =>
      addCardNote(String(cardId), String(body))
    )
  )

  ipcMain.handle(
    IPC.TASKS_NOTE_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, noteId: string) =>
      deleteCardNote(String(noteId))
    )
  )

  /* ------------------------- Roles and permissions ------------------------- */

  ipcMain.handle(
    IPC.ROLES_LIST,
    handled(SCOPE, (): Promise<AppRole[]> => listRoles())
  )

  ipcMain.handle(
    IPC.ROLES_CATALOGUE,
    handled(SCOPE, (): Promise<PermissionInfo[]> => listPermissions())
  )

  ipcMain.handle(
    IPC.ROLES_CREATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, label: string) => createRole(String(label)))
  )

  ipcMain.handle(
    IPC.ROLES_RENAME,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, key: string, label: string) =>
      renameRole(String(key), String(label))
    )
  )

  ipcMain.handle(
    IPC.ROLES_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, key: string) => deleteRole(String(key)))
  )

  ipcMain.handle(
    IPC.ROLES_SET_PERMISSIONS,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, key: string, permissions: string[]) =>
      setRolePermissions(String(key), Array.isArray(permissions) ? permissions : [])
    )
  )

  ipcMain.handle(
    IPC.ROLES_SET_USER,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, userId: string, roleKey: string) =>
      setUserRole(String(userId), String(roleKey))
    )
  )

  ipcMain.handle(
    IPC.ROLES_USER_PERMISSIONS,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, userId: string): Promise<UserPermission[]> =>
        listUserPermissions(String(userId))
    )
  )

  ipcMain.handle(
    IPC.ROLES_SET_USER_PERMISSIONS,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, userId: string, overrides: UserPermission[]) =>
        setUserPermissions(String(userId), Array.isArray(overrides) ? overrides : [])
    )
  )

  /* ------------------------------ Task boards ------------------------------ */

  ipcMain.handle(
    IPC.TASKS_BOARDS,
    handled(SCOPE, (): Promise<TaskBoard[]> => listBoards())
  )

  ipcMain.handle(
    IPC.TASKS_BOARD,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, boardId: string): Promise<TaskBoardDetail> =>
        readBoard(String(boardId))
    )
  )

  ipcMain.handle(
    IPC.TASKS_DUE_TODAY,
    handled(SCOPE, (): Promise<TaskDueToday[]> => listTasksDueToday())
  )

  ipcMain.handle(
    IPC.TASKS_BOARD_CREATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, name: string) =>
      createBoard(String(name))
    )
  )

  ipcMain.handle(
    IPC.TASKS_BOARD_RENAME,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, boardId: string, name: string) =>
      renameBoard(String(boardId), String(name))
    )
  )

  ipcMain.handle(
    IPC.TASKS_BOARD_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, boardId: string) =>
      deleteBoard(String(boardId))
    )
  )

  ipcMain.handle(
    IPC.TASKS_BOARD_MEMBERS,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, boardId: string, nexusIds: string[]) =>
      setBoardMembers(String(boardId), Array.isArray(nexusIds) ? nexusIds : [])
    )
  )

  ipcMain.handle(
    IPC.TASKS_LIST_CREATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, boardId: string, name: string) =>
      createList(String(boardId), String(name))
    )
  )

  ipcMain.handle(
    IPC.TASKS_LIST_RENAME,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, listId: string, name: string) =>
      renameList(String(listId), String(name))
    )
  )

  ipcMain.handle(
    IPC.TASKS_LIST_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, listId: string) =>
      deleteList(String(listId))
    )
  )

  ipcMain.handle(
    IPC.TASKS_CARD_CREATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, listId: string, input: TaskCardInput) =>
      createCard(String(listId), input)
    )
  )

  ipcMain.handle(
    IPC.TASKS_CARD_UPDATE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, cardId: string, input: TaskCardInput) =>
      updateCard(String(cardId), input)
    )
  )

  ipcMain.handle(
    IPC.TASKS_CARD_MOVE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, cardId: string, move: TaskCardMove) =>
      moveCard(String(cardId), move)
    )
  )

  ipcMain.handle(
    IPC.TASKS_CARD_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, cardId: string) =>
      deleteCard(String(cardId))
    )
  )

  /* ------------------------------ Call manager ----------------------------- */

  ipcMain.handle(
    IPC.ROSTER_LIST,
    handled(SCOPE, (): Promise<RosterPerson[]> => listRoster())
  )

  ipcMain.handle(
    IPC.ROSTER_SYNC,
    handled(SCOPE, () => requestRosterSync())
  )

  ipcMain.handle(
    IPC.CALLS_LIST,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, range?: ScheduledCallRange, scope?: CallScope) =>
        listCalls(range, toCallScope(scope))
    )
  )

  // Every mutation re-arms the reminders: a call moved an hour later must not
  // keep the timer it had before.
  ipcMain.handle(
    IPC.CALLS_CREATE,
    handled(SCOPE, async (_event: Electron.IpcMainInvokeEvent, input: ScheduledCallInput) => {
      const call = await createCall(input)
      void refreshReminders()
      return call
    })
  )

  ipcMain.handle(
    IPC.CALLS_UPDATE,
    handled(
      SCOPE,
      async (_event: Electron.IpcMainInvokeEvent, id: string, input: ScheduledCallInput) => {
        const call = await updateCall(id, input)
        void refreshReminders()
        return call
      }
    )
  )

  ipcMain.handle(
    IPC.CALLS_SET_STATUS,
    handled(
      SCOPE,
      async (_event: Electron.IpcMainInvokeEvent, id: string, status: ScheduledCallStatus) => {
        const call = await setCallStatus(id, status)
        // A settled call has nothing left for its pending timers to announce;
        // rebuilding drops them.
        void refreshReminders()
        return call
      }
    )
  )

  ipcMain.handle(
    IPC.CALLS_DELETE,
    handled(SCOPE, async (_event: Electron.IpcMainInvokeEvent, id: string) => {
      await deleteCall(id)
      void refreshReminders()
    })
  )

  ipcMain.handle(
    IPC.MCP_GET_STATUS,
    handled(SCOPE, () => getMcpStatus())
  )

  ipcMain.handle(
    IPC.MCP_REGENERATE_TOKEN,
    handled(SCOPE, () => {
      regenerateMcpToken()
      return getMcpStatus()
    })
  )

  /* ---------------------------- Dialog and shell --------------------------- */

  ipcMain.handle(
    IPC.SHELL_OPEN_PATH,
    handled(SCOPE, async (_event: Electron.IpcMainInvokeEvent, target: string) => {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
    })
  )

  ipcMain.handle(
    IPC.SHELL_REVEAL_ITEM,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, target: string) => {
      shell.showItemInFolder(target)
    })
  )

  /* --------------------------- Recordings library -------------------------- */

  ipcMain.handle(
    IPC.LIBRARY_LIST,
    handled(SCOPE, () => listRecordings())
  )

  ipcMain.handle(
    IPC.LIBRARY_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, id: string) => deleteRecording(id))
  )

  ipcMain.handle(
    IPC.LIBRARY_FORGET,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, id: string) => forgetRecording(id))
  )

  ipcMain.handle(
    IPC.LIBRARY_EXPORT,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, id: string) => exportRecording(id))
  )

  ipcMain.handle(
    IPC.LIBRARY_OPEN_FOLDER,
    handled(SCOPE, () => openLibraryFolder())
  )

  ipcMain.handle(
    IPC.LIBRARY_CHOOSE_FOLDER,
    handled(SCOPE, () => chooseLibraryFolder())
  )

  ipcMain.handle(
    IPC.LIBRARY_SET_NOTE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, id: string, note: string) =>
      setRecordingNote(id, typeof note === 'string' ? note : '')
    )
  )

  /* ------------------------------- Recording ------------------------------ */

  ipcMain.handle(
    IPC.RECORDING_BEGIN,
    handled(SCOPE, () => beginSession())
  )

  ipcMain.handle(
    IPC.RECORDING_WRITE_CHUNK,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, sessionId: string, chunk: ArrayBuffer) =>
        writeChunk(sessionId, chunk)
    )
  )

  /* ------------------------------ Transcripts ----------------------------- */

  ipcMain.handle(
    IPC.TRANSCRIPT_GET,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, recordingId: string) =>
      readTranscript(recordingId)
    )
  )

  /*
   * Transcribing, and storing the result in one step.
   *
   * Saved here rather than left to the renderer, so a window closed while the
   * job runs does not throw away twenty minutes of work.
   */
  ipcMain.handle(
    IPC.TRANSCRIPT_START,
    handled(
      SCOPE,
      async (
        _event: Electron.IpcMainInvokeEvent,
        recordingId: string,
        model?: WhisperModelKey
      ) => {
        const transcript = await transcribeRecording(recordingId, model)
        await writeTranscript(transcript)
        return transcript
      }
    )
  )

  ipcMain.handle(
    IPC.TRANSCRIPT_CANCEL,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, recordingId: string) => {
      cancelTranscript(recordingId)
    })
  )

  ipcMain.handle(
    IPC.TRANSCRIPT_DELETE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, recordingId: string) =>
      deleteTranscript(recordingId)
    )
  )

  /**
   * Picks a media file and transcribes it.
   *
   * The picker and the job are one call rather than two, because everything in
   * between — turning a chosen path into an id, noticing that this exact file
   * has been read before — is the main process's business and nothing the
   * window would do differently.
   *
   * Returns null when the dialog was dismissed, which is not a failure.
   */
  ipcMain.handle(
    IPC.TRANSCRIPT_PICK_FILE,
    handled(SCOPE, async (event: Electron.IpcMainInvokeEvent) => {
      const parent = BrowserWindow.fromWebContents(event.sender)

      const options: Electron.OpenDialogOptions = {
        title: 'Transcribe a file',
        properties: ['openFile'],
        filters: [
          {
            name: 'Video and audio',
            extensions: [
              'mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v',
              'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'
            ]
          },
          { name: 'All files', extensions: ['*'] }
        ]
      }

      const picked = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)

      const path = picked.canceled ? null : (picked.filePaths[0] ?? null)
      if (!path) return null

      // Already read once: hand back what is stored rather than spending the
      // minutes again on a file that has not changed.
      const existing = await readTranscript(fileIdFor(path))
      if (existing) return existing

      const transcript = await transcribeFile(path)
      await writeTranscript(transcript)
      return transcript
    })
  )

  ipcMain.handle(IPC.TRANSCRIPT_MODELS, handled(SCOPE, () => modelStatuses()))

  /*
   * What the Transcript panel needs before it can offer anything: whether the
   * engine exists at all, whether this recording kept audio, and whether a job
   * is already running.
   */
  ipcMain.handle(
    IPC.TRANSCRIPT_AVAILABLE,
    handled(SCOPE, async (_event: Electron.IpcMainInvokeEvent, recordingId: string) => ({
      engineReady: await whisperIsAvailable(),
      hasAudio: hasVoiceTrack(recordingId),
      running: transcriptIsRunning(recordingId),
      busy: transcriptIsRunning()
    }))
  )

  ipcMain.handle(
    IPC.RECORDING_WRITE_VOICE_CHUNK,
    handled(
      SCOPE,
      (_event: Electron.IpcMainInvokeEvent, sessionId: string, chunk: ArrayBuffer) =>
        writeVoiceChunk(sessionId, chunk)
    )
  )

  ipcMain.handle(
    IPC.RECORDING_FINALIZE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, request: FinalizeRequest) =>
      finalizeSession(request)
    )
  )

  ipcMain.handle(
    IPC.RECORDING_ABORT,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, sessionId: string) =>
      abortSession(sessionId)
    )
  )

  /* ------------------------------- Recovery ------------------------------- */

  ipcMain.handle(
    IPC.RECOVERY_LIST,
    handled(SCOPE, () => listOrphanRecordings())
  )

  ipcMain.handle(
    IPC.RECOVERY_RESTORE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, sessionId: string) =>
      restoreOrphan(sessionId)
    )
  )

  ipcMain.handle(
    IPC.RECOVERY_DISCARD,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, sessionId: string) =>
      discardOrphan(sessionId)
    )
  )

  /* ---------------------------- Tray and window --------------------------- */

  /*
   * An invoke, unlike everything else in this section.
   *
   * The renderer has to be able to wait for it: the window must be out of shot
   * before capture begins, and a fire-and-forget send would race the first
   * frame.
   */
  ipcMain.handle(
    IPC.WINDOW_EXCLUDE_FROM_CAPTURE,
    handled(SCOPE, (_event: Electron.IpcMainInvokeEvent, excluded: boolean) => {
      setCaptureExclusion(excluded === true)
    })
  )

  // Fire-and-forget: the renderer pushes its state several times a second and
  // an invoke round-trip per tick would be pure overhead.
  ipcMain.on(IPC.RECORDER_STATE_SYNC, (_event, state: RecorderStateSync) => {
    if (!state || typeof state.state !== 'string') return
    updateTrayState(state)
    // The global key needs the same answer the tray does: one press means start
    // or stop depending on what is already happening.
    updateShortcutState(state)
  })

  ipcMain.on(IPC.WINDOW_HIDE, () => {
    hideMainWindow()
  })

  /* --------------------------------- Logs --------------------------------- */

  ipcMain.on(IPC.LOG_WRITE, (_event, payload: LogPayload) => {
    if (!payload || typeof payload.message !== 'string') return
    logger.log(payload.level, `renderer:${payload.scope}`, payload.message, payload.data)
  })

  logger.info(SCOPE, 'IPC handlers registered')
}

/**
 * A scope the renderer sent, narrowed to one this process recognises.
 *
 * Anything unrecognised becomes `assigned` — the narrowest of the three, and
 * the right answer to a request that cannot be read. `all` is passed through
 * rather than refused: whether the person may have it is decided against their
 * role in `listCalls`, not here.
 */
function toCallScope(value: unknown): CallScope {
  return value === 'scheduled-by-me' || value === 'all' ? value : 'assigned'
}
