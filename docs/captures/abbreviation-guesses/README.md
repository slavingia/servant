# Abbreviations nobody has defined: before and after

These are actual browser screenshots from running builds. They are not mockups or edited images.

- **Before:** `main` at `0896b83`.
- **After:** the branch at `defb31c`. Full hashes and checksums are in [manifest.json](manifest.json).
- **Desktop:** 1280 × 900. **Phone:** 390 × 844 with touch. Device scale 1, light appearance, English.
- Both sides ran their own server on a copy of the same made-up workspace. The same message was typed in #general on each: "The RFP is due on Friday" on the desktop, "The SOW is due on Friday" on the phone.
- **The agent is a stand-in.** The capture machine has no model, so a small local program answered with fixed text ("Request for proposal", "Statement of work"). The screens, the list and the to-do are the real app and server; the guesses are not a model's.

## Pressing Send

Before, Send stopped at a question and the message stayed in the box. After, the message is in the channel as written and nothing asks.

| Viewport | Before | After |
| --- | --- | --- |
| Desktop | ![Send stops at What is RFP? on main](before/send-desktop.png) | ![The message is sent on the branch](after/send-desktop.png) |
| Phone | ![Send stops at What is SOW? on main](before/send-phone.png) | ![The message is sent on the branch, on a phone](after/send-phone.png) |

## New: Agent's guess in the list, and the sender's to-do

None of these existed before.

| | Desktop | Phone |
| --- | --- | --- |
| Abbreviations: the guess, marked as one, with Edit, Keep and Delete | ![The guess on the desktop](after/guess-desktop.png) | ![The guess on a phone](after/guess-phone.png) |
| To-dos: the sender's to-do to check it | ![The to-do on the desktop](after/todo-desktop.png) | ![The to-do on a phone](after/todo-phone.png) |
| After Keep: an entry like any other. The to-do is done, and typing the abbreviation expands it | ![After Keep](after/kept-desktop.png) | |
