// The review page (<server>/review/<link>): where a business owner confirms their email and comments on a shared
// prototype (docs/prototype-reviews.md). One self-contained HTML string and plain JavaScript; the only network
// traffic is to this server's /review/<link>/… routes and the prototype it frames.
//
// Everything that came from a person (the prototype's title, who shared it, comments) only ever goes through
// textContent. The prototype runs in its own sandboxed frame and talks to this page by postMessage (prototypes.mjs,
// REVIEW): where a right-click landed, which pin was pressed. This page keeps the session and does the saving.
import { pageStyle } from "./page-style.mjs";

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Response headers: nothing loads from anywhere but this server, nothing is cached or indexed, nothing can frame it. */
export function reviewPageHeaders(nonce) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  };
}

const CSS = `
html,body{height:100%}
body{display:flex;flex-direction:column}
.viewer{display:contents}
main.gate{width:100%;max-width:480px;margin:0 auto;padding:48px 24px}
.code{font-size:24px;letter-spacing:6px;text-align:center}
.stack>*+*{margin-top:12px}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:8px 16px;border-bottom:1px solid var(--line)}
.bar h1{font-size:18px;line-height:24px;letter-spacing:-.15px;margin:0;flex:1 1 200px;min-width:0;overflow-wrap:anywhere}
.bar p{margin:0;flex:2 1 240px}
.work{flex:1;min-height:0;display:flex;position:relative}
.work iframe{flex:1;min-width:0;border:0;background:#fff}
.panel{flex:0 0 340px;max-width:100%;border-left:1px solid var(--line);overflow:auto;padding:16px}
.panel h2{margin:0 0 8px}
.panel ol{list-style:none;margin:0;padding:0}
.panel li{padding:12px 0;border-top:1px solid var(--line);margin:0}
.panel li[data-on=true]{background:var(--blueSoft);margin:0 -16px;padding:12px 16px}
.pin{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:12px;background:var(--primary);color:var(--onPrimary);font-weight:700;font-size:13px;margin-right:8px}
.where{color:var(--muted);font-size:13px;line-height:18px;margin:4px 0 0}
.words{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 0}
.composer{position:absolute;z-index:5;width:min(340px,calc(100% - 16px));max-height:calc(100% - 16px);overflow:auto;padding:16px;border:1px solid var(--borderStrong);border-radius:10px;background:var(--background);box-shadow:0 8px 30px rgba(0,0,0,.25)}
.composer textarea{min-height:96px}
.row{display:flex;gap:8px;margin-top:12px}
.row>*{flex:1}
@media (max-width:760px){.work{flex-direction:column}.panel{flex:0 0 auto;max-height:45%;border-left:0;border-top:1px solid var(--line)}}
`;

// Runs in the reviewer's browser. `B` is the base path of this link's routes.
const SCRIPT = `(function(){
var B=location.pathname.replace(/\\/+$/,""),KEY="servant-review:"+B;
var $=function(id){return document.getElementById(id)};
var gate=$("gate"),viewer=$("viewer"),err=$("error"),sendBtn=$("send"),codeBox=$("codeBox"),codeIn=$("code"),checkBtn=$("check");
var frame=$("frame"),list=$("list"),count=$("count"),empty=$("empty"),composer=$("composer"),text=$("text"),onWhat=$("onWhat"),save=$("save"),cancel=$("cancel"),cerr=$("cerr");
var session=null,challenge=null,proto=null,comments=[],pending=null,page="";
try{session=sessionStorage.getItem(KEY)}catch(x){}
function say(el,m){el.textContent=m||""}
function api(method,path,body){var h={"Content-Type":"application/json"};if(session)h.Authorization="Bearer "+session;
return fetch(B+path,{method:method,headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok){var e=new Error((j.error&&j.error.message)||"Something went wrong. Try again");e.status=r.status;throw e}return j})})}
function busy(b,on,label){b.disabled=on;if(label)b.textContent=label}
sendBtn.addEventListener("click",function(){say(err,"");busy(sendBtn,true,"Sending…");api("POST","/code").then(function(j){challenge=j.challenge;codeBox.hidden=false;busy(sendBtn,false,"Send another code");codeIn.focus()},function(e){say(err,e.message);busy(sendBtn,false,"Email me a code")})});
function check(){var c=codeIn.value.replace(/\\s/g,"");if(!challenge){say(err,"Ask for a code first");return}if(!/^\\d{6}$/.test(c)){say(err,"Enter the six digits from the email");return}
say(err,"");busy(checkBtn,true,"Checking…");api("POST","/verify",{challenge:challenge,code:c}).then(function(j){session=j.session;try{sessionStorage.setItem(KEY,session)}catch(x){}open(j)},function(e){say(err,e.message);busy(checkBtn,false,"See the prototype")})}
checkBtn.addEventListener("click",check);codeIn.addEventListener("keydown",function(e){if(e.key==="Enter")check()});
function open(j){proto=j.prototype;comments=j.comments||[];gate.hidden=true;viewer.hidden=false;document.body.classList.add("open");frame.src=proto+"?review=1";draw()}
function relative(p){var i=p.indexOf(proto);p=i===0?p.slice(proto.length):p;return p===""||/\\/$/.test(p)?p+"index.html":p}
function pins(){var out=[];comments.forEach(function(c,i){if(c.page===page)out.push({id:c.id,n:i+1,x:c.x,y:c.y})});try{frame.contentWindow.postMessage(JSON.stringify({servant:"prototype-pins",pins:out}),"*")}catch(x){}}
function draw(on){say(count,comments.length===1?"1 comment":comments.length+" comments");empty.hidden=comments.length>0;while(list.firstChild)list.removeChild(list.firstChild);
comments.forEach(function(c,i){var li=document.createElement("li");li.setAttribute("data-on",String(c.id===on));var n=document.createElement("span");n.className="pin";n.textContent=String(i+1);n.setAttribute("aria-hidden","true");
var w=document.createElement("p");w.className="words";w.textContent=c.text;var where=document.createElement("p");where.className="where";where.textContent=(c.anchor?"On \\u201c"+c.anchor+"\\u201d \\u00b7 ":"")+c.page+(c.asked?" \\u00b7 Sent to the team\\u2019s agent":"");
var head=document.createElement("div");head.appendChild(n);var lab=document.createElement("strong");lab.textContent="Comment "+(i+1);head.appendChild(lab);li.appendChild(head);li.appendChild(w);li.appendChild(where);list.appendChild(li);if(c.id===on)li.scrollIntoView({block:"nearest"})});pins()}
addEventListener("message",function(e){if(e.source!==frame.contentWindow)return;var d=e.data;try{d=typeof d==="string"?JSON.parse(d):d}catch(x){return}if(!d||d.servant!=="prototype-review")return;
if(typeof d.page==="string")page=relative(d.page);
if(d.type==="ready")pins();
else if(d.type==="pin")draw(d.id);
else if(d.type==="at")ask(d)});
var spot={left:0,top:0};
function place(){var r=frame.getBoundingClientRect(),host=composer.parentElement.getBoundingClientRect();var left=r.left-host.left+spot.left+12,top=r.top-host.top+spot.top+12;
left=Math.max(8,Math.min(left,host.width-composer.offsetWidth-8));top=Math.max(8,Math.min(top,host.height-composer.offsetHeight-8));composer.style.left=left+"px";composer.style.top=top+"px"}
function note(m){say(cerr,m);place()}
function ask(d){pending={page:page,x:d.x,y:d.y,anchor:String(d.anchor||"").slice(0,120)};say(cerr,"");say(onWhat,pending.anchor?"On \\u201c"+pending.anchor+"\\u201d":d.whole?"About this page as a whole":"At this spot");composer.hidden=false;
spot={left:+d.left||0,top:+d.top||0};text.value="";place();text.focus()}
text.addEventListener("input",function(){if(cerr.textContent)note("")});addEventListener("resize",function(){if(!composer.hidden)place()});
function closeComposer(){composer.hidden=true;pending=null}
cancel.addEventListener("click",closeComposer);
// Without a mouse or a long press: a comment about the page as a whole, pinned at its top.
$("add").addEventListener("click",function(){ask({x:.5,y:0,left:frame.clientWidth/2-170,top:0,anchor:"",whole:true})});
composer.addEventListener("keydown",function(e){if(e.key==="Escape")closeComposer();if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))save.click()});
save.addEventListener("click",function(){if(!pending)return;var words=text.value.trim();if(!words){note("Write your comment first");return}
busy(save,true,"Saving…");api("POST","/comments",{page:pending.page,x:pending.x,y:pending.y,anchor:pending.anchor,text:words}).then(function(j){comments.push(j.comment);busy(save,false,"Save comment");closeComposer();draw(j.comment.id)},
function(e){busy(save,false,"Save comment");if(e.status===401){try{sessionStorage.removeItem(KEY)}catch(x){}location.reload();return}note(e.message)})});
if(session){api("GET","/comments").then(open,function(){session=null;try{sessionStorage.removeItem(KEY)}catch(x){}gate.hidden=false})}else gate.hidden=false;
})();`;

/**
 * The page for one share. `ended` shows a plain message instead (a link that was replaced or ended, or never
 * existed: the page says the same thing for all three, so a guess learns nothing).
 */
export function reviewPage({ nonce, theme, title = "", sharedBy = "", masked = "", serverName = "Servant", ended = false }) {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow">
<title>${ended ? "This link doesn't work" : `Review: ${esc(title)}`}</title><style nonce="${nonce}">${pageStyle(theme)}${CSS}</style></head><body>`;
  if (ended) {
    return `${head}<main class="gate"><h1>This link doesn't work</h1><p>It may have been replaced by a newer one, or the person who shared the prototype ended it. Ask them to share it with you again.</p></main></body></html>`;
  }
  return `${head}
<main class="gate stack" id="gate" hidden>
  <h1>${esc(sharedBy)} shared a prototype with you</h1>
  <p><strong>${esc(title)}</strong>, from ${esc(serverName)}. They'd like your comments on it.</p>
  <p>To see it, confirm that <strong>${esc(masked)}</strong> is you. We'll email a six-digit code to that address.</p>
  <button class="primary full" id="send" type="button">Email me a code</button>
  <div id="codeBox" class="stack" hidden>
    <label for="code">Six-digit code</label>
    <input class="code" id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" aria-describedby="error">
    <button class="primary full" id="check" type="button">See the prototype</button>
  </div>
  <p class="notice error" id="error" role="alert"></p>
  <p class="small muted">Your comments go to ${esc(sharedBy)}, with this email address. Nothing else about you is kept.</p>
</main>
<div id="viewer" class="viewer" hidden>
  <header class="bar">
    <h1>${esc(title)}</h1>
    <p class="small muted">Right-click anywhere on the prototype to leave a comment (on a phone, press and hold). <span id="count" aria-live="polite"></span></p>
    <button class="secondary" id="add" type="button">Comment on this page</button>
  </header>
  <div class="work">
    <iframe id="frame" title="Prototype: ${esc(title)}" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>
    <aside class="panel" aria-label="Your comments">
      <h2>Your comments</h2>
      <p class="small muted" id="empty">None yet. Right-click the part of the prototype you want to talk about.</p>
      <ol id="list"></ol>
    </aside>
    <div class="composer" id="composer" role="dialog" aria-label="Leave a comment" hidden>
      <p class="small muted" id="onWhat"></p>
      <label for="text">Comment</label>
      <textarea id="text" maxlength="2000" aria-describedby="cerr"></textarea>
      <p class="notice error" id="cerr" role="alert"></p>
      <div class="row"><button class="primary" id="save" type="button">Save comment</button><button class="secondary" id="cancel" type="button">Cancel</button></div>
    </div>
  </div>
</div>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
