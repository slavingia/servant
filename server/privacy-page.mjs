// Public privacy policy page (served at /privacy) for the app stores and anyone who asks.
// Plain facts about what Servant stores and where it goes. Keep it in step with the code.
// The footer is config.json's optional footer text (for example who runs this server). The contact address is config.json's optional contactEmail; without one the page
// points people at whoever runs their team's server and shows no address.
import { contactLink } from "./public-page.mjs";
import { pageStyle } from "./page-style.mjs";
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const validEmail = (v) => typeof v === "string" && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v.trim()) ? v.trim() : "";

export function privacyPage({ contactEmail, footer, theme } = {}) {
  const note = typeof footer === "string" ? footer.trim().slice(0, 300) : "";
  const email = validEmail(contactEmail);
  const link = contactLink(email);
  const deleting = email
    ? `To delete your account and data, ask the person who runs your team's server, or email ${link}.`
    : "To delete your account and data, ask the person who runs your team's server.";
  const contact = email ? `Questions: ${link}` : "Questions: ask the person who runs your team's server.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Servant privacy policy</title>
<style>${pageStyle(theme)}
body{max-width:712px;margin:0 auto;padding:24px 16px 48px}
.footer{margin-top:32px}
</style>
</head><body>
<h1>Servant privacy policy</h1>
<p>Last updated November 11, 2026</p>
<p>Servant is a messaging app for teams: channels, direct messages, voice memos, files and an agent. Each team runs its own Servant server. You can only join a server with an invite from that team.</p>

<h2>What the server stores</h2>
<ul>
<li>Your name and, if your team turns it on, your work email address</li>
<li>Your profile photo, if you add one</li>
<li>Messages, files, voice memo notes, and conversations with the agent</li>
<li>Your devices: a name like "iPhone", when they were last used, and a hashed sign-in token</li>
<li>When you agreed to the terms</li>
<li>How much each person uses the agent, so the team can see usage</li>
</ul>
<p>This data stays on your team's server. The people who run that server can see it. Servant doesn't sell data or show ads.</p>

<h2>Encryption</h2>
<p>The app encrypts traffic to your team's server with a key it checks against your invite. Messages are readable on that server so it can deliver them and so the agent can help.</p>

<h2>Other services</h2>
<ul>
<li>Apple and Google deliver notifications. A notification can include the sender and a preview of the message, depending on your settings.</li>
<li>Builds configured with Firebase Crashlytics send device and app crash reports to Google to help fix bugs. Builds without Firebase configuration send no Crashlytics reports. Crash reports do not include your messages.</li>
<li>Cloudflare carries traffic between the app and the server. The traffic is encrypted.</li>
<li>The agent runs on your team's server and may send what you ask it to an AI model provider your team chose.</li>
</ul>

<h2>Camera and microphone</h2>
<p>Servant uses the camera to scan invite codes, and the microphone for dictation and recordings you start. It doesn't use them in the background.</p>

<h2>Leaving and deleting your data</h2>
<p>Signing out removes that device's access; it does not delete your account or messages on the server. ${deleting}</p>

<h2>Children</h2>
<p>Servant is for work teams and isn't meant for children under 13.</p>

<h2>Contact</h2>
<p>${contact}</p>
${note ? `<p class="footer small muted">${escapeHtml(note)}</p>\n` : ""}</body></html>`;
}
