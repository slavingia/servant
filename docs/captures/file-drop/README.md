# File drop captures

Synthetic data (Pat Tester on "Example server"; a temporary folder stands in for the Desktop), made with
`SERVANT_CAPTURE_BROWSER=chrome node scripts/file-drop-pr-captures.mjs <dir>` with `SERVANT_FILE_DROP_DIR` set by the script.

- `before/`: `main` at `6e3e831`. There was no File drop: the sidebar (1280×800) and You (390×844) as they were.
- `after/`: this change. `desktop.png` and `phone.png` are the screen, `*-over.png` a file dragged over the window,
  `*-saved.png` two files saved. The phone pass drops the same two names again, so they are saved beside the first two.

The script also checks the files are in the folder, whole.
