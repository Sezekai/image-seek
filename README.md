# Image Seek

Windows desktop app (Electron) for identifying images and finding higher-resolution versions.

- **Lookups** — add a folder as *Identify* or *Higher res*; each file runs through IQDB, SauceNAO, ascii2d and trace.moe. Booru posts are read for series / character / artist tags and full-size dimensions.
- **Browser** — tabs linked to a file; downloads and right-click → Save image go into that file's folder. History, built-in ad blocking or uBlock Origin Lite, Dark Reader dark mode, Chrome Web Store extensions ("I still don't care about cookies" preinstalled), Firefox cookie and password import, autofill.
- **Downloads** — every download and what it's linked to; unlink, relink, recycle or sort.
- **Compare** — original vs downloads side by side / stacked / grid with synced zoom, stats with the best highlighted; keep some, the rest go to the Recycle Bin, then sort the kept ones.
- **Sort log** — every move with undo (Ctrl+Z undoes the last one).

## Folders

Put `ImageSeek.exe` in a folder called `App` (e.g. `E:\Pictures\Image Seek\App`). Data lives next to it in `Data`, and downloads / sorted files default to `Downloads` and `Sorted` (both changeable in Settings). Replace the exe to update; nothing in `Data` needs copying.

## Build

GitHub Actions builds `ImageSeek.exe` on every push to `main` (see the run's Artifacts). Tag `v*` to attach it to a release. `npm test` runs the parser / import / sorting tests.
