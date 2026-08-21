import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { DeepPartial, RecorderApi, Unsubscribe } from '@shared/api'
import type {
  AppSettings,
  AuthUser,
  CallReminder,
  FinalizeRequest,
  LogPayload,
  PermissionKind,
  ProcessingProgress,
  RecorderStateSync,
  ScheduledCallInput,
  ScheduledCallRange,
  ScheduledCallStatus,
  SerializedError,
  SignInInput,
  TrayCommand,
  UpdateStatus
} from '@shared/types'

/**
 * The one and only bridge between the renderer and the main process.
 *
 * `ipcRenderer` itself is never exposed. Each method below forwards to a fixed
 * channel from the shared IPC map, so renderer code cannot reach an arbitrary
 * handler even if it is compromised by injected content.
 */

/** Subscribes to a main → renderer event and returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.off(channel, wrapped)
  }
}

const api: RecorderApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.APP_INFO)
  },

  update: {
    status: () => ipcRenderer.invoke(IPC.UPDATE_STATUS),
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    download: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
    install: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onStatus: (listener) => subscribe<UpdateStatus>(IPC.EVENT_UPDATE_STATUS, listener)
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    update: (patch: DeepPartial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS_UPDATE, patch),
    reset: () => ipcRenderer.invoke(IPC.SETTINGS_RESET),
    onChanged: (listener) => subscribe<AppSettings>(IPC.EVENT_SETTINGS_CHANGED, listener)
  },

  sources: {
    list: (options) => ipcRenderer.invoke(IPC.SOURCES_LIST, options),
    resolve: (sourceId: string) => ipcRenderer.invoke(IPC.SOURCES_RESOLVE, sourceId)
  },

  permissions: {
    current: () => ipcRenderer.invoke(IPC.PERMISSIONS_GET),
    requestMicrophone: () => ipcRenderer.invoke(IPC.PERMISSIONS_REQUEST_MICROPHONE),
    openSettings: (kind: PermissionKind) =>
      ipcRenderer.invoke(IPC.PERMISSIONS_OPEN_SETTINGS, kind)
  },

  auth: {
    session: () => ipcRenderer.invoke(IPC.AUTH_SESSION),
    signIn: (input: SignInInput) => ipcRenderer.invoke(IPC.AUTH_SIGN_IN, input),
    signOut: () => ipcRenderer.invoke(IPC.AUTH_SIGN_OUT),
    signOutEverywhere: () => ipcRenderer.invoke(IPC.AUTH_SIGN_OUT_ALL),
    onChanged: (listener) => subscribe<AuthUser>(IPC.EVENT_AUTH_CHANGED, listener),
    onError: (listener) => subscribe<SerializedError>(IPC.EVENT_AUTH_ERROR, listener)
  },

  google: {
    accounts: () => ipcRenderer.invoke(IPC.GOOGLE_ACCOUNTS),
    connect: (reconnecting?: string) => ipcRenderer.invoke(IPC.GOOGLE_CONNECT, reconnecting),
    disconnect: (email: string) => ipcRenderer.invoke(IPC.GOOGLE_DISCONNECT, email),
    sync: (range: ScheduledCallRange) => ipcRenderer.invoke(IPC.GOOGLE_SYNC, range)
  },

  tracking: {
    policy: () => ipcRenderer.invoke(IPC.TRACKING_POLICY),
    people: () => ipcRenderer.invoke(IPC.TRACKING_PEOPLE),
    setPolicy: (userId: string, patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean }) =>
      ipcRenderer.invoke(IPC.TRACKING_SET_POLICY, userId, patch),
    day: (userId: string, from: string, to: string) =>
      ipcRenderer.invoke(IPC.TRACKING_DAY, userId, from, to)
  },

  roster: {
    list: () => ipcRenderer.invoke(IPC.ROSTER_LIST),
    sync: () => ipcRenderer.invoke(IPC.ROSTER_SYNC)
  },

  kpi: {
    list: () => ipcRenderer.invoke(IPC.KPI_LIST),
    create: (body: string, nexusIds: string[]) =>
      ipcRenderer.invoke(IPC.KPI_CREATE, body, nexusIds),
    remove: (id: string) => ipcRenderer.invoke(IPC.KPI_DELETE, id)
  },

  calls: {
    list: (range, scope) => ipcRenderer.invoke(IPC.CALLS_LIST, range, scope),
    create: (input: ScheduledCallInput) => ipcRenderer.invoke(IPC.CALLS_CREATE, input),
    update: (id: string, input: ScheduledCallInput) =>
      ipcRenderer.invoke(IPC.CALLS_UPDATE, id, input),
    setStatus: (id: string, status: ScheduledCallStatus) =>
      ipcRenderer.invoke(IPC.CALLS_SET_STATUS, id, status),
    remove: (id: string) => ipcRenderer.invoke(IPC.CALLS_DELETE, id),
    onReminder: (listener) => subscribe<CallReminder>(IPC.EVENT_CALL_REMINDER, listener)
  },

  shell: {
    openPath: (target: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, target),
    revealItem: (target: string) => ipcRenderer.invoke(IPC.SHELL_REVEAL_ITEM, target)
  },

  library: {
    list: () => ipcRenderer.invoke(IPC.LIBRARY_LIST),
    remove: (id: string) => ipcRenderer.invoke(IPC.LIBRARY_DELETE, id),
    forget: (id: string) => ipcRenderer.invoke(IPC.LIBRARY_FORGET, id),
    export: (id: string) => ipcRenderer.invoke(IPC.LIBRARY_EXPORT, id),
    openFolder: () => ipcRenderer.invoke(IPC.LIBRARY_OPEN_FOLDER),
    setNote: (id: string, note: string) => ipcRenderer.invoke(IPC.LIBRARY_SET_NOTE, id, note),
    chooseFolder: () => ipcRenderer.invoke(IPC.LIBRARY_CHOOSE_FOLDER)
  },

  recording: {
    begin: () => ipcRenderer.invoke(IPC.RECORDING_BEGIN),
    writeChunk: (sessionId: string, chunk: ArrayBuffer) =>
      ipcRenderer.invoke(IPC.RECORDING_WRITE_CHUNK, sessionId, chunk),
    finalize: (request: FinalizeRequest) => ipcRenderer.invoke(IPC.RECORDING_FINALIZE, request),
    abort: (sessionId: string) => ipcRenderer.invoke(IPC.RECORDING_ABORT, sessionId),
    onProgress: (listener) =>
      subscribe<ProcessingProgress>(IPC.EVENT_PROCESSING_PROGRESS, listener)
  },

  recovery: {
    list: () => ipcRenderer.invoke(IPC.RECOVERY_LIST),
    restore: (sessionId: string) => ipcRenderer.invoke(IPC.RECOVERY_RESTORE, sessionId),
    discard: (sessionId: string) => ipcRenderer.invoke(IPC.RECOVERY_DISCARD, sessionId)
  },

  log: {
    write: (payload: LogPayload) => ipcRenderer.send(IPC.LOG_WRITE, payload)
  },

  window: {
    hide: () => ipcRenderer.send(IPC.WINDOW_HIDE),
    excludeFromCapture: (excluded: boolean) =>
      ipcRenderer.invoke(IPC.WINDOW_EXCLUDE_FROM_CAPTURE, excluded),
    onShown: (listener) => subscribe<void>(IPC.EVENT_WINDOW_SHOWN, listener)
  },

  tray: {
    syncState: (state: RecorderStateSync) =>
      ipcRenderer.send(IPC.RECORDER_STATE_SYNC, state),
    onCommand: (listener) => subscribe<TrayCommand>(IPC.EVENT_TRAY_COMMAND, listener)
  },

  onStopRequested: (listener) => {
    const wrapped = (): void => listener()
    ipcRenderer.on(IPC.EVENT_REQUEST_STOP, wrapped)
    return () => {
      ipcRenderer.off(IPC.EVENT_REQUEST_STOP, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
