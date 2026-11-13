import { publicPage, contactLink } from "./public-page.mjs";
import { TERMS_VERSION } from "./terms.mjs";

export function termsPage({ contactEmail, footer, theme } = {}) {
  const contact = contactLink(contactEmail) || "the administrator of your team’s server";
  return publicPage("Servant Terms of Service", `
<h1>Terms of Service</h1>
<p>Version ${TERMS_VERSION} · Updated November 11, 2026</p>
<p>Servant is independent, open-source team messaging software. Each team runs its own server. Joining gives you access to that team's workspace; it does not create an account with a hosted Servant service.</p>
<h2>1. Use Servant responsibly</h2>
<p>Use Servant for work, follow your organisation's rules and applicable law, and keep your invite and device secure. Only join servers you have permission to access. Do not harass people, share unlawful content, or interfere with other people's access.</p>
<h2>2. Check the agent's work</h2>
<p>The agent can be wrong. Check what it tells you and does before you act on it. You are responsible for what you send or do with its help, including any actions you approve. Your team's chosen AI provider may process the information you give the agent.</p>
<h2>3. Keep sensitive information out</h2>
<p>Do not share personal, confidential or other sensitive information. Your team's server has not been reviewed for it. That includes anything you would not want a server administrator to read. Servant does not claim government approval or a security certification.</p>
<h2>Your content and your team's server</h2>
<p>Your messages, files and profile are stored on your team's server, whose administrators can access them. Your team controls membership, retention and access to its workspace, and may remove access. Only share content you have permission to share. See the <a href="/privacy">privacy policy</a> for how data is handled.</p>
<h2>Leaving and getting help</h2>
<p>You can stop using Servant and sign out at any time. Signing out removes a device's access, not your messages or account on the server. Ask your server administrator to delete your account or data, or contact ${contact} for help.</p>
<h2>Software and availability</h2>
<p>Servant's source code is available under <a href="https://github.com/slavingia/servant/blob/main/LICENSE">CC0</a>. The software is provided as is. Your team operates the server and is responsible for its availability and backups. These workspace commitments do not replace the software's open-source licence or any applicable app-store licence.</p>
<h2>Consent versions</h2>
<p>The server records the version you accepted, the three commitments, the date and your device. Version 2026-11-11 makes the workplace wording more general; it retains the work-use, agent-responsibility and sensitive-information commitments. Older app builds can still record their original 2026-11-03 acceptance.</p>
<details><summary>Original commitments — version 2026-11-03</summary>
<ul><li><strong>I agree to the Terms of Service and I'm using Servant for work.</strong> Use Servant only for official work, follow your agency's rules, and keep your invite and device secure.</li>
<li><strong>I'm responsible for how I use the agent.</strong> The agent can be wrong. I'll check what it tells me and does before I act on it, and I'm accountable for what I send or do with its help.</li>
<li><strong>I won't share personal, confidential or other sensitive information.</strong> Servant isn't approved for it yet. That includes anything I wouldn't be comfortable having reviewed.</li></ul></details>
<p>Questions about these terms: ${contact}.</p>`, footer, theme);
}
