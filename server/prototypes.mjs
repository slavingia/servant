// Prototyping: each chat's prototype is plain files in <data>/prototypes/<folder>/, served by this server at
// /p/<folder>/ (through the same tunnel as everything else). No git, no GitHub Pages. The design kit
// (components/ and assets/ of the prototypes project's checkout, config.json prototypesProject) is served beside it at /p/components/ and
// /p/assets/, so the starter page's `../components/components.css` links work unchanged.
// Folder names are random and unguessable: anyone with the link can view the page, nobody can list them.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mimeFor } from "./ota.mjs";

export const FOLDER = /^[a-z0-9][a-z0-9-]{2,40}$/;
const KIT = new Set(["components", "assets"]);
const TYPES = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json", svg: "image/svg+xml", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", ico: "image/x-icon", pdf: "application/pdf", csv: "text/csv; charset=utf-8" };
const typeFor = file => { const ext = path.extname(file).slice(1).toLowerCase(); return TYPES[ext] || mimeFor(ext); };

// A page and its pictures and scripts come to maybe 50 requests, so 600 a minute per visitor never gets in the way
// of a person (or a few people behind one office address) but stops someone hammering the link or guessing folders.
const LIMIT = 600, WINDOW = 60_000, MAX_FILE = 25 * 1024 * 1024;
const hits = new Map();
function allowed(ip, at = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (at - v.start > WINDOW) hits.delete(k);
  const h = hits.get(ip);
  if (!h || at - h.start > WINDOW) { hits.set(ip, { start: at, n: 1 }); return true; }
  return ++h.n <= LIMIT;
}
export const _resetLimits = () => hits.clear();

/** Delete a chat's prototype files (when the chat is deleted). Only ever touches a folder directly inside `dir`. */
export function removePrototype(dir, folder, { keep = false } = {}) {
  if (!FOLDER.test(folder || "")) return;
  const from = path.join(dir, folder);
  try {
    // Records preservation: move the files aside so the public /p/<folder>/ link stops working but nothing is destroyed.
    // FOLDER names cannot start with a dot, so `.removed` is never routable.
    if (keep && fs.existsSync(from)) {
      const holding = path.join(dir, ".removed", String(Date.now()));
      fs.mkdirSync(holding, { recursive: true, mode: 0o700 });
      fs.renameSync(from, path.join(holding, folder));
      return;
    }
    fs.rmSync(from, { recursive: true, force: true });
  } catch { /* already gone */ }
}

// Live reload (HMR). Every HTML page we serve gets a tiny script that listens to <folder>/__hmr (server-sent events).
// While someone is watching a folder we scan it twice a second; when a file changes the page swaps changed
// stylesheets in place and reloads for anything else, keeping the scroll position. Nothing runs for folders nobody
// has open.
const CLIENT = `<script data-servant-hmr>(function(){try{var es=new EventSource("__hmr");var k="servant-hmr-y";var y=sessionStorage.getItem(k);if(y){sessionStorage.removeItem(k);addEventListener("load",function(){scrollTo(0,+y)})}
es.onmessage=function(e){var d={};try{d=JSON.parse(e.data)}catch(x){}var f=d.files||[];if(f.length&&f.every(function(n){return/\\.css$/i.test(n)})){document.querySelectorAll('link[rel~="stylesheet"]').forEach(function(l){var u=new URL(l.href);u.searchParams.set("_hmr",Date.now());l.href=u.href});return}
try{sessionStorage.setItem(k,String(scrollY))}catch(x){}location.reload()}}catch(x){}})()</script>`;
// Edit mode (?edit=1): small tweaks for designers and content people, no code. Click any text to change it; the
// toolbar changes its color, size and spacing, undoes, and saves. The page is sandboxed, so it can't reach this
// server: Save hands the cleaned page to the Servant app around it (iframe postMessage on the web,
// ReactNativeWebView on phones), and the app saves it through the signed-in API (savePrototypePage below).
const EDITOR = `<script data-servant-editor>(function(){if(window.__servantEditor)return;window.__servantEditor=1;
var TEXT="h1,h2,h3,h4,h5,h6,p,li,a,button,label,span,td,th,dt,dd,figcaption,blockquote,legend,small,strong,em,b,i,summary,caption,div";
var sel=null,dirty=false,undo=[],busy=false;
var css=document.createElement("style");css.setAttribute("data-servant-editor","");css.textContent="[data-servant-hover]{outline:1px dashed #2672de!important;outline-offset:2px;cursor:text}[data-servant-selected]{outline:2px solid #2672de!important;outline-offset:2px}[contenteditable]:focus{outline:2px solid #2672de!important}html{padding-top:52px!important}";document.head.appendChild(css);
var host=document.createElement("div");host.setAttribute("data-servant-editor","");host.style.cssText="position:fixed;left:0;right:0;top:0;z-index:2147483647";
var root=host.attachShadow({mode:"open"});
root.innerHTML='<style>*{box-sizing:border-box;font:600 14px -apple-system,system-ui,sans-serif}.bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:calc(8px + env(safe-area-inset-top)) 10px 8px;background:#1b1b1b;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);scrollbar-width:none}button{flex:none}.hint{flex:1 0 auto;min-width:0;font-weight:400;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button{min-height:36px;min-width:36px;padding:0 10px;border:1px solid #565c65;border-radius:6px;background:#2d2e2f;color:#fff;cursor:pointer}button:disabled{opacity:.4;cursor:default}.save{background:#005ea2;border-color:#005ea2}.sw{min-width:28px;width:28px;height:28px;min-height:28px;padding:0;border-radius:14px;border:2px solid #fff}.grp{display:flex;gap:4px;align-items:center;flex:none}.grp[hidden],.hint[hidden]{display:none}</style><div class="bar"><span class="hint">Tap any text to change it</span><div class="grp" data-g="style" hidden><button class="sw" data-c="#1b1b1b" aria-label="Black text" style="background:#1b1b1b"></button><button class="sw" data-c="#005ea2" aria-label="Blue text" style="background:#005ea2"></button><button class="sw" data-c="#d83933" aria-label="Red text" style="background:#d83933"></button><button class="sw" data-c="#71767a" aria-label="Gray text" style="background:#71767a"></button><button data-a="smaller" aria-label="Smaller text">A-</button><button data-a="bigger" aria-label="Bigger text">A+</button><button data-a="tighter" aria-label="Less space">Space -</button><button data-a="looser" aria-label="More space">Space +</button></div><button data-a="undo" disabled>Undo</button><button data-a="save" class="save" disabled>Save</button></div>';
document.body.appendChild(host);
var hint=root.querySelector(".hint"),grp=root.querySelector("[data-g=style]"),bUndo=root.querySelector("[data-a=undo]"),bSave=root.querySelector("[data-a=save]");
function say(t){hint.textContent=t;refresh&&refresh()}
function refresh(){bUndo.disabled=!undo.length||busy;bSave.disabled=!dirty||busy;grp.hidden=!sel;hint.hidden=!!sel&&!busy&&!/Saved|Couldn|Nothing/.test(hint.textContent)}
function mine(e){return e.composedPath().indexOf(host)>=0}
function target(n){while(n&&n.nodeType===1&&n!==document.body){if(n.matches(TEXT)&&[].some.call(n.childNodes,function(c){return c.nodeType===3&&c.textContent.trim()}))return n;n=n.parentElement}return null}
var orig=new Map();function texts(el){return [].filter.call(el.childNodes,function(c){return c.nodeType===3&&c.textContent.trim()}).map(function(c){return c.textContent})}
function path(el){var parts=[];while(el&&el.nodeType===1&&el!==document.body&&el!==document.documentElement){if(el.id&&/^[A-Za-z][\\w-]*$/.test(el.id)){parts.unshift("#"+el.id);break}var i=1,s=el;while((s=s.previousElementSibling))i++;parts.unshift(el.tagName.toLowerCase()+":nth-child("+i+")");el=el.parentElement}return (parts[0]&&parts[0][0]==="#"?"":"body > ")+parts.join(" > ")}
function snap(el){if(!orig.has(el))orig.set(el,{texts:texts(el),style:el.getAttribute("style")});undo.push({el:el,html:el.innerHTML,style:el.getAttribute("style")});if(undo.length>100)undo.shift()}
function select(el){if(sel&&sel!==el){sel.removeAttribute("data-servant-selected");sel.removeAttribute("contenteditable")}sel=el;if(!el){refresh();return}el.setAttribute("data-servant-selected","");if(el.getAttribute("contenteditable")===null){snap(el);el.setAttribute("contenteditable","true")}el.focus();var r=document.createRange();r.selectNodeContents(el);r.collapse(false);var g=getSelection();g.removeAllRanges();g.addRange(r);say("");refresh()}
document.addEventListener("mouseover",function(e){if(mine(e))return;var t=target(e.target);document.querySelectorAll("[data-servant-hover]").forEach(function(n){if(n!==t)n.removeAttribute("data-servant-hover")});if(t)t.setAttribute("data-servant-hover","")},true);
document.addEventListener("click",function(e){if(mine(e))return;e.preventDefault();e.stopPropagation();var t=target(e.target);if(t!==sel)select(t)},true);
document.addEventListener("submit",function(e){e.preventDefault()},true);
document.addEventListener("keydown",function(e){if(!mine(e)&&e.key==="Enter"&&e.target.isContentEditable){e.preventDefault();e.target.blur()}},true);
document.addEventListener("input",function(e){if(!mine(e)){dirty=true;refresh()}},true);
function px(el,prop){return parseFloat(getComputedStyle(el)[prop])||0}
function styleIt(f){if(!sel)return;snap(sel);f(sel);dirty=true;refresh()}
root.addEventListener("click",function(e){var b=e.target.closest("button");if(!b||b.disabled)return;var c=b.getAttribute("data-c"),a=b.getAttribute("data-a");
if(c)return styleIt(function(el){el.style.color=c});
if(a==="smaller"||a==="bigger")return styleIt(function(el){el.style.fontSize=Math.max(8,px(el,"fontSize")+(a==="bigger"?2:-2))+"px"});
if(a==="tighter"||a==="looser")return styleIt(function(el){var d=a==="looser"?4:-4;el.style.marginTop=Math.max(0,px(el,"marginTop")+d)+"px";el.style.marginBottom=Math.max(0,px(el,"marginBottom")+d)+"px"});
if(a==="undo"){var u=undo.pop();if(u){u.el.innerHTML=u.html;if(u.style===null)u.el.removeAttribute("style");else u.el.setAttribute("style",u.style)}dirty=true;refresh();return}
if(a==="save")save()});
var STY=["color","fontSize","marginTop","marginBottom"];function kebab(k){return k.replace(/[A-Z]/g,function(c){return "-"+c.toLowerCase()})}
function changes(){var edits=[],styles=[];orig.forEach(function(o,el){if(!el.isConnected)return;var now=texts(el);if(now.length===o.texts.length){now.forEach(function(t,i){if(t!==o.texts[i])edits.push({from:o.texts[i].trim(),to:t.trim()})})}else if(now.join(" ").trim()!==o.texts.join(" ").trim())edits.push({from:o.texts.join(" ").trim(),to:now.join(" ").trim()});
var css={};STY.forEach(function(k){var probe=document.createElement("i");probe.setAttribute("style",o.style||"");if(el.style[k]&&el.style[k]!==probe.style[k])css[kebab(k)]=el.style[k]});if(Object.keys(css).length)styles.push({selector:path(el),css:css})});return{edits:edits,styles:styles}}
function save(){busy=true;refresh();say("Saving…");var c=changes();if(!c.edits.length&&!c.styles.length){busy=false;dirty=false;say("Nothing changed");refresh();return}var msg=JSON.stringify({servant:"prototype-save",path:location.pathname,edits:c.edits,styles:c.styles});
if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(msg);else if(parent!==window)parent.postMessage(msg,"*");else{busy=false;say("Open this from the Servant app to save");refresh()}}
window.__servantSaved=function(r){busy=false;if(r&&r.ok){dirty=false;undo=[];orig=new Map();say(r.missed&&r.missed.length?"Saved, except: \u201c"+r.missed[0]+"\u201d. Ask the agent for that one":"Saved")}else say((r&&r.message)||"Couldn't save. Try again");refresh()};
addEventListener("message",function(e){var d=e.data;try{d=typeof d==="string"?JSON.parse(d):d}catch(x){return}if(d&&d.servant==="prototype-saved")window.__servantSaved(d)});
addEventListener("beforeunload",function(e){if(dirty&&!busy){e.preventDefault();e.returnValue=""}});
})()</script>`;

// Review mode (?review=1): a business owner looking at a shared prototype (docs/prototype-reviews.md). Right-click
// (or press and hold on a touch screen) anywhere to say where a comment goes; the review page around this frame
// shows the box to write it in, keeps it, and sends back the numbered pins to draw. The page is sandboxed, so it
// can't reach this server: everything goes through postMessage to the page that framed it. Links inside the
// prototype keep review mode on.
export const REVIEW = `<script data-servant-review>(function(){if(window.__servantReview)return;window.__servantReview=1;
function send(m){m.servant="prototype-review";m.page=location.pathname;try{parent.postMessage(JSON.stringify(m),"*")}catch(x){}}
function words(n){while(n&&n.nodeType===1&&n!==document.documentElement){var t=(n.getAttribute("aria-label")||n.getAttribute("alt")||n.textContent||"").replace(/\\s+/g," ").trim();if(t)return t.slice(0,120);n=n.parentElement}return ""}
function at(e,p){var d=document.documentElement,b=document.body||d;var w=Math.max(d.scrollWidth,b.scrollWidth,1),h=Math.max(d.scrollHeight,b.scrollHeight,1);
send({type:"at",x:p.pageX/w,y:p.pageY/h,left:p.clientX,top:p.clientY,anchor:words(e.target)})}
document.addEventListener("contextmenu",function(e){if(e.target&&e.target.closest&&e.target.closest("[data-servant-pin]"))return;e.preventDefault();at(e,e)},true);
var hold=null,start=null;
document.addEventListener("touchstart",function(e){if(e.touches.length!==1)return;var t=e.touches[0];start={x:t.clientX,y:t.clientY};hold=setTimeout(function(){hold=null;at(e,t)},600)},{passive:true,capture:true});
function drop(){if(hold){clearTimeout(hold);hold=null}}
document.addEventListener("touchend",drop,true);document.addEventListener("touchcancel",drop,true);
document.addEventListener("touchmove",function(e){var t=e.touches[0];if(start&&t&&(Math.abs(t.clientX-start.x)>10||Math.abs(t.clientY-start.y)>10))drop()},{passive:true,capture:true});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var u;try{u=new URL(a.getAttribute("href"),location.href)}catch(x){return}
if(u.origin!==location.origin||u.pathname===location.pathname||!/^\\/p\\//.test(u.pathname)||a.target==="_blank")return;u.searchParams.set("review","1");e.preventDefault();location.href=u.toString()},true);
var css=document.createElement("style");css.setAttribute("data-servant-review","");
css.textContent="[data-servant-pin]{position:absolute;z-index:2147483646;width:28px;height:28px;margin:-30px 0 0 4px;border-radius:14px;border:2px solid #fff;background:#2672de;color:#fff;font:700 13px/24px -apple-system,system-ui,sans-serif;text-align:center;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.4);padding:0}[data-servant-pin]:focus-visible{outline:3px solid #1b1b1b;outline-offset:2px}";
document.head.appendChild(css);
function draw(pins){[].forEach.call(document.querySelectorAll("[data-servant-pin]"),function(n){n.remove()});var d=document.documentElement,b=document.body||d;var w=Math.max(d.scrollWidth,b.scrollWidth,1),h=Math.max(d.scrollHeight,b.scrollHeight,1);
(pins||[]).forEach(function(p){var n=document.createElement("button");n.type="button";n.setAttribute("data-servant-pin",p.id);n.setAttribute("aria-label","Comment "+p.n);n.textContent=String(p.n);n.style.left=(p.x*w)+"px";n.style.top=(p.y*h)+"px";
n.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();send({type:"pin",id:p.id})});b.appendChild(n)})}
var last=[];
addEventListener("message",function(e){var d=e.data;try{d=typeof d==="string"?JSON.parse(d):d}catch(x){return}if(d&&d.servant==="prototype-pins"){last=d.pins||[];draw(last)}});
addEventListener("resize",function(){draw(last)});
addEventListener("load",function(){send({type:"ready"})});send({type:"ready"});
})()</script>`;

/**
 * Save the tweaks made in edit mode to the page's source. Words are swapped where they are written in the file
 * (prototypes often draw their screens from a script, so a snapshot of the rendered page would be undone on the next
 * load); color, size and spacing go into one <style data-servant-tweaks> block, merged per element. Only an existing
 * page in this prototype's folder; the old version goes to <folder>/.history/ (dot folders are never served).
 * Words that can't be found exactly once are skipped and named back, never guessed at.
 */
const STYLE_PROPS = new Set(["color", "font-size", "margin-top", "margin-bottom"]);
const STYLE_VALUE = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|\d+(?:\.\d+)?px)$/i;
const SELECTOR = /^(?:body > |#[A-Za-z][\w-]*)?[a-z0-9#:()\-_ >]*$/i;
const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function savePrototypePage(dir, folder, pagePath, { edits = [], styles = [] } = {}) {
  const bad = (status, message) => Object.assign(new Error(message), { status });
  if (!FOLDER.test(folder || "")) throw bad(404, "No such prototype");
  if (!Array.isArray(edits) || !Array.isArray(styles) || edits.length + styles.length === 0 || edits.length + styles.length > 200) throw bad(400, "Nothing to save");
  let rel = String(pagePath || "");
  const prefix = `/p/${folder}/`;
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  try { rel = decodeURIComponent(rel); } catch { rel = "\0"; }
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const parts = rel.split("/");
  if (parts.some(p => !p || p === ".." || p.startsWith(".") || p.includes("\0")) || !/\.html?$/i.test(rel)) throw bad(400, "Only pages can be edited");
  const root = path.join(dir, folder), file = path.join(root, ...parts);
  let real;
  try { real = fs.realpathSync(file); } catch { throw bad(404, "No such page"); }
  const base = fs.realpathSync(root);
  if (!real.startsWith(base + path.sep) || !fs.statSync(real).isFile()) throw bad(404, "No such page");
  let html = fs.readFileSync(real, "utf8");
  const missed = [];
  let applied = 0;
  for (const e of edits) {
    const from = typeof e?.from === "string" ? e.from : "", to = typeof e?.to === "string" ? e.to : "";
    if (!from.trim() || from === to || from.length > 2000 || to.length > 2000) continue;
    const found = [from, escapeHtml(from)].find(f => html.split(f).length === 2);
    if (!found) { missed.push(from.slice(0, 80)); continue; }
    html = html.replace(found, () => found === from ? to : escapeHtml(to));
    applied++;
  }
  const rules = new Map();
  const block = html.match(/<style data-servant-tweaks>([\s\S]*?)<\/style>/);
  if (block) for (const m of block[1].matchAll(/([^{}]+)\{([^}]*)\}/g)) rules.set(m[1].trim(), m[2]);
  for (const st of styles) {
    const selector = String(st?.selector || "").trim();
    if (!selector || selector.length > 400 || !SELECTOR.test(selector)) continue;
    const decls = new Map((rules.get(selector) || "").split(";").map(d => d.split(":").map(x => x.trim())).filter(d => d[0]));
    for (const [k, v] of Object.entries(st?.css || {})) if (STYLE_PROPS.has(k) && STYLE_VALUE.test(String(v))) decls.set(k, `${v} !important`.replace(/( !important)+$/, " !important"));
    if (decls.size) { rules.set(selector, [...decls].map(([k, v]) => `${k}:${v}`).join(";")); applied++; }
  }
  if (rules.size) {
    const css = `<style data-servant-tweaks>\n${[...rules].map(([sel, d]) => `${sel}{${d}}`).join("\n")}\n</style>`;
    html = block ? html.replace(block[0], () => css) : /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${css}\n</head>`) : css + "\n" + html;
  }
  if (!applied) return { path: parts.join("/"), missed };
  const history = path.join(base, ".history");
  fs.mkdirSync(history, { recursive: true, mode: 0o700 });
  fs.copyFileSync(real, path.join(history, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${parts.join("_")}`));
  fs.writeFileSync(real, html);
  return { path: parts.join("/"), missed };
}
const watchers = new Map();
function snapshot(root) {
  const out = new Map();
  const walk = (d, rel) => {
    let names; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      if (n.name.startsWith(".") || n.isSymbolicLink()) continue;
      const full = path.join(d, n.name), r = rel ? `${rel}/${n.name}` : n.name;
      if (n.isDirectory()) walk(full, r);
      else try { const st = fs.statSync(full); out.set(r, `${st.mtimeMs}:${st.size}`); } catch { /* removed */ }
    }
  };
  walk(root, "");
  return out;
}
const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k));
export function _watching() { return watchers.size; }

function serveHmr(req, res, root) {
  if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return true; }
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": "*", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  res.write("retry: 1500\n\n");
  let w = watchers.get(root);
  if (!w) {
    w = { clients: new Set(), snap: snapshot(root) };
    w.timer = setInterval(() => {
      const next = snapshot(root), changed = diff(w.snap, next);
      w.snap = next;
      if (changed.length) for (const c of w.clients) c.write(`data: ${JSON.stringify({ files: changed.slice(0, 50) })}\n\n`);
    }, 500);
    w.timer.unref?.();
    watchers.set(root, w);
  }
  w.clients.add(res);
  const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
  beat.unref?.();
  req.on("close", () => {
    clearInterval(beat); w.clients.delete(res);
    if (!w.clients.size) { clearInterval(w.timer); watchers.delete(root); }
  });
  return true;
}

/** A new unguessable folder name for a chat's prototype. */
export const newFolder = () => `proto-${crypto.randomBytes(9).toString("hex")}`;

/**
 * Serve GET/HEAD /p/<folder>/<file…>. Pages run in a sandbox with no access to this server's origin (so a
 * prototype can't read anything from the API); static files are public. Returns false when the URL isn't ours.
 */
export function servePrototype(req, res, url, { dir, kitDir, ip = "" }) {
  if (!url.pathname.startsWith("/p/")) return false;
  const send = (status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers }); res.end(req.method === "HEAD" ? undefined : body); return true; };
  if (!allowed(ip)) return send(429, "Too many requests. Try again in a minute.", { "Retry-After": "60" });
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed", { Allow: "GET, HEAD" });
  let parts;
  try { parts = url.pathname.slice(3).split("/").map(decodeURIComponent); } catch { return send(404, "Not found"); }
  const [first, ...rest] = parts;
  const root = KIT.has(first) ? (kitDir ? path.join(kitDir, first) : null) : FOLDER.test(first || "") ? path.join(dir, first) : null;
  if (!root || rest.some(p => p === ".." || p.includes("\0") || p.startsWith("."))) return send(404, "Not found");
  // Folder URLs need the trailing slash so relative links (../components/) land in the right place.
  if (!KIT.has(first) && rest.length === 0) { res.writeHead(301, { Location: `${url.pathname}/${url.search}`, "Cache-Control": "no-store" }); res.end(); return true; }
  if (!KIT.has(first) && rest.length === 1 && rest[0] === "__hmr") return serveHmr(req, res, root);
  let file = path.join(root, ...rest.filter(Boolean));
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    const real = fs.realpathSync(file), base = fs.realpathSync(root);
    if (real !== base && !real.startsWith(base + path.sep)) return send(404, "Not found");
    if (fs.statSync(real).size > MAX_FILE) return send(413, "File too large");
    let body = fs.readFileSync(real);
    // Live reload only for a prototype's own pages, never the shared kit.
    if (!KIT.has(first) && /\.html?$/i.test(real)) {
      const html = body.toString("utf8");
      const inject = CLIENT + (url.searchParams.get("edit") === "1" ? EDITOR : "") + (url.searchParams.get("review") === "1" ? REVIEW : "");
      body = Buffer.from(/<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${inject}</body>`) : html + inject);
    }
    return send(200, body, {
      "Content-Type": typeFor(real),
      "Content-Length": String(body.length),
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'self' data: blob: 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; form-action 'self'; base-uri 'self'",
    });
  } catch { return send(404, "Not found"); }
}
