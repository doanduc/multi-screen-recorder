# Multi Screen Recorder

Tauri 2 desktop screen recorder for Windows. Records up to 4 screens or windows
into a single video with an auto grid layout.

## Repository

This is a **public** GitHub repository: `doanduc/multi-screen-recorder`.
Everything committed here — file contents, images, and commit messages — is
visible to anyone.

## Commit messages

Do **not** add a `Claude-Session:` trailer or any other session URL, internal
identifier, or tooling metadata to commit messages. This repository is public
and such links do not belong in its history.

A `Co-Authored-By:` trailer is fine.

## Before committing

- Never commit `src-tauri/binaries/ffmpeg.exe`, `msix/binaries/`, or
  `msix/multi-screen-recorder.exe` — these are large build artifacts and are
  already ignored.
- Ad-hoc desktop screenshots (`Screenshot *.png`) are ignored; they can contain
  personal window content. Store listing assets (`store-*.png`) are intentional
  and tracked.
