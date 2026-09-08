import type {
  ActivityDay,
  AppRole,
  AppInfo,
  AppSettings,
  AuthUser,
  CallReminder,
  CallScope,
  CaptureSource,
  FinalizeRequest,
  FinalizeResult,
  GoogleAccount,
  GoogleCalendarSyncResult,
  IpcResult,
  KpiNote,
  LogPayload,
  MediaPermissions,
  OrphanRecording,
  PermissionInfo,
  PermissionKind,
  ProcessingProgress,
  RecorderStateSync,
  RecordingEntry,
  RosterPerson,
  ScheduledCall,
  ScheduledCallInput,
  ScheduledCallRange,
  ScheduledCallStatus,
  SerializedError,
  TaskBoard,
  TaskBoardDetail,
  TaskCard,
  TaskCardInput,
  TaskCardMove,
  TaskDueToday,
  TaskList,
  TaskNote,
  TaskPerson,
  TrackedPerson,
  UserPermission,
  TrackingPolicy,
  SessionHandle,
  SignInInput,
  TrayCommand,
  UpdateStatus
} from './types'

/** Recursively optional — used for settings patches. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** Detaches an event listener registered through the preload bridge. */
export type Unsubscribe = () => void

/**
 * The complete surface exposed on `window.api` by the preload script.
 *
 * Every request-style method resolves to an `IpcResult` rather than throwing,
 * so failures survive structured cloning across the context bridge with their
 * error code intact. The renderer unwraps them in `src/services/ipc.ts`.
 */
export interface RecorderApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
  }

  settings: {
    get(): Promise<IpcResult<AppSettings>>
    update(patch: DeepPartial<AppSettings>): Promise<IpcResult<AppSettings>>
    reset(): Promise<IpcResult<AppSettings>>
    onChanged(listener: (settings: AppSettings) => void): Unsubscribe
  }

  sources: {
    list(options?: { thumbnailWidth?: number; includeWindows?: boolean }): Promise<IpcResult<CaptureSource[]>>
    /**
     * Turns a selected entry into one `getUserMedia` can open.
     *
     * Only needed for `placeholder` sources (Wayland). This is the call that
     * opens the capture session, and therefore the one that raises the system
     * share prompt — so it is made when a recording starts, not while the app
     * is merely showing its source list.
     */
    resolve(sourceId: string): Promise<IpcResult<CaptureSource>>
  }

  /**
   * OS-level capture permissions.
   *
   * Only macOS actually gates these per application; on Windows and Linux every
   * state comes back `not-required` so the UI can share one code path.
   */
  permissions: {
    current(): Promise<IpcResult<MediaPermissions>>
    /**
     * Shows the microphone prompt when the user has not answered it yet, and
     * resolves with the state afterwards. Never re-prompts once answered —
     * macOS only offers that switch in System Settings from then on.
     */
    requestMicrophone(): Promise<IpcResult<MediaPermissions>>
    /**
     * macOS only. Raises the system prompt that offers to open Accessibility
     * settings — where the switch actually is. Granting it needs the app
     * restarted before the input hook starts receiving anything.
     */
    requestAccessibility(): Promise<IpcResult<MediaPermissions>>
    /** Opens the OS privacy pane for that permission. */
    openSettings(kind: PermissionKind): Promise<IpcResult<void>>
  }

  /**
   * Accounts. Tokens stay in the main process — these methods only ever return
   * the profile fields the UI renders.
   */
  auth: {
    /**
     * The signed-in account, restoring a stored session on the first call.
     * Resolves to `null` when nobody is signed in.
     */
    session(): Promise<IpcResult<AuthUser | null>>
    /**
     * Checks the credentials with Nexus and starts a session.
     *
     * There is no sign-up, rename or password change beside it: accounts and
     * passwords are Nexus's, and a name set here would be replaced by the next
     * sign-in.
     */
    signIn(input: SignInInput): Promise<IpcResult<AuthUser>>
    signOut(): Promise<IpcResult<void>>
    /** Ends the session on every device, this one included. */
    signOutEverywhere(): Promise<IpcResult<void>>
    /** Fired when a session arrives from outside the window. */
    onChanged(listener: (user: AuthUser) => void): Unsubscribe
    /** Fired when such a link could not be completed (expired, already used). */
    onError(listener: (error: SerializedError) => void): Unsubscribe
  }

  /**
   * Google Calendar accounts to import calls from.
   *
   * Read-only and multi-account: connecting a second address adds to the list
   * rather than replacing the first. Tokens stay in the main process — these
   * methods only ever return an email and a colour.
   */
  google: {
    accounts(): Promise<IpcResult<GoogleAccount[]>>
    /**
     * Opens the system browser for consent and resolves with the account that
     * was connected. Rejects if the user cancels or the window is abandoned.
     *
     * Pass the email of an account already in the list to renew it: Google is
     * pointed straight at that address instead of asking which one, which is
     * the whole of what "Reconnect" has to do.
     */
    connect(reconnecting?: string): Promise<IpcResult<GoogleAccount>>
    /** Forgets the account, revokes its token, and drops its imported calls. */
    disconnect(email: string): Promise<IpcResult<void>>
    /**
     * Reconciles one date range against every connected calendar: new meetings
     * are imported, moved ones updated, cancelled ones removed.
     *
     * Resolves even when a calendar fails — the failure is named in the result
     * so one broken connection does not hide the rest.
     */
    sync(range: ScheduledCallRange): Promise<IpcResult<GoogleCalendarSyncResult>>
  }

  /**
   * Activity tracking, governed per person from the server.
   *
   * `policy` is what this machine has been told to do about the signed-in
   * account. The other two are an administrator's, and the database refuses
   * them to anybody else whatever the window shows.
   */
  tracking: {
    policy(): Promise<IpcResult<TrackingPolicy>>
    people(): Promise<IpcResult<TrackedPerson[]>>
    setPolicy(
      userId: string,
      patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean }
    ): Promise<IpcResult<TrackedPerson>>
    /** Segments and captures for one person between two instants. */
    day(userId: string, from: string, to: string): Promise<IpcResult<ActivityDay>>
  }

  /** The Call Manager's schedule, stored with the account. Requires sign-in. */
  /**
   * The people a call can be scheduled for.
   *
   * This app's own cache of the Nexus staff roster, never the partner API
   * itself — that allows fifty reads a day and is refreshed on a schedule.
   */
  roster: {
    list(): Promise<IpcResult<RosterPerson[]>>
    /** Asks the server to refresh the cache. It refuses more than once a day. */
    sync(): Promise<IpcResult<void>>
  }

  /**
   * KPI notes.
   *
   * `list` answers the same question for everybody — what is on my dashboard —
   * and row level security decides what that means: every note for a super
   * admin, only the ones addressed to you for anybody else. Writing and
   * removing are a super admin's alone, and the database enforces that whatever
   * the window shows.
   */
  kpi: {
    list(): Promise<IpcResult<KpiNote[]>>
    /** Addressed by Nexus id, so somebody who has never opened the app can be named. */
    create(body: string, nexusIds: string[]): Promise<IpcResult<KpiNote>>
    remove(id: string): Promise<IpcResult<void>>
  }

  /**
   * Roles and permissions.
   *
   * Reading is open to anybody signed in — the window has to know what it may
   * offer before it can offer it. Changing any of it belongs to a super admin,
   * and the database enforces that whatever this surface allows.
   */
  roles: {
    list(): Promise<IpcResult<AppRole[]>>
    /** Everything the app knows how to gate, for the screen to render. */
    catalogue(): Promise<IpcResult<PermissionInfo[]>>

    create(label: string): Promise<IpcResult<AppRole>>
    rename(key: string, label: string): Promise<IpcResult<void>>
    /** Refuses while anybody still holds it. */
    remove(key: string): Promise<IpcResult<void>>

    setPermissions(key: string, permissions: string[]): Promise<IpcResult<string[]>>
    setUserRole(userId: string, roleKey: string): Promise<IpcResult<void>>

    /** What one person has been given or refused on top of their role. */
    userPermissions(userId: string): Promise<IpcResult<UserPermission[]>>
    /** Replaces that whole set. An empty array puts them back on their role. */
    setUserPermissions(
      userId: string,
      overrides: UserPermission[]
    ): Promise<IpcResult<UserPermission[]>>
  }

  /**
   * Task boards — the kanban module.
   *
   * Every call runs as the signed-in account, so what comes back is whatever
   * row level security allows: the boards this person is a member of, and for a
   * super admin, all of them. Inside a board a member may do anything; opening,
   * renaming and staffing one belong to whoever opened it.
   */
  tasks: {
    /** Every board this account can see, without their contents. */
    boards(): Promise<IpcResult<TaskBoard[]>>
    /** One board with its lists, cards and assignees. */
    board(boardId: string): Promise<IpcResult<TaskBoardDetail>>
    /** Whatever is due today, wherever it is. For the dashboard. */
    dueToday(): Promise<IpcResult<TaskDueToday[]>>

    createBoard(name: string): Promise<IpcResult<TaskBoard>>
    renameBoard(boardId: string, name: string): Promise<IpcResult<void>>
    deleteBoard(boardId: string): Promise<IpcResult<void>>
    /** Replaces the membership outright. Nexus ids, as everywhere else. */
    setBoardMembers(boardId: string, nexusIds: string[]): Promise<IpcResult<TaskPerson[]>>

    createList(boardId: string, name: string): Promise<IpcResult<TaskList>>
    renameList(listId: string, name: string): Promise<IpcResult<void>>
    /** Takes the cards on it with it. */
    deleteList(listId: string): Promise<IpcResult<void>>

    createCard(listId: string, input: TaskCardInput): Promise<IpcResult<TaskCard>>
    updateCard(cardId: string, input: TaskCardInput): Promise<IpcResult<TaskCard>>
    /** Where it was dropped, as neighbours — the position is the server's to work out. */
    moveCard(cardId: string, move: TaskCardMove): Promise<IpcResult<TaskCard>>
    deleteCard(cardId: string): Promise<IpcResult<void>>

    /** Everything said on one task, oldest first. */
    notes(cardId: string): Promise<IpcResult<TaskNote[]>>
    addNote(cardId: string, body: string): Promise<IpcResult<TaskNote>>
    /** Your own always; anybody's with the permission that deletes tasks. */
    deleteNote(noteId: string): Promise<IpcResult<void>>
  }

  calls: {
    /**
     * Optionally narrowed to a half-open `[from, to)` window.
     *
     * `scope` chooses between the two different questions: `assigned` is this
     * person's own schedule, `scheduled-by-me` is what they have arranged for
     * other people. Defaults to `assigned`.
     */
    list(range?: ScheduledCallRange, scope?: CallScope): Promise<IpcResult<ScheduledCall[]>>
    create(input: ScheduledCallInput): Promise<IpcResult<ScheduledCall>>
    update(id: string, input: ScheduledCallInput): Promise<IpcResult<ScheduledCall>>
    /**
     * Changes the status and nothing else — for marking a call done or missed
     * without touching its notes or its time.
     */
    setStatus(id: string, status: ScheduledCallStatus): Promise<IpcResult<ScheduledCall>>
    remove(id: string): Promise<IpcResult<void>>
    /**
     * Fired when a call is about to start, according to the lead times in
     * Settings. The main process shows the OS notification itself; this is the
     * in-app half.
     */
    onReminder(listener: (reminder: CallReminder) => void): Unsubscribe
  }

  /**
   * Keeping the installed application current.
   *
   * Every step is asked for: the check runs on its own, but the download waits
   * for `download()` and the restart waits for `install()`. `onStatus` is how a
   * window follows a download it did not start — a second window, or the same
   * one reopened from the tray.
   */
  update: {
    /** Whatever has happened so far, for a window that has just opened. */
    status(): Promise<IpcResult<UpdateStatus>>
    check(): Promise<IpcResult<UpdateStatus>>
    download(): Promise<IpcResult<UpdateStatus>>
    /** Quits and installs. Nothing comes back if it works. */
    install(): Promise<IpcResult<void>>
    onStatus(listener: (status: UpdateStatus) => void): Unsubscribe
  }

  shell: {
    openPath(target: string): Promise<IpcResult<void>>
    revealItem(target: string): Promise<IpcResult<void>>
  }

  library: {
    /** Every catalogued recording, newest first, wherever it lives. */
    list(): Promise<IpcResult<RecordingEntry[]>>
    /** Permanently deletes a recording. */
    remove(id: string): Promise<IpcResult<void>>
    /** Drops a recording from the list without touching the file on disk. */
    forget(id: string): Promise<IpcResult<void>>
    /**
     * Copies a recording somewhere the user chooses via a save dialog.
     * Resolves to the destination path, or `null` if the dialog was cancelled.
     */
    export(id: string): Promise<IpcResult<string | null>>
    /** Opens the folder new recordings are written to. */
    openFolder(): Promise<IpcResult<void>>
    /** Attaches (or clears, when empty) a note on a recording. */
    setNote(id: string, note: string): Promise<IpcResult<void>>
    /**
     * Shows the OS folder picker for the recordings destination.
     * Resolves to the chosen absolute path, or `null` if it was cancelled.
     * Rejects when the picked folder cannot be written to.
     */
    chooseFolder(): Promise<IpcResult<string | null>>
  }

  recording: {
    /** Allocates a session and opens the intermediate file write stream. */
    begin(): Promise<IpcResult<SessionHandle>>
    /** Appends one MediaRecorder chunk to the session's file. */
    writeChunk(sessionId: string, chunk: ArrayBuffer): Promise<IpcResult<void>>
    /** Closes the stream and runs the FFmpeg pipeline. */
    finalize(request: FinalizeRequest): Promise<IpcResult<FinalizeResult>>
    /** Discards a session and removes its intermediate file. */
    abort(sessionId: string): Promise<IpcResult<void>>
    onProgress(listener: (progress: ProcessingProgress) => void): Unsubscribe
  }

  recovery: {
    list(): Promise<IpcResult<OrphanRecording[]>>
    restore(sessionId: string): Promise<IpcResult<FinalizeResult>>
    discard(sessionId: string): Promise<IpcResult<void>>
  }

  log: {
    write(payload: LogPayload): void
  }

  window: {
    /** Hides the window to the tray without quitting. */
    hide(): void
    /**
     * Keeps this window out of the recording, and afterwards puts it back.
     *
     * Awaited on the way in: the compositor has to have been told before the
     * first frame is captured, or the opening moment of every recording is a
     * picture of the recorder.
     */
    excludeFromCapture(excluded: boolean): Promise<IpcResult<void>>
    /** Fires when the window is brought back from the tray. */
    onShown(listener: () => void): Unsubscribe
    /**
     * Fires when something outside the window asks for a particular screen —
     * the tray's "Open Calendar", and anything like it later.
     */
    onOpenSection(listener: (section: string) => void): Unsubscribe
  }

  tray: {
    /** Mirrors the renderer's recording state into the tray menu. */
    syncState(state: RecorderStateSync): void
    /** Fired when the user picks a transport command from the tray menu. */
    onCommand(listener: (command: TrayCommand) => void): Unsubscribe
  }

  /** Fired when the main process asks the renderer to stop (tray/quit/shortcut). */
  onStopRequested(listener: () => void): Unsubscribe
}

declare global {
  interface Window {
    api: RecorderApi
  }
}
