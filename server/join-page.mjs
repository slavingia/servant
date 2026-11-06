// The invite web page (servant.com/join and <server>/join). One self-contained HTML string: it opens Servant by
// itself with the invite filled in, offers copy-the-link, and shows download buttons for people without the app.
// scripts/build-join-page.mjs writes the same page to app/public/join/index.html for servant.com.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function joinPage(downloads = {}) {
  const store = (label, url) => /^https:\/\//.test(url || "") ? `<a class="s" href="${esc(url)}">${esc(label)}</a>` : "";
  const stores = store("Download for iPhone (TestFlight)", downloads.ios) + store("Download for Android", downloads.android);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join Servant</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;background:#0b0f1a;color:#fff;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:420px;width:100%;padding:32px;box-sizing:border-box;text-align:center}h1{font-size:28px;margin:0 0 8px}h2{font-size:15px;color:#8791aa;font-weight:600;margin:28px 0 4px}p{color:#b8c0d4;line-height:1.45}a.b,a.s,button{display:block;width:100%;box-sizing:border-box;margin:12px 0;padding:14px;border:0;border-radius:12px;font:600 17px -apple-system,system-ui,sans-serif;text-decoration:none;cursor:pointer}a.b{background:#3b82f6;color:#fff}a.s,button{background:#1c2438;color:#fff}small{color:#8791aa}</style></head><body><main>
<h1>Join Servant</h1><p id="msg">Opening Servant…</p>
<a class="b" id="open" href="#">Open Servant</a><button id="copy">Copy invite link</button>
${stores ? `<h2>Don't have the app yet?</h2>${stores}<p><small>Install it, then come back to this page and tap Open Servant.</small></p>` : ""}
<p><small>On a computer, copy the invite link and paste it into Servant: Paste an invite link.</small></p></main>
<script>
(function(){var q=new URLSearchParams(location.search),code=q.get("code")||"";
if(!/^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$/.test(code)){document.getElementById("msg").textContent="That invite link isn't complete. Ask for a new one.";document.getElementById("open").style.display=document.getElementById("copy").style.display="none";return}
var p=new URLSearchParams();p.set("code",code);["key","d","hub","server"].forEach(function(k){var v=q.get(k);if(v)p.set(k,v)});
var link="servant://pair?"+p.toString();document.getElementById("open").href=link;
document.getElementById("copy").onclick=function(){var b=this;(navigator.clipboard?navigator.clipboard.writeText(link):Promise.reject()).then(function(){b.textContent="Copied"},function(){window.prompt("Copy this link",link)})};
setTimeout(function(){location.href=link;document.getElementById("msg").textContent="If Servant didn't open, tap Open Servant."},300)})();
</script></body></html>`;
}
