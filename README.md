# Call Recorder

A desktop application for **Windows**, **macOS** and **Ubuntu Linux** that does
three things for a team:

- **Records the screen** — full screen or a single window, to MP4, with system
  audio and the microphone in one synchronised track.
- **Schedules calls** — for yourself or for colleagues, with reminders on the
  desktop and in Slack, and Google Calendar folded into the same view.
- **Records activity** — active and idle time, input counts and periodic
  screenshots, switched on per person by an administrator and visible to the
  person it is switched on for.

Built with Electron, React, TypeScript, Tailwind CSS and FFmpeg, on Supabase.
Sign-in goes through the **Nexus partner API**; see
[Accounts and Nexus](#accounts-and-nexus).

> **The name.** The package is still called `screen-recorder` and the window
> still says *Screen Recorder*. That is the application this started as, and
> renaming it is a change to the installed app's identity — worth doing
> deliberately rather than in passing.

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Accounts and Nexus](#accounts-and-nexus)
- [Call Manager](#call-manager)
- [Activity tracking](#activity-tracking)
- [The server](#the-server)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Development setup](#development-setup)
- [Build instructions](#build-instructions)
- [Settings reference](#settings-reference)
- [System audio: platform notes](#system-audio-platform-notes)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Performance notes](#performance-notes)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## Features

**Recording**

- Full-screen capture with monitor selection (multi-monitor aware)
- Single-window capture
- Live thumbnails in the source picker
- 720p / 1080p / 1440p / 4K, or the source's native resolution
- 24 / 30 / 60 fps
- Four quality tiers from "smallest files" to "near lossless"

**Audio**

- Microphone capture with device selection and a live level meter
- System audio capture (desktop loopback on Windows, PulseAudio/PipeWire monitor on
  Linux, a virtual device such as BlackHole on macOS)
- **Device tests** before you commit to a take: a live meter for either input, a
  5-second record-and-playback check for the microphone, and a generated test
  tone to prove system audio is being captured
- Both sources mixed into a single stereo track through the Web Audio API,
  with independent gain that can be adjusted mid-recording
- Audio and video share one capture timeline, so they stay in sync

**Controls**

- Start / Stop, plus Pause and Resume
- **Quick transport in the top bar**: start, pause/resume and stop icons that
  are reachable from every page — including while the Recorder page is not
  open. Each icon enables itself only when that action is legal
- `HH:MM:SS` timer that excludes paused time
- Status indicator and live "bytes written" counter
- Keyboard shortcuts: `Ctrl+Shift+R` start/stop, `Ctrl+Shift+P` pause/resume
- Discard a recording without saving

**System tray**

The app runs from the system tray and deliberately has **no taskbar button**.
Right-click the tray icon for:

| Menu item | Behaviour |
| --- | --- |
| *Screen Recorder — status* | Live status and timer (disabled header row) |
| **Show App** | Brings the window back |
| **Hide App** | Hides the window; recording continues |
| **Start Recording** | Records the selected source. Disabled if none is chosen |
| **Pause / Resume Recording** | Label follows the current state |
| **Stop Recording** | Stops, converts and saves |
| **Quit** | Closes the application completely |

A whole recording can be driven from the tray without opening the window.
Closing the window with **X**, or minimising it, hides to the tray rather than
quitting — only **Quit** exits. Launching the app again while it is resident
re-shows the existing window instead of starting a second copy.

**Output**

- MP4 (H.264 + AAC), written with `+faststart` so it streams and previews well
- Automatic unique filenames: `Recording_2026-07-27_15-30-00.mp4`
- Configurable filename pattern
- **Configurable storage folder** — *Settings → Storage → Browse…* sends new
  recordings to any writable folder, so machines with a full system drive can
  keep captures on another disk. The scratch file written during recording
  follows it too, so nothing large lands on `C:` behind your back. Changing the
  folder takes effect immediately and moves nothing: earlier recordings stay
  where they were written, and stay in the library. **Use default** returns to
  the app-managed folder under `userData`
- **The library is a catalog, not a folder** — every recording is tracked by its
  own absolute path, so recordings stay listed after the folder changes and can
  live in several places at once. A recording whose file is moved or deleted
  outside the app is shown as *File missing* with a **Remove from list** action,
  rather than silently disappearing
- "Play" and "Show in folder" from the app

**Reliability**

- Chunks stream straight to disk — RAM usage is flat regardless of length
- **Device hot-swap**: if the microphone disconnects mid-recording (Bluetooth
  dropping, USB unplugged), the recording continues and the mic is re-attached
  automatically when it comes back — only the gap is lost
- Crash recovery: an interrupted recording is offered for conversion on next launch
- Hardware encoder with automatic CPU fallback
- File logging for both processes, viewable from Settings → About

**Accounts**

- Sign-in through the Nexus partner API — one workplace password, and no
  account to create here
- Three roles, this application's rather than Nexus's: a **user** has their own
  calls, an **admin** runs everybody's, and a **super admin** additionally holds
  activity tracking, the OKRs and who else is an administrator
- Somebody who stops appearing in Nexus's staff list loses access on their own,
  and their machine stops recording

**Calls**

- Schedule a call for yourself or for anybody in the company — one person whose
  call it is, and any number joining
- A call scheduled for other people appears in *their* day, not yours; you find
  it again under **Scheduled by me**
- For an admin or a super admin the second tab is **All calls** instead —
  everybody's, each of which they can change, move or cancel
- Reminders on the desktop, in the window, and as a Slack message — all three
  following the same choice of 30 / 15 / 5 minutes or at the start
- A call that goes by without being marked is recorded as missed, quietly — you
  find it in the Call Manager rather than in a notification
- Google Calendar events from several accounts, merged into the same calendar
  and colour-coded by account

**Activity**

- Active and idle time, key presses, clicks, scrolls and periodic screenshots
- Switched on per person by an administrator, and nothing is recorded until it is
- Written to local disk first and uploaded separately, so a machine with no
  signal still records a complete day
- Everything is per machine as well as per person: one person's desk and laptop
  are two rows, not one merged timeline

---

## How it works

```
User clicks Start Recording
        |
        v
Main process opens a session file  ──────────────►  session-<uuid>.webm (temp)
        |
        v
Renderer requests permissions and captures:
   • screen via desktopCapturer + getUserMedia
     (Wayland: the portal session — and its consent prompt — happens here)
   • system audio (desktop loopback / monitor device)
   • microphone
        |
        v
Web Audio API mixes mic + system into one stereo track
        |
        v
MediaRecorder (H.264 + Opus preferred) emits a chunk every second
        |
        v
Each chunk is streamed over IPC and appended to the session file
        |
   User clicks Stop
        |
        v
Recorder flushes, streams close, session file is complete
        |
        v
FFmpeg converts to MP4
   • video already H.264  ->  stream copy (seconds, no quality loss)
   • otherwise            ->  re-encode (libx264 or GPU encoder)
   • audio Opus           ->  AAC 48 kHz stereo
        |
        v
Recording_2026-07-27_15-30-00.mp4 saved to your Videos folder
```

The intermediate file is only deleted once the MP4 has been written successfully.
If anything fails, the raw capture survives and the app offers to recover it.

---

## Accounts and Nexus

Credentials belong to **Nexus**, the company's own system. It answers exactly
one question — is this password right — and returns an id and a name. Everything
about the session afterwards belongs to this project.

```
app  ──►  login edge function  ──►  Nexus POST /verify-user   →  { id, name }
                              ──►  find or create the account here
                              ──►  register this machine
                              ◄──  an ordinary Supabase session
```

**Why an edge function and not a direct call.** The Nexus API key can attempt
logins against every member of staff, read the entire roster and send Slack
messages to the team. A desktop application is not a place a secret can be kept
— an `.asar` is a zip. So the key lives in a function secret and the app never
sees it.

**What this means in practice**

- There is no sign-up, no rename and no password change in the app. All three
  happen in Nexus; a password reset there works here immediately.
- The role — `user`, `admin` or `super_admin` — is read from `public.profiles`
  here. Nexus's administrators are not this application's administrators.
- The Supabase account carries a placeholder address rather than the person's
  real one, so nobody can obtain a session by asking Supabase for a password
  reset instead of going through Nexus. Where the instance refuses that address
  the real one is used and the reason is logged; sign-in is never blocked over it.

**When somebody leaves.** They stop appearing in the roster, and the daily sync
switches their tracking off and bans the account. Their existing session is
*not* ended — neither banning nor deleting the session row does that on this
version of GoTrue, and both were tested. Instead every policy denies them: a
departed person can read nothing, write nothing and upload nothing, and the app
notices and signs itself out. Their token stays valid and carries no authority.

---

## Call Manager

A call has one person **whose call it is** and any number **joining**. Anybody
can schedule one for anybody — the picker is the cached Nexus roster.

The important consequence: a call scheduled for other people appears in *their*
schedule, not in the scheduler's. Whoever arranged it finds it under **Scheduled
by me**, which is a different question from "what am I doing today" and is kept
as a separate view for that reason.

| | |
| --- | --- |
| **My schedule** | Calls you are on, whoever arranged them |
| **Scheduled by me** | Calls you arranged for other people |
| **All calls** | Everybody's, whoever arranged them — replaces the second tab for an admin and a super admin |

Everybody on a call is reminded about it identically. The distinction between
owner and joining is what the schedule shows, not what anybody may do — with one
exception: moving or cancelling a call belongs to whoever arranged it, or to an
admin or a super admin, who run everybody's. An ordinary user sees their own
calls and nobody else's; the **All calls** tab is not offered to them, and the
policies would not answer it if it were. The one
thing a person may always change about their own call is whether they turned up,
which goes through a database function narrow enough to change that and nothing
else.

**Reminders** arrive three ways, all following the same setting in
*Account → Settings*: a desktop notification, a message in the window, and a
Slack DM. The Slack half is sent by the server, so the preference is mirrored
onto the profile row where the server can read it — the app remains the only
thing that writes it.

Google Calendar events are imported into the same table and become ordinary
calls. Google owns the title and the time and overwrites them on every sync; the
status and notes are the user's and are never touched.

---

## Activity tracking

Built to be visible rather than silent. The switch is an administrator's, but
while it is on, the tray and the window say so and *My activity* states what is
captured, how often, and where it goes.

| What | How |
| --- | --- |
| Active / idle | `powerMonitor.getSystemIdleTime()`, sampled every 15 s, stored as stretches |
| Key presses, clicks, scrolls | A global hook that increments a counter and reads nothing else |
| Screenshots | The primary display, scaled to 1280 px, JPEG, on a fixed interval |

The input counter takes the same capability a keylogger asks for. What separates
it from one is the handler: it adds one to a number and returns. The key code is
never read, assigned or written. Those functions are three lines each so that
anybody can check.

Everything is written to `userData` first and uploaded separately, so a machine
with no signal records a complete day and catches up later. Every row carries
which machine it came from — one person with a desk machine and a laptop is two
timelines, and the unique keys are built for that.

---

## The server

Supabase, holding the schema and three edge functions.

### Migrations

Numbered files in `supabase/migrations/`, applied in order through the SQL
editor. They are not managed by the Supabase CLI — running `db push` against
this project would try to reapply all of them.

| Range | What |
| --- | --- |
| `…0001`–`…0006` | Profiles, roles, scheduled calls, Google linkage |
| `…0007`–`…0010` | Tracking policy, activity tables, screenshot bucket |
| `…0011`–`…0012` | Nexus identity, device registration, custom token claims |
| `…0013`–`…0015` | Call assignment, roster cache, policy helpers |
| `…0016`–`…0018` | Leavers: tracking off, sessions, denial by policy |
| `…0019`–`…0022` | Slack reminders and per-person warning times |

### Edge functions

| Function | Called by | What |
| --- | --- | --- |
| `login` | The app, at sign-in | Verifies with Nexus, provisions the account, issues a session |
| `roster-sync` | The app, every 6 h | Refreshes the staff roster; refuses to ask Nexus more than once a day |
| `notify-due` | The app, every 5 min | Sends the Slack reminders that have come due |

```bash
npx supabase functions deploy login       --project-ref <ref>
npx supabase functions deploy roster-sync --project-ref <ref>
npx supabase functions deploy notify-due  --project-ref <ref>
```

Every one of them asks the server to decide, and the server is what enforces the
partner API's limits — fifty roster reads a day, three hundred messages. Nothing
in the app counts anything.

### Secrets

One, set in **Project Settings → Edge Functions → Secrets**:

```
NEXUS_API_KEY = <the key from CJ>
```

It belongs nowhere else. Not in a table, not in `config/*.ts`, not in a
committed `.env`.

### Auth hook

**Authentication → Hooks → Customize Access Token (JWT) Claims** must be enabled
and pointed at `public.custom_access_token`. It adds `app_role` and
`nexus_user_id` to every token, and the call-assignment policies read the second
of those. Without the hook they see nothing.

---

## Requirements

| | Windows | macOS | Ubuntu Linux |
| --- | --- | --- | --- |
| OS | Windows 10 (1903+) or 11 | macOS 11 Big Sur+ (Intel and Apple Silicon) | Ubuntu 20.04+ / equivalent |
| Node.js | 18+ (20 or 22 LTS recommended) | same | same |
| FFmpeg | bundled | bundled | bundled (`apt install ffmpeg` also works) |
| Extra | — | Screen Recording permission in System Settings; a virtual audio device for system audio | `xdg-desktop-portal` + `xdg-desktop-portal-gtk` on Wayland |

FFmpeg ships with the app via `ffmpeg-static`; you do **not** need to install it
separately. See [`ffmpeg/README.md`](ffmpeg/README.md) to override the binary.

Beyond the machine, the application needs:

| | |
| --- | --- |
| A Supabase project | Schema, storage and the three edge functions — see [The server](#the-server) |
| A Nexus API key | Sign-in, the staff roster and Slack messages all go through it |
| A `screenshots` storage bucket | Created in the dashboard, **public off**; its policies are in migration `…0009` |

The recorder itself runs without any of that. Sign in, and the calls, the
schedule and the tracking appear.

---

## Quick start

```bash
npm install
npm run dev
```

The app opens with the renderer served by Vite and hot reload enabled.

To record: pick a screen in **Capture source**, press **Start Recording**, then
**Stop Recording**. The MP4 lands in your Videos folder and a toast offers
"Show in folder".

---

## Development setup

```bash
git clone <your-repo-url> screen-recorder
cd screen-recorder
npm install          # also downloads Electron and the FFmpeg binary
npm run dev          # start with hot reload + detached DevTools
```

### Available scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development mode with hot reload |
| `npm run build` | Typecheck, then bundle main / preload / renderer into `out/` |
| `npm start` | Preview the production bundle without packaging |
| `npm run typecheck` | Typecheck both TS projects (node + web) |
| `npm run icon` | Regenerate `build/icon.png` and the macOS tray template icons |
| `npm run pack:dir` | Unpacked build in `release/` — fastest way to test packaging |
| `npm run build:win` | Windows NSIS installer + portable `.exe` |
| `npm run build:mac` | macOS `.dmg` + `.zip` (arm64 and x64) — **must run on macOS** |
| `npm run build:linux` | Linux `.AppImage` + `.deb` |
| `npm run build:all` | Windows + Linux (see cross-platform note below) |

### Two TypeScript projects

Main and renderer have genuinely different globals, so they are typechecked
separately and neither can accidentally use the other's APIs:

- `tsconfig.node.json` — `electron/` and `shared/`, Node types, no DOM
- `tsconfig.web.json` — `src/` and `shared/`, DOM types, no Node

`npm run typecheck` runs both, and `npm run build` runs it before bundling.

---

## Build instructions

### Windows

```bash
npm run build:win
```

Produces in `release/1.0.0/`:

- `Screen Recorder-1.0.0-windows-x64.exe` — NSIS installer (per-user, choosable
  install directory, desktop + start menu shortcuts)
- `Screen Recorder-1.0.0-windows-portable.exe` — single-file portable build

The installer is unsigned. Windows SmartScreen will warn on first run; use
"More info → Run anyway", or sign the build with your own certificate by adding
`certificateFile` / `certificatePassword` to the `win` block in
`electron-builder.yml`.

### macOS

Must be run **on a Mac** — the `.app` bundle, the `.icns` icon and the `.dmg`
image are produced by macOS-only tooling, so no other host can cross-build them.
A GitHub Actions workflow is included at
[`.github/workflows/build-mac.yml`](.github/workflows/build-mac.yml) for anyone
without one.

```bash
npm ci            # pulls the macOS FFmpeg binary
npm run build:mac
```

Produces in `release/1.1.1/`:

- `Screen Recorder-1.1.1-mac-arm64.dmg` / `-x64.dmg` — drag-to-Applications image
- matching `.zip` archives

The build is ad-hoc signed, so no Apple Developer account is needed, but
Gatekeeper will refuse the first launch: right-click → **Open**, or run
`xattr -cr "/Applications/Screen Recorder.app"`. To ship a signed build, put your
`Developer ID Application` identity in the `mac.identity` field of
`electron-builder.yml` and supply the certificate through `CSC_LINK` /
`CSC_KEY_PASSWORD`.

After installing, macOS needs **System Settings → Privacy & Security → Screen
Recording** switched on for Screen Recorder, and the app quit and reopened. The
app detects a missing grant and says so rather than showing an empty source list.

### Ubuntu Linux

```bash
npm run build:linux
```

Produces in `release/1.0.0/`:

- `Screen Recorder-1.0.0-linux-x64.AppImage` — run anywhere, no install
- `Screen Recorder-1.0.0-linux-x64.deb` — `sudo apt install ./<file>.deb`

```bash
# AppImage
chmod +x "Screen Recorder-1.0.0-linux-x64.AppImage"
./"Screen Recorder-1.0.0-linux-x64.AppImage"

# Debian package
sudo apt install ./"Screen Recorder-1.0.0-linux-x64.deb"
```

### Cross-platform builds

`ffmpeg-static` installs the binary for **the machine running `npm install`**.
Building a Linux package on Windows therefore produces a package containing the
Windows FFmpeg binary, which will not run. macOS goes further and cannot be
targeted from another host at all.

Build each target on its own platform, or on the matching OS in CI. Both options
work:

```bash
# Option A — build on Ubuntu (or WSL2 / a Linux CI runner)
npm ci && npm run build:linux

# Option B — build the Linux package in Docker from any host
docker run --rm -v "$(pwd)":/project -w /project \
  electronuserland/builder:wine \
  /bin/bash -c "npm ci && npm run build:linux"
```

Alternatively, drop a Linux `ffmpeg` binary into [`ffmpeg/`](ffmpeg/README.md)
before packaging — it takes priority over `ffmpeg-static` at runtime.

---

## Settings reference

**Video**

| Setting | Options | Notes |
| --- | --- | --- |
| Resolution | Native, 720p, 1080p, 1440p, 4K | Applied at capture time so the GPU does the scaling |
| Frame rate | 24 / 30 / 60 fps | 60 is noticeably heavier at 1440p+ |
| Quality | Low / Balanced / High / Ultra | Drives CRF and the bitrate ceiling |
| Hardware acceleration | on / off | NVENC, QuickSync or AMF; falls back to CPU automatically |
| Capture cursor | on / off | |

**Audio** — microphone on/off, device and gain; system audio on/off, loopback
device and gain; optional microphone noise suppression.

**Storage** — recordings folder, filename pattern (`{date}`, `{time}`,
`{timestamp}`), and an option to keep the raw pre-conversion file.

`storage.outputFolder` is `null` by default, which means the app-managed folder
(`<userData>/Recordings`). Setting it sends *new* recordings elsewhere, and the
in-progress capture is staged in an `.incomplete` sub-folder beside it rather
than in `%TEMP%`. An unreachable folder — an unplugged drive, a dropped network
share — falls back to the default for that recording instead of failing it.

### The recordings catalog

`<userData>/recordings-index.json` is the library. It holds one entry per
recording — opaque id, absolute path, duration, dimensions, note — plus the list
of folders the app has written to. Listing merges that catalog with a scan of
those folders, so the list survives a folder change, a moved file, and the loss
of the index itself.

**Only recordings this app made are ever listed.** The proof is the
`library.json` sidecar written into whichever folder a recording is saved to: no
claim, no entry. Videos the user happens to keep in the same folder — `Downloads`
and `Desktop` are full of them — stay out of the library, and out of any move or
delete the app performs. The sidecar doubles as the backup the catalog is
rebuilt from.

The one exception is a single sweep of the app's own folder, which adopts
recordings made before sidecars existed. It is skipped entirely once that folder
has a sidecar of its own, and never runs twice.

Playback URLs carry a catalog id (`app-recording://media/<id>`), never a path.
That is the security boundary now that recordings can live anywhere: the
renderer can only reach a file the app itself catalogued.

Poster frames live in `<userData>/Thumbnails/<id>.jpg` rather than beside each
video, since recordings are no longer confined to one folder.

Settings are stored as JSON and written atomically:

- Windows — `%APPDATA%\screen-recorder\settings.json`
- macOS — `~/Library/Application Support/screen-recorder/settings.json`
- Linux — `~/.config/screen-recorder/settings.json`

Upgrading from schema v1 clears any `outputFolder` left over from the pre-library
builds, where the field meant "where to drop the MP4" rather than "this folder is
the library". Re-pick the folder once in Settings and it sticks.

---

## System audio: platform notes

### Windows

Works out of the box. Chromium exposes a desktop loopback stream, captured in
the same request as the video, so system audio is perfectly aligned with the
picture. Nothing to configure.

### macOS

macOS ships **no system-audio capture of any kind** — not for this app, not for
QuickTime, not for anything else. The only route is a virtual audio device, which
appears to the app as an ordinary input and is recorded like one.
[BlackHole](https://existential.audio/blackhole/) is the free, standard choice:

```bash
brew install blackhole-2ch
```

Then, so you can still hear what you are recording:

1. **Audio MIDI Setup → + → Create Multi-Output Device**
2. Tick both your speakers/headphones and **BlackHole 2ch**
3. Set that Multi-Output Device as the system output
4. In the app: **Settings → Audio → System audio source → BlackHole 2ch**

The app recognises BlackHole, Loopback, Soundflower and iShowU by name and
auto-selects the first one it finds, so step 4 is only needed when several are
installed.

Screen capture itself needs a one-time grant in **System Settings → Privacy &
Security → Screen Recording**, and macOS only applies it after the app is quit
and reopened. Until then a red banner on the Recorder page explains this and
links straight to the pane.

### Ubuntu Linux

Chromium has **no desktop loopback API on Linux**, so the app takes the standard
route instead: PulseAudio and PipeWire expose every output as a `.monitor`
*input* device, and the app records that.

The app auto-selects the first monitor device it finds. If your machine has
several outputs, pick the right one explicitly:

**Settings → Audio → System audio source → "Monitor of ..."**

To check what is available:

```bash
pactl list short sources | grep monitor
```

If nothing is listed, install the PulseAudio utilities and confirm your audio
stack is running:

```bash
sudo apt install pulseaudio-utils pavucontrol
```

While recording, `pavucontrol` → **Recording** tab lets you re-point the app's
capture stream at a different monitor source live.

### Wayland

Screen capture on Wayland goes through the desktop portal:

```bash
sudo apt install xdg-desktop-portal xdg-desktop-portal-gtk
```

The app enables Chromium's PipeWire capturer automatically.

**The compositor's own "Share Screen" dialog is unavoidable.** On Wayland no
application may read the screen directly, so GNOME asks for consent every time a
capture session is opened, and nothing on the app side can suppress that prompt.
What the app *can* control is how often a session is opened, so it opens exactly
one: the source picker is filled from the display list (`screen.getAllDisplays()`,
which never touches the portal), and the portal is asked only when **Start
Recording** is pressed. Opening the app, switching pages and choosing a screen
raise no prompt at all.

Because the compositor owns that dialog, the screen chosen there wins over the
one picked in the app — on a multi-monitor Wayland session, confirm the same
monitor in the prompt. On an Xorg session (selectable from the gear icon on the
Ubuntu login screen) none of this applies: sources are enumerated directly and
there is no prompt.

---

## Project structure

```
screen-recorder/
├── electron/
│   ├── main/
│   │   ├── index.ts                    # app lifecycle, single instance, shutdown
│   │   ├── window.ts                   # BrowserWindow, security, hide-to-tray
│   │   ├── ipc/register.ts             # every IPC handler, registered once
│   │   ├── lib/
│   │   │   ├── logger.ts               # rotating file logger
│   │   │   └── errors.ts               # AppError + IpcResult wrapper
│   │   └── services/
│   │       ├── settings-store.ts       # atomic JSON persistence + migration
│   │       ├── tray.ts                 # tray icon + transport menu
│   │       ├── sources.ts              # source enumeration + Wayland placeholders
│   │       ├── display-media.ts        # permissions + getDisplayMedia handler
│   │       ├── recording-session.ts    # session files, finalising, recovery
│   │       ├── transcoder.ts           # FFmpeg pipeline
│   │       ├── ffmpeg-locator.ts       # binary resolution + encoder probing
│   │       │
│   │       ├── auth.ts                 # sign-in through Nexus; tokens never leave here
│   │       ├── device.ts               # this installation's stable id
│   │       ├── calls.ts                # the schedule, assignment and the roster
│   │       ├── roster.ts               # asks the server to refresh the staff list
│   │       ├── call-notifier.ts        # asks the server to send due Slack reminders
│   │       ├── reminder-prefs.ts       # mirrors the warning times where the server reads them
│   │       ├── reminders.ts            # desktop and in-app warnings, missed calls
│   │       ├── google-accounts.ts      # OAuth, tokens encrypted to the keychain
│   │       ├── google-calendar.ts      # one window of each calendar, reconciled
│   │       ├── tracking-policy.ts      # what this machine has been told to record
│   │       ├── activity-tracker.ts     # active/idle stretches
│   │       ├── input-counter.ts        # counts, and nothing about what was typed
│   │       ├── screenshot-scheduler.ts # periodic capture to a local queue
│   │       ├── activity-upload.ts      # drains that queue to Supabase
│   │       └── activity-day.ts         # one person's day, for the admin panel
│   └── preload/index.ts                # the only renderer ↔ main bridge
│
├── shared/                             # imported by BOTH processes
│   ├── types.ts                        # domain types
│   ├── api.ts                          # window.api contract
│   ├── ipc.ts                          # channel names + error codes
│   └── presets.ts                      # resolutions, quality tiers, filenames
│
├── src/
│   ├── components/                     # StatusPanel, SourcePicker, AudioPanel…
│   │   └── ui/                         # Button, Card, Select, Toggle, Slider…
│   ├── pages/                          # RecorderPage, SettingsPage
│   ├── services/                       # capture, mixing, codec, controller,
│   │                                   # device tests, selection, ipc
│   ├── hooks/                          # useRecorder, useSources, useSettings…
│   ├── context/                        # SettingsProvider, ToastProvider
│   ├── utils/                          # formatting helpers
│   ├── App.tsx
│   └── main.tsx
│
├── supabase/
│   ├── migrations/                     # numbered, applied in order in the SQL editor
│   └── functions/
│       ├── login/                      # Nexus verify → account → session
│       ├── roster-sync/                # the staff list, once a day at most
│       └── notify-due/                 # Slack reminders that have come due
│
├── scripts/generate-icon.mjs           # procedural PNG app icon
├── ffmpeg/                             # optional FFmpeg override (see its README)
├── recordings/                         # optional local output folder
├── build/                              # generated icon
├── electron-builder.yml
├── electron.vite.config.ts
└── package.json
```

---

## Architecture

### Process model

```
┌─────────────────────────┐         ┌──────────────────────────┐
│      Main process       │         │        Renderer          │
│                         │         │                          │
│  desktopCapturer        │         │  React UI                │
│  settings store         │◄──IPC──►│  getUserMedia            │
│  session file streams   │         │  Web Audio mixer         │
│  FFmpeg pipeline        │         │  MediaRecorder           │
│  logging                │         │                          │
└─────────────────────────┘         └──────────────────────────┘
              ▲                                  ▲
              └────────── preload bridge ────────┘
                      contextIsolation: true
                      nodeIntegration: false
                      sandbox: true
```

### Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- `ipcRenderer` is never exposed; the preload forwards a fixed set of channels
  declared in `shared/ipc.ts`
- A strict CSP in `index.html`, with no remote origins permitted
- Navigation away from the bundle and all `window.open` calls are blocked
- Permission requests are answered explicitly — only media is granted

### Error handling

Every invoke handler is wrapped by `handled()`, which converts thrown `AppError`s
into a serialisable `IpcResult`:

```ts
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError }
```

Custom Error fields do not survive structured cloning, so error **codes** would
be lost if handlers simply threw. Results are unwrapped in
`src/services/ipc.ts`, which rethrows a typed `IpcError` the UI can act on —
that is how "install ffmpeg with apt" reaches the user instead of
"Error invoking remote method".

### Recording state

All pipeline state lives in `RecordingController`, a plain observable class
outside React, consumed through `useSyncExternalStore`. Media plumbing must
survive re-renders, and keeping it framework-free makes it testable on its own.

Audio meters deliberately bypass the snapshot and are polled with
`requestAnimationFrame`, so 20 Hz meter updates do not re-render the app.

---

## Performance notes

**Memory is flat.** MediaRecorder is given a 1-second timeslice and each chunk is
appended to the session file immediately. A three-hour recording uses the same
RAM as a three-second one. Stream backpressure is honoured, so a slow disk
cannot grow an unbounded write queue.

**Encoding is usually free.** The recorder prefers H.264 for the intermediate
capture. When it gets it, FFmpeg *stream-copies* the video into MP4 rather than
re-encoding: a 54-second 1080p recording finalises in under two seconds with no
generation loss. Only the Opus audio is converted, to AAC. Re-encoding happens
only if Chromium had no H.264 encoder, or you asked for a smaller resolution
than the capture.

**Capture-time scaling.** Resolution limits are passed to `getUserMedia`, so the
compositor downsamples on the GPU before frames reach the app — much cheaper
than an FFmpeg `scale` filter.

**Background throttling is disabled** on the window, so the timer and recorder
keep full rate while the app is minimised behind whatever you are recording.

---

## Troubleshooting

**"No FFmpeg binary was found"**
Check Settings → About for the resolved path. Reinstall, or set
`SCREEN_RECORDER_FFMPEG=/path/to/ffmpeg`. On Ubuntu, `sudo apt install ffmpeg`
is enough — it is picked up from `PATH`.

**System audio is silent on Ubuntu**
Expected until a monitor device is selected — see
[System audio: platform notes](#system-audio-platform-notes). Verify with
`pactl list short sources | grep monitor`.

**System audio is silent on macOS**
Expected until a virtual audio device is installed and selected — macOS has no
loopback of its own. See [System audio: platform notes](#system-audio-platform-notes).

**No sources listed on macOS, or the video is blank**
Screen Recording permission is missing. System Settings → Privacy & Security →
Screen Recording, switch Screen Recorder on, then **quit and reopen the app** —
macOS does not apply the grant to a running process. The banner on the Recorder
page opens that pane directly.

**Clicking the Dock icon on macOS does nothing**
Fixed in this build: closing the window hides the app to the menu bar, and the
Dock icon brings it back. The menu-bar icon's **Show App** does the same.

**No sources listed on Wayland**
Install `xdg-desktop-portal` and `xdg-desktop-portal-gtk`, then restart.

**Ubuntu asks "Share Screen" every time a recording starts**
Expected — see [Wayland](#wayland). The prompt belongs to GNOME, not to the app,
and appears once per recording (never when the app merely opens). `echo
$XDG_SESSION_TYPE` confirms which session is in use; an Xorg session skips it
entirely.

**The recording stopped by itself**
The captured window was closed, or the OS revoked the share. The app stops
cleanly and still converts what it captured.

**The microphone dropped out part-way through a recording**
Expected to self-heal: the app detects the lost track, keeps recording, retries
for about a minute and re-attaches the device when it returns. Only the audio
during the gap is missing. A banner reports the state while it is disconnected.

**A Bluetooth headset makes the recording hum or sound muffled**
Opening a Bluetooth microphone forces Windows to switch the headset from A2DP
(stereo, full bandwidth) to Hands-Free Profile (mono, 8–16 kHz). Everything the
headset plays degrades, and system-audio capture records that degraded output.
Turn **Record microphone** off, or use a different microphone from the headset
you are listening on, and the headset stays in A2DP.

**The app crashed mid-recording**
Relaunch. The unfinished capture appears at the top of the main screen with
**Recover** and **Discard** — the raw file is never deleted until the MP4 exists.

**Microphone or system audio missing from a recording**
Press **Test** next to the input on the Recorder page — it opens the device and
reports exactly what went wrong. The status note under the meters explains any
downgrade during a recording. Audio problems never abort a recording; the video
is always saved.

**"No microphone is connected" but there is a built-in one**
The built-in microphone may be disabled in Windows sound settings, or hidden
because a Bluetooth headset is connected and became the only enabled input.
Check Windows Settings → System → Sound → Input, and
Privacy & security → Microphone → "Let desktop apps access your microphone".
The app requests the microphone without sample-rate or channel constraints, so
mono and 16 kHz Bluetooth headset microphones work normally.

**Logs**
Settings → About → Logs, or:

- Windows — `%APPDATA%\screen-recorder\logs\main.log`
- macOS — `~/Library/Application Support/screen-recorder/logs/main.log`
- Linux — `~/.config/screen-recorder/logs/main.log`

Both processes write there; renderer entries are prefixed `renderer:`.

---

## Roadmap

### Known gaps

Things that work today but not in every case, listed because finding them in the
code is harder than reading them here.

- **Slack reminders need somebody's app open.** Any running copy triggers the
  pass, and the server hands each reminder to exactly one of them — but a quiet
  office is a quiet Slack. A scheduled function on the server would not depend on
  anybody being at their desk.
- **A departed person's token stays valid** until it expires. It carries no
  authority — every policy denies them — but it is not revoked, because nothing
  on this version of GoTrue revokes it. See [Accounts and Nexus](#accounts-and-nexus).
- **Every signed-in person can read the whole staff roster.** That follows
  directly from anybody being able to schedule a call for anybody. It is worth
  agreeing with Nexus rather than assuming.
- **The month view does not show who a call is for.** The day and week views do;
  the month grid has no room for a name.
- **The deep-link path is dead code.** Nothing can send a link to the placeholder
  address an account carries, so `screenrecorder://` handling has nothing left to
  handle.

### Recorder features

The architecture has explicit seams for these; `ExperimentalSettings` in
`shared/types.ts` already persists and typechecks their configuration.

- Webcam overlay (picture-in-picture) — composite via an offscreen canvas track
  before the mixer stage
- Cursor highlighting and click effects — same canvas compositing stage
- Video trimming — a second FFmpeg pass in `transcoder.ts`
- Live streaming — swap the file writer for an RTMP output in the same pipeline
- AI transcription — post-process the AAC track after finalisation
- Noise removal — an extra Web Audio node in `AudioMixer`

Multi-monitor selection is already implemented.

---

## Licence

MIT
