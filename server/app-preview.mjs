// App previews: a project's app, exported for the web (`expo export --platform web`), served by this server at
// /a/<project id>/ so a team can use it in the browser, change words and styles right on the screen, and right-click
// anything to ask the agent about it (docs/app-preview.md). The export lives in <data>/app-previews/<project id>/
// and must be built with that base path (scripts/app-preview-export.sh does both).
//
// Like prototypes (prototypes.mjs), pages run in a sandbox with no access to this server's origin, so the app
// can't reach the API or anyone's session. A sandboxed page has no storage of its own, so a small shim gives it
// in-memory localStorage, sessionStorage and cookies before the app's scripts run. A second script is the bridge:
// it talks only to the Servant screen around it (postMessage, or ReactNativeWebView on phones), never to the server.
import fs from "node:fs";
import path from "node:path";
import { mimeFor } from "./ota.mjs";

export const PREVIEW_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", txt: "text/plain; charset=utf-8", ico: "image/x-icon", wasm: "application/wasm" };
const typeFor = file => { const ext = path.extname(file).slice(1).toLowerCase(); return TYPES[ext] || mimeFor(ext); };
const MAX_FILE = 40 * 1024 * 1024;

// An app is a few hundred requests on first load (scripts, fonts, images), so allow plenty per visitor.
const LIMIT = 3000, WINDOW = 60_000;
const hits = new Map();
function allowed(ip, at = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (at - v.start > WINDOW) hits.delete(k);
  const h = hits.get(ip);
  if (!h || at - h.start > WINDOW) { hits.set(ip, { start: at, n: 1 }); return true; }
  return ++h.n <= LIMIT;
}
export const _resetPreviewLimits = () => hits.clear();

/** The folder a project's preview is served from, or null when it has none yet. */
export function previewRoot(dir, projectId) {
  if (!PREVIEW_ID.test(projectId || "")) return null;
  const root = path.join(dir, projectId);
  try { return fs.statSync(path.join(root, "index.html")).isFile() ? root : null; } catch { return null; }
}

/** What the app needs to show a project's preview: its path on this server and when it was built. */
export function previewInfo(dir, projectId) {
  const root = previewRoot(dir, projectId);
  if (!root) return null;
  let builtAt = null, commit = null;
  try { const d = JSON.parse(fs.readFileSync(path.join(root, "deployment-environment.json"), "utf8")); builtAt = d.builtAt || null; commit = d.commit ? String(d.commit).slice(0, 9) : null; } catch { /* not every export has it */ }
  if (!builtAt) try { builtAt = fs.statSync(path.join(root, "index.html")).mtime.toISOString(); } catch { /* gone */ }
  return { path: `/a/${projectId}/`, builtAt, commit };
}

// Runs before anything else on the page: storage a sandboxed page is otherwise refused.
const SHIM = `<script data-servant-shim>(function(){function S(){var m=new Map();return{get length(){return m.size},key:function(i){return Array.from(m.keys())[i]||null},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:S(),configurable:true})}catch(x){}}});
try{document.cookie}catch(e){var jar={};try{Object.defineProperty(document,"cookie",{configurable:true,get:function(){return Object.keys(jar).map(function(k){return k+"="+jar[k]}).join("; ")},set:function(v){var p=String(v).split(";")[0],i=p.indexOf("=");if(i>0)jar[p.slice(0,i).trim()]=p.slice(i+1).trim()}})}catch(x){}}})()</script>`;

// The bridge. Three modes, set by the screen around it:
//   use      the app as normal; right-click (or press and hold) still opens a comment there
//   comment  any click opens a comment where it landed
//   edit     click words to change them; a small bar makes them bigger, smaller, spaced or recolored
// It reports where a comment goes ("at"), every change made in edit mode ("edits"), and the page it is on ("page").
export const BRIDGE = `<script data-servant-bridge>(function(){if(window.__servantBridge)return;window.__servantBridge=1;
var BASE=document.currentScript&&document.currentScript.getAttribute("data-base")||"";
var mode="use",sel=null,orig=new Map(),styled=new Map(),hold=null,start=null;
function page(){var p=location.pathname;if(BASE&&p.indexOf(BASE)===0)p=p.slice(BASE.length)||"/";return p+location.search}
function post(m){m.servant="app-preview";m.page=page();var s=JSON.stringify(m);try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(s);else if(parent!==window)parent.postMessage(s,"*")}catch(x){}}
function clean(t){return String(t||"").replace(/\\s+/g," ").trim()}
function words(n){while(n&&n.nodeType===1&&n!==document.documentElement){var t=clean(n.getAttribute("aria-label")||n.getAttribute("alt")||n.textContent);if(t)return t.slice(0,160);n=n.parentElement}return ""}
function role(n){while(n&&n.nodeType===1&&n!==document.body){var r=n.getAttribute("role")||({A:"link",BUTTON:"button",INPUT:"text field",H1:"heading",H2:"heading",H3:"heading",IMG:"image"})[n.tagName];if(r)return r;n=n.parentElement}return ""}
function mine(e){return bar&&e.composedPath&&e.composedPath().indexOf(bar)>=0}
function textEl(n){while(n&&n.nodeType===1&&n!==document.body){if([].some.call(n.childNodes,function(c){return c.nodeType===3&&c.textContent.trim()}))return n;n=n.parentElement}return null}
var css=document.createElement("style");css.setAttribute("data-servant-bridge","");
css.textContent="html[data-sp=comment] *{cursor:crosshair!important}html[data-sp=edit] [data-sp-hover]{outline:1px dashed #2672de!important;outline-offset:2px;cursor:text!important}[data-sp-sel]{outline:2px solid #2672de!important;outline-offset:2px}";
(document.head||document.documentElement).appendChild(css);
var bar=document.createElement("div");bar.setAttribute("data-servant-bridge","");bar.style.cssText="position:fixed;z-index:2147483647;display:none";
var root=bar.attachShadow({mode:"open"});
root.innerHTML='<style>*{box-sizing:border-box;font:600 13px -apple-system,system-ui,sans-serif}.b{display:flex;flex-wrap:nowrap;gap:4px;padding:4px;background:#1b1b1b;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3)}button{white-space:nowrap;min-width:32px;height:32px;padding:0 6px;border:1px solid #565c65;border-radius:6px;background:#2d2e2f;color:#fff;cursor:pointer}.sw{width:24px;min-width:24px;height:24px;margin:4px 2px;padding:0;border-radius:12px;border:2px solid #fff}</style><div class="b"><button data-a="smaller" aria-label="Smaller text">A-</button><button data-a="bigger" aria-label="Bigger text">A+</button><button data-a="tighter" aria-label="Less space">\u2195\u2212</button><button data-a="looser" aria-label="More space">\u2195+</button><button class="sw" data-c="#1b1b1b" aria-label="Black text" style="background:#1b1b1b"></button><button class="sw" data-c="#005ea2" aria-label="Blue text" style="background:#005ea2"></button><button class="sw" data-c="#d83933" aria-label="Red text" style="background:#d83933"></button></div>';
function attach(){if(document.body&&!bar.isConnected)document.body.appendChild(bar)}
function place(){if(!sel||mode!=="edit"){bar.style.display="none";return}attach();var r=sel.getBoundingClientRect();bar.style.display="block";var bw=bar.offsetWidth||260,top=r.top-46;if(top<4)top=r.bottom+6;bar.style.top=Math.max(4,Math.min(innerHeight-44,top))+"px";bar.style.left=Math.max(4,Math.min(innerWidth-bw-4,r.left+r.width/2-bw/2))+"px"}
function report(){var edits=[],styles=[];orig.forEach(function(o,el){var now=clean(el.textContent);if(now!==o.text)edits.push({from:o.text,to:now,role:o.role})});
styled.forEach(function(s,el){var c={};Object.keys(s.before).forEach(function(k){var v=el.style[k];if(v&&v!==s.before[k])c[k.replace(/[A-Z]/g,function(x){return "-"+x.toLowerCase()})]={from:s.before[k],to:v}});if(Object.keys(c).length)styles.push({words:clean(el.textContent).slice(0,160)||s.words,role:s.role,css:c})});
post({type:"edits",edits:edits,styles:styles})}
function select(el){if(sel&&sel!==el){sel.removeAttribute("data-sp-sel");sel.removeAttribute("contenteditable")}sel=el;if(!el){place();return}
if(!orig.has(el))orig.set(el,{text:clean(el.textContent),role:role(el)});el.setAttribute("data-sp-sel","");el.setAttribute("contenteditable","plaintext-only");if(el.contentEditable!=="plaintext-only")el.setAttribute("contenteditable","true");
el.focus();try{el.scrollIntoView({block:"center",inline:"nearest"})}catch(x){}try{var r=document.createRange();r.selectNodeContents(el);r.collapse(false);var g=getSelection();g.removeAllRanges();g.addRange(r)}catch(x){}place()}
function px(el,p){return parseFloat(getComputedStyle(el)[p])||0}
function tweak(f){if(!sel)return;var cs=getComputedStyle(sel);if(!styled.has(sel))styled.set(sel,{words:words(sel),role:role(sel),before:{fontSize:cs.fontSize,marginTop:cs.marginTop,marginBottom:cs.marginBottom,color:cs.color}});f(sel);place();report()}
root.addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;e.preventDefault();var c=b.getAttribute("data-c"),a=b.getAttribute("data-a");
if(c)return tweak(function(el){el.style.color=c});
if(a==="smaller"||a==="bigger")return tweak(function(el){el.style.fontSize=Math.max(8,px(el,"fontSize")+(a==="bigger"?2:-2))+"px"});
if(a==="tighter"||a==="looser")tweak(function(el){var d=a==="looser"?4:-4;el.style.marginTop=Math.max(0,px(el,"marginTop")+d)+"px";el.style.marginBottom=Math.max(0,px(el,"marginBottom")+d)+"px"})});
function at(e,p){var t=e.target;post({type:"at",x:p.clientX,y:p.clientY,w:innerWidth,h:innerHeight,anchor:words(t),role:role(t)})}
function block(e){if(mode==="use"||mine(e))return false;e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();return true}
document.addEventListener("contextmenu",function(e){if(mine(e))return;e.preventDefault();e.stopPropagation();at(e,e)},true);
["pointerdown","mousedown","pointerup","mouseup","touchend"].forEach(function(n){document.addEventListener(n,function(e){if(mode==="edit"&&e.target===sel)return;block(e)},true)});
document.addEventListener("click",function(e){if(mode==="edit"&&e.target===sel)return;if(!block(e))return;if(mode==="comment")at(e,e);else if(mode==="edit")select(textEl(e.target))},true);
document.addEventListener("mouseover",function(e){if(mode!=="edit"||mine(e))return;var t=textEl(e.target);[].forEach.call(document.querySelectorAll("[data-sp-hover]"),function(n){if(n!==t)n.removeAttribute("data-sp-hover")});if(t)t.setAttribute("data-sp-hover","")},true);
document.addEventListener("keydown",function(e){if(mode!=="edit"||mine(e))return;if(e.target===sel){e.stopPropagation();if(e.key==="Enter"||e.key==="Escape"){e.preventDefault();select(null)}
else if(e.key===" "){e.preventDefault();if(!document.execCommand("insertText",false," ")){var g=getSelection();if(g.rangeCount){var r=g.getRangeAt(0);r.deleteContents();r.insertNode(document.createTextNode(" "));r.collapse(false)}}report()}}},true);
document.addEventListener("keyup",function(e){if(mode==="edit"&&e.target===sel&&e.key===" "){e.preventDefault();e.stopPropagation()}},true);
document.addEventListener("input",function(e){if(mode==="edit"&&e.target===sel)report()},true);
addEventListener("scroll",place,true);addEventListener("resize",function(){if(sel)try{sel.scrollIntoView({block:"nearest"})}catch(x){}place()});
document.addEventListener("touchstart",function(e){if(e.touches.length!==1)return;var t=e.touches[0];start={x:t.clientX,y:t.clientY};hold=setTimeout(function(){hold=null;at(e,t)},600)},{passive:true,capture:true});
function drop(){if(hold){clearTimeout(hold);hold=null}}
document.addEventListener("touchcancel",drop,true);document.addEventListener("touchend",drop,true);
document.addEventListener("touchmove",function(e){var t=e.touches[0];if(start&&t&&(Math.abs(t.clientX-start.x)>10||Math.abs(t.clientY-start.y)>10))drop()},{passive:true,capture:true});
function setMode(m){mode=m==="comment"||m==="edit"?m:"use";document.documentElement.setAttribute("data-sp",mode);if(mode!=="edit"){select(null);[].forEach.call(document.querySelectorAll("[data-sp-hover]"),function(n){n.removeAttribute("data-sp-hover")})}}
window.__servantMode=setMode;
addEventListener("message",function(e){var d=e.data;try{d=typeof d==="string"?JSON.parse(d):d}catch(x){return}if(d&&d.servant==="app-preview-mode")setMode(d.mode)});
var last="";function moved(){var p=page();if(p!==last){last=p;select(null);orig=new Map();styled=new Map();post({type:"page"})}}
["pushState","replaceState"].forEach(function(k){var f=history[k];history[k]=function(){var r=f.apply(this,arguments);setTimeout(moved,0);return r}});
addEventListener("popstate",moved);
function ready(){attach();moved();post({type:"ready"})}
if(document.readyState==="loading")addEventListener("DOMContentLoaded",ready);else ready();
})()</script>`;

const send = (req, res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(req.method === "HEAD" ? undefined : body); return true; };

/** Serve GET/HEAD /a/<project id>/<file…>. Returns false when the URL isn't ours. */
export function serveAppPreview(req, res, url, { dir, ip = "" }) {
  if (!url.pathname.startsWith("/a/")) return false;
  if (!allowed(ip)) return send(req, res, 429, "Too many requests. Try again in a minute.", { "Retry-After": "60" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  let parts;
  try { parts = url.pathname.slice(3).split("/").map(decodeURIComponent); } catch { return send(req, res, 404, "Not found"); }
  const [pid, ...rest] = parts;
  const root = previewRoot(dir, pid);
  if (!root) return send(req, res, 404, "This project has no app preview yet");
  if (rest.length === 0) { res.writeHead(301, { Location: `/a/${pid}/${url.search}`, "Cache-Control": "no-store" }); res.end(); return true; }
  if (rest.some(p => p === ".." || p.includes("\0") || p.startsWith("."))) return send(req, res, 404, "Not found");
  const rel = rest.filter(Boolean).join("/");
  // Expo's static export writes /notices as notices.html or notices/index.html; anything else is its not-found page.
  const tries = rel ? [rel, `${rel}.html`, `${rel}/index.html`] : ["index.html"];
  const base = fs.realpathSync(root);
  let real = null;
  for (const t of tries) {
    try { const r = fs.realpathSync(path.join(root, t)); if (r.startsWith(base + path.sep) && fs.statSync(r).isFile()) { real = r; break; } } catch { /* next */ }
  }
  let status = 200;
  if (!real) {
    if (/\.[a-z0-9]{1,8}$/i.test(rel) && !/\.html?$/i.test(rel)) return send(req, res, 404, "Not found");
    try { real = fs.realpathSync(path.join(root, "+not-found.html")); status = 404; } catch { return send(req, res, 404, "Not found"); }
  }
  if (fs.statSync(real).size > MAX_FILE) return send(req, res, 413, "File too large");
  let body = fs.readFileSync(real);
  const html = /\.html?$/i.test(real);
  if (html) {
    const text = body.toString("utf8");
    const bridge = BRIDGE.replace("<script data-servant-bridge>", `<script data-servant-bridge data-base="/a/${pid}">`);
    const withShim = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, m => m + SHIM) : SHIM + text;
    body = Buffer.from(/<\/body>/i.test(withShim) ? withShim.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${bridge}</body>`) : withShim + bridge);
  }
  // Built files carry a content hash in their name, so they can be kept; pages are always fetched fresh.
  const hashed = /\/_expo\/static\//.test(url.pathname) || /-[0-9a-f]{16,}\.[a-z0-9]+$/i.test(real);
  return send(req, res, status, body, {
    "Content-Type": typeFor(real),
    "Content-Length": String(body.length),
    "Cache-Control": html ? "no-store" : hashed ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    ...(html ? { "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals; base-uri 'self'; form-action 'self'" } : {}),
  });
}
