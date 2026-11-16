// Public pages share a small, script-free layout that works without the app, and the server's one stylesheet.
import { pageStyle } from "./page-style.mjs";
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function contactLink(value) {
  const email = typeof value === "string" ? value.trim() : "";
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)
    ? `<!--email_off--><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a><!--/email_off-->` : "";
}

export function publicPage(title, content, footer = "", theme) {
  const note = typeof footer === "string" ? footer.trim().slice(0, 300) : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title>
<style>${pageStyle(theme)}
header{background:var(--navy);padding:8px max(16px,calc((100% - 728px)/2))}
header a{display:inline-flex;align-items:center;min-height:44px;color:var(--onPrimary);font-size:22px;line-height:28px;font-weight:700;letter-spacing:-.3px;text-decoration:none}
main{max-width:760px;margin:0 auto;padding:24px 16px 32px}
.lede{font-size:18px;line-height:24px}
footer{max-width:760px;margin:0 auto;padding:16px 16px 32px;border-top:1px solid var(--line)}
details{margin:0 0 16px}
summary{cursor:pointer;font-weight:600;padding:11px 0}
</style>
</head><body><header><a href="/">Servant</a></header><main>${content}</main>
<footer><nav class="links" aria-label="Site"><a href="/">Home</a><a href="/join">Join</a><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="https://github.com/slavingia/servant">Source code</a></nav>${note ? `<p class="small muted">${escapeHtml(note)}</p>` : ""}</footer></body></html>`;
}

export const landingPage = ({ footer, theme } = {}) => publicPage("Servant — agents for public servants", `
<h1>Agents for public servants.</h1>
<p class="lede">An agent your team can ask, with chat and calls, on a server your team runs.</p>
<p>Servant gives public servants an agent they can ask for help, alongside channels, direct messages, files and calls. Your team runs the server and decides who can join.</p>
<p><a class="button" href="/join">Join your team</a></p>
<h2>Start with an invite</h2>
<p>Ask your team for a Servant invite link. Install the app using the download link your team provides, then open your invite. You can also paste it into the app after choosing <strong>I'm new here</strong>.</p>
<h2>Run it yourself</h2>
<p>Servant is free, open-source software under CC0. A team needs to run a Servant server on a Mac or Linux computer and send invitations. See the <a href="https://github.com/slavingia/servant#quickstart">setup guide</a>.</p>
<p>Servant is an independent open-source project and is not affiliated with any government agency.</p>
<p>Need help joining, using the app or deleting your data? <a href="/support">Get support</a>.</p>`, footer, theme);

export function supportPage({ contactEmail, footer, theme } = {}) {
  const contact = contactLink(contactEmail);
  return publicPage("Servant support", `
<h1>Servant support</h1>
<p>For help with the app, accessibility, or a bug, ${contact ? `email ${contact}` : "ask the administrator of your team’s server"}. Include your device, app version and what happened. Do not include passwords, invite links or private messages.</p>
<h2>Joining your team</h2>
<p>Your team runs its own server and sends you an invite. Open Servant, choose <strong>I'm new here</strong>, paste the invite link and tap <strong>Continue</strong>. Read the terms, check the three boxes, tap <strong>Agree and join</strong>, then enter your name.</p>
<p>If your name is already taken, add an initial. If you already belong to this team, link your new device from <strong>You → Link a computer</strong> on a device where you are signed in.</p>
<h2>Server access</h2>
<p>Ask your team's server administrator about invitations, membership, server availability and access to team content.</p>
<h2>Deleting your account or data</h2>
<p>Contact the administrator of the server you joined to request deletion of your account and data. ${contact ? `If you cannot reach them or need help identifying the administrator, email ${contact}.` : "If you cannot reach the administrator, ask the person who invited you for their contact details."} Signing out removes that device's access; it does not delete your server account or messages.</p>
<p>Read the <a href="/privacy">privacy policy</a> and <a href="/terms">Terms of Service</a>.</p>`, footer, theme);
}
