// Public privacy policy page (served at /privacy) for the app stores and anyone who asks.
// Plain facts about what Servant stores and where it goes. Keep it in step with the code.
export const PRIVACY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Servant privacy policy</title>
<style>body{font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#1b1b1b}h1{font-size:28px}h2{font-size:19px;margin-top:28px}a{color:#0071BC}</style>
</head><body>
<h1>Servant privacy policy</h1>
<p>Last updated November 6, 2026</p>
<p>Servant is a messaging app for teams: channels, direct messages, calls, files and an agent. Each team runs its own Servant server. You can only join a server with an invite from that team.</p>

<h2>What the server stores</h2>
<ul>
<li>Your name and, if your team turns it on, your work email address</li>
<li>Your profile photo, if you add one</li>
<li>Messages, files, call and meeting notes, and conversations with the agent</li>
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
<li>Firebase Crashlytics (Google) receives crash reports so we can fix bugs. They contain device and app details, not your messages.</li>
<li>Cloudflare carries traffic between the app and the server. The traffic is encrypted.</li>
<li>The agent runs on your team's server and may send what you ask it to an AI model provider your team chose.</li>
</ul>

<h2>Camera and microphone</h2>
<p>Servant uses the camera to scan invite codes and for video in calls, and the microphone for calls and recordings you start. It doesn't use them in the background.</p>

<h2>Leaving and deleting your data</h2>
<p>Signing out removes the device. To delete your account and data, ask the person who runs your team's server, or email <a href="mailto:sahil.lavingia@gmail.com">sahil.lavingia@gmail.com</a>.</p>

<h2>Children</h2>
<p>Servant is for work teams and isn't meant for children under 13.</p>

<h2>Contact</h2>
<p>Questions: <a href="mailto:sahil.lavingia@gmail.com">sahil.lavingia@gmail.com</a></p>
</body></html>`;
