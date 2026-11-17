// Shared by instance join pages and servant.com/join (scripts/build-join-page.mjs).
// Instances serve the invite form; the browser app lives at servant.com.
import { pageStyle } from "./page-style.mjs";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// What an invite link looks like, under the field: the same made-up example the app shows on Welcome (invite.ts).
export const INVITE_EXAMPLE = "https://servant.example.gov/join?code=ABCDE-FGH23";

export function joinPage(downloads = {}, webUrl = "https://servant.com", footer = "", theme) {
  const note = typeof footer === "string" ? footer.trim().slice(0, 300) : "";
  // Store links come from config.json "downloads" ({ mac, ios, android }); a missing one is not shown.
  const urls = { mac: "https://servant-mac.web.app", ...downloads };
  const store = (label, url, mac = false) => /^https:\/\//.test(url || "") ? `<a class="secondary full"${mac ? ' id="mac-download" hidden' : ""} href="${esc(url)}">${esc(label)}</a>` : "";
  const stores = store("Download for Mac", urls.mac, true) + store(/^https:\/\/apps\.apple\.com\//.test(urls.ios || "") ? "Download on the App Store" : "Download for iPhone (TestFlight)", urls.ios) + store("Download for Android", urls.android);
  const app = new URL("/pair", webUrl);
  if (app.protocol !== "https:") throw new Error("The Servant web app URL must use HTTPS");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Join Servant</title>
<style>${pageStyle(theme)}
main{max-width:472px;margin:0 auto;padding:24px 16px 48px}
textarea{min-height:104px;margin:0 0 12px}
.full{margin:0 0 12px}
nav{margin-top:12px}
.footer{margin-top:32px;font-size:13px;line-height:18px;color:var(--muted)}
</style></head><body><main>
<h1>Join Servant</h1>
<form id="join" action="${esc(app.href)}" method="get">
<label for="invite">Invite link</label><p id="invite-example" class="hint">Example: ${INVITE_EXAMPLE}</p><textarea id="invite" placeholder="Paste your invite link" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="invite-example error" required></textarea>
<p id="error" class="notice error" role="alert" hidden></p>
<button class="primary full" id="continue" type="submit" disabled>Continue in browser</button>
</form>
${stores}
<div id="app-actions" hidden><a class="secondary full" id="open" href="#">Open Servant app</a><button class="secondary full" id="copy" type="button">Copy invite link</button></div>
<nav class="links" aria-label="Help"><a href="/support">Support</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
<noscript><p>Enable JavaScript to continue with your invite.</p></noscript>${note ? `
<p class="footer">${esc(note)}</p>` : ""}
</main><script>
(function () {
  var form = document.getElementById("join"), input = document.getElementById("invite"), error = document.getElementById("error"), next = document.getElementById("continue"), actions = document.getElementById("app-actions"), open = document.getElementById("open"), copy = document.getElementById("copy");
  var q = new URLSearchParams(location.search);
  if (["code", "key", "d", "hub", "server"].some(function (k) { return q.has(k); })) {
    input.value = location.protocol === "https:" ? location.origin + "/join?" + q.toString() : "servant://pair?" + q.toString();
  }
  var mac = document.getElementById("mac-download");
  if (mac) mac.hidden = !(/Mac/i.test(navigator.platform || "") && !(navigator.maxTouchPoints > 1));

  // Accept the same web and app invite formats as the app's parseInvite.
  function invite() {
    var match = input.value.trim().match(/servant:\\/\\/pair\\?[^\\s]+/i) || input.value.trim().match(/https:\\/\\/[^\\s/?#]+\\/join\\?[^\\s]+/i);
    if (!match) return null;
    var p = new URLSearchParams(match[0].slice(match[0].indexOf("?") + 1));
    var code = p.get("code") || "", direct = p.get("server") || p.get("hub"), discovery = p.get("d"), key = p.get("key");
    if (!/^[0-9a-z]{5}-?[0-9a-z]{5}$/i.test(code) || (!direct && !discovery)) return null;
    if ((direct && !/^https?:\\/\\//.test(direct)) || (discovery && !/^https:\\/\\//.test(discovery))) return null;
    if (key && !/^(02|03)[0-9a-f]{64}$/.test(key)) return null;
    var clean = new URLSearchParams({ code: code.toUpperCase() });
    ["key", "d", "hub", "server"].forEach(function (k) { var v = p.get(k); if (v) clean.set(k, v); });
    return clean;
  }
  function update(showError) {
    var p = invite();
    next.disabled = !input.value.trim();
    actions.hidden = !p;
    error.hidden = !showError || !!p;
    error.textContent = error.hidden ? "" : "That invite link is incomplete or invalid. Paste the full link or ask for a new one.";
    input.setAttribute("aria-invalid", String(!error.hidden));
    copy.textContent = "Copy invite link";
    if (p) open.href = "servant://pair?" + p.toString();
    else open.removeAttribute("href");
    return p;
  }
  input.oninput = function () { update(false); };
  form.onsubmit = function (event) {
    event.preventDefault();
    var p = update(true);
    if (!p) { input.focus(); return; }
    var target = new URL(form.action);
    target.search = p.toString();
    location.href = target.href;
  };
  copy.onclick = function () {
    var p = invite();
    if (!p) return;
    var link = new URL("/join", form.action);
    link.search = p.toString();
    (navigator.clipboard ? navigator.clipboard.writeText(link.href) : Promise.reject()).then(function () { copy.textContent = "Copied"; }, function () { input.focus(); input.select(); });
  };
  update(!!input.value);
})();
</script></body></html>`;
}
