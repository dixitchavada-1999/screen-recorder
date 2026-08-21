# Custom FFmpeg binary (optional)

This folder is an **override slot**. It is empty by default, and the application
works without it — `ffmpeg-static` supplies a binary for the current platform and
`electron-builder` unpacks it next to the app.

Drop a binary here only when you need a specific build:

| Platform | File to place here |
| -------- | ------------------ |
| Windows  | `ffmpeg.exe`       |
| Linux    | `ffmpeg`           |

Reasons you might:

- You need a build with encoders `ffmpeg-static` omits (VAAPI, AV1, NVENC variants).
- Your organisation requires a signed or audited binary.
- You are producing a Linux package on a Windows machine and want to ship the
  Linux binary explicitly (see "Cross-platform builds" in the root README).

## Resolution order

`electron/main/services/ffmpeg-locator.ts` picks the first binary that exists
and is executable:

1. `SCREEN_RECORDER_FFMPEG` environment variable
2. **This folder** (`resources/ffmpeg/` in a packaged app)
3. The bundled `ffmpeg-static` binary
4. `ffmpeg` on the system `PATH`

On Linux, remember to make the binary executable before packaging:

```bash
chmod +x ffmpeg/ffmpeg
```

The resolved path is shown in **Settings → About** at runtime.
