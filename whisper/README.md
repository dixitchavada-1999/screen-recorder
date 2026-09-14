# whisper.cpp binaries

This folder holds the speech-to-text engine. It is **not an override slot** like
`ffmpeg/` — nothing else supplies these files, so a packaged build without them
ships an app that cannot transcribe.

The contents are fetched, not committed. Ten megabytes of platform-specific DLLs
are a build input rather than source, and pinning them in git would mean a
commit every time upstream publishes a fix.

## Getting them

```
node scripts/fetch-whisper.mjs
```

`prebuild:win` runs this already, so `npm run build:win` and `npm run release:win`
need no extra step. Pass `--force` to replace what is here with the latest
release.

## What lands here

| File | Why |
| ---- | --- |
| `whisper-cli.exe` | The executable the app spawns |
| `whisper.dll` | The library behind it |
| `ggml.dll`, `ggml-base.dll` | The tensor runtime |
| `ggml-cpu-*.dll` | One per instruction set — ggml loads the right one for the machine at startup, so they all have to be present |

The release archive also carries a server, a benchmark, an SDL live-stream demo
and a set of test programs. None of those are copied; the app never spawns them.

## Which build

The plain CPU archive (`whisper-bin-x64.zip`), not the BLAS one. The BLAS build
adds about forty-nine megabytes, almost all of it `libopenblas.dll`, for a gain
that barely registers against ggml's own AVX2 and AVX-512 kernels. The CUDA
builds are larger again and do nothing without an NVIDIA card.

## Models

The weights are **not** here. They are downloaded on first use into
`userData/Models/` — see `electron/main/services/whisper-model.ts`. Bundling one
would add between sixty and five hundred megabytes to the installer for every
user, including those who never transcribe anything.
