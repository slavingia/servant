// One stylesheet for every page the server renders itself: the landing page, join, support, privacy, terms and the
// public page. It is the app's design system (docs/design-system.md) in CSS: the palette in light and dark with
// the workspace's color (theme.mjs pageColors), the type roles, 6 and 10 pixel corners, 48-point controls, the four
// buttons, and links that are always underlined. A page adds only its own layout after it.
import { pageColors } from "./theme.mjs";

const variables = colors => Object.entries(colors).map(([name, value]) => `--${name}:${value}`).join(";");

export function pageStyle(theme) {
  const color = theme && typeof theme === "object" ? theme.primaryColor : undefined;
  return `:root{color-scheme:light dark;${variables(pageColors("light", color))}}
@media (prefers-color-scheme:dark){:root{${variables(pageColors("dark", color))}}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{font:15px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--background);-webkit-text-size-adjust:100%}
body{margin:0}
h1{font-size:28px;line-height:34px;letter-spacing:-.5px;margin:0 0 16px}
h2{font-size:18px;line-height:24px;letter-spacing:-.15px;margin:32px 0 8px}
p{margin:0 0 16px}
ul{margin:0 0 16px;padding-left:24px}
p,li{overflow-wrap:anywhere}
li+li{margin-top:8px}
a{color:var(--blue);text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
button,input,textarea{font:inherit;color:inherit}
label,.label{display:block;font-size:13px;line-height:18px;font-weight:600;margin:0 0 4px}
.hint{font-size:13px;line-height:18px;color:var(--muted);margin:0 0 8px}
input[type=text],input[type=email],textarea{display:block;width:100%;min-height:48px;padding:12px 16px;border:1px solid var(--borderStrong);border-radius:10px;background:var(--background);font-size:16px;line-height:24px}
textarea{resize:vertical;overflow-wrap:anywhere}
::placeholder{color:var(--muted);opacity:1}
[aria-invalid=true]{border-color:var(--red)}
.button,.primary,.secondary,.danger{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 16px;border:1px solid transparent;border-radius:6px;font-size:15px;line-height:22px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.button,.primary{background:var(--primary);color:var(--onPrimary)}
.secondary{background:var(--background);border-color:var(--borderStrong);color:var(--ink)}
.danger{background:var(--background);border-color:var(--red);color:var(--red)}
.full{display:flex;width:100%}
button:disabled{cursor:default}
.primary:disabled{background:var(--line);color:var(--muted)}
.secondary:disabled,.danger:disabled{opacity:.5}
.muted{color:var(--muted)}
.small{font-size:13px;line-height:18px}
.notice{border-radius:10px;padding:12px 16px;margin:0 0 16px;background:var(--blueSoft)}
.success{background:var(--greenSoft);color:var(--greenDark)}
.error{background:var(--redSoft);color:var(--red)}
.error:empty{display:none}
.links{display:flex;flex-wrap:wrap;gap:0 24px}
.links a{display:inline-flex;align-items:center;min-height:44px;min-width:44px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}`;
}
