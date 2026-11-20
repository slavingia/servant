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
.corner{position:absolute;z-index:3;right:16px;bottom:16px;width:min(360px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto;padding:16px;border:1px solid var(--borderStrong);border-radius:12px;background:var(--background);box-shadow:0 8px 30px rgba(0,0,0,.25)}
.corner[hidden]{display:none}
.corner h2{margin:0;font-size:18px;line-height:24px}
.corner p{margin:0}
.cornerHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.cornerHead button{width:auto;min-height:44px;flex:none}
.reopen{position:absolute;z-index:3;right:16px;bottom:16px;width:auto;min-height:44px;border-radius:22px;box-shadow:0 4px 18px rgba(0,0,0,.22)}
.reopen[hidden]{display:none}
.bar[hidden]{display:none}
.code{font-size:24px;letter-spacing:6px;text-align:center}
.stack>*+*{margin-top:12px}
.work{flex:1;min-height:0;display:flex;position:relative}
.work iframe{flex:1;min-width:0;border:0;background:#fff}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bar{position:absolute;z-index:3;left:0;right:0;bottom:16px;margin:0 auto;width:fit-content;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:4px 12px;max-width:calc(100% - 16px);padding:6px 8px 6px 16px;border:1px solid var(--borderStrong);border-radius:28px;background:var(--background);box-shadow:0 4px 18px rgba(0,0,0,.22)}
.bar p{margin:0}
.bar a.join{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;color:var(--blue);font-weight:600;text-decoration:underline}
.bar a.join[hidden]{display:none}
.bar .touch{display:none}
@media (hover:none){.bar .touch{display:inline}.bar .mouse{display:none}}
.bar button{min-height:44px;border-radius:22px;width:auto}
.panel{position:absolute;z-index:4;top:0;right:0;bottom:0;width:min(340px,100%);border-left:1px solid var(--line);background:var(--background);box-shadow:-4px 0 18px rgba(0,0,0,.18);overflow:auto;padding:16px}
.panel[hidden]{display:none}
.panelHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.panelHead button{width:auto;min-height:44px}
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
@media (max-width:760px){.panel{top:auto;max-height:60%;width:100%;border-left:0;border-top:1px solid var(--line)}.bar{bottom:8px}}
`;

// Runs in the reviewer's browser. `B` is the base path of this link's routes.
const SCRIPT = `(function(){
var B=location.pathname.replace(/\\/+$/,""),KEY="servant-review:"+B;
var $=function(id){return document.getElementById(id)};
var hideBtn=$("hide"),reopen=$("reopen"),bar=$("bar");var gate=$("gate"),viewer=$("viewer"),err=$("error"),sendBtn=$("send"),codeBox=$("codeBox"),codeIn=$("code"),checkBtn=$("check");var seeLabel=checkBtn.textContent;
var panel=$("panel"),joinLink=$("join");var frame=$("frame"),list=$("list"),count=$("count"),empty=$("empty"),composer=$("composer"),text=$("text"),onWhat=$("onWhat"),save=$("save"),cancel=$("cancel"),cerr=$("cerr");
var session=null,challenge=null,proto=null,isApp=false,comments=[],pending=null,page="";
try{session=sessionStorage.getItem(KEY)}catch(x){}
function say(el,m){el.textContent=m||""}
function api(method,path,body){var h={"Content-Type":"application/json"};if(session)h.Authorization="Bearer "+session;
return fetch(B+path,{method:method,headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){if(!r.ok){var e=new Error((j.error&&j.error.message)||"Something went wrong. Try again");e.status=r.status;throw e}return j})})}
function busy(b,on,label){b.disabled=on;if(label)b.textContent=label}
sendBtn.addEventListener("click",function(){say(err,"");busy(sendBtn,true,"Sending…");api("POST","/code").then(function(j){challenge=j.challenge;codeBox.hidden=false;busy(sendBtn,false,"Send another code");codeIn.focus()},function(e){say(err,e.message);busy(sendBtn,false,"Email me a code")})});
function check(){var c=codeIn.value.replace(/\\s/g,"");if(!challenge){say(err,"Ask for a code first");return}if(!/^\\d{6}$/.test(c)){say(err,"Enter the six digits from the email");return}
say(err,"");busy(checkBtn,true,"Checking…");api("POST","/verify",{challenge:challenge,code:c}).then(function(j){session=j.session;try{sessionStorage.setItem(KEY,session)}catch(x){}open(j)},function(e){say(err,e.message);busy(checkBtn,false,seeLabel)})}
function showGate(on){gate.hidden=!on;reopen.hidden=on}
hideBtn.addEventListener("click",function(){showGate(false);reopen.focus()});reopen.addEventListener("click",function(){showGate(true);sendBtn.focus()});
checkBtn.addEventListener("click",check);codeIn.addEventListener("keydown",function(e){if(e.key==="Enter")check()});
function open(j){if(j.join&&/^(https?:|servant:)/.test(j.join)){joinLink.href=j.join;joinLink.textContent="Join "+(j.team||"the team");joinLink.hidden=false}else{joinLink.hidden=true}comments=j.comments||[];gate.hidden=true;reopen.hidden=true;bar.hidden=false;draw()}
// The prototype is on screen as soon as the link is opened. The code is for commenting, and for joining when invited.
proto=viewer.getAttribute("data-prototype");isApp=viewer.hasAttribute("data-app");document.body.classList.add("open");frame.src=proto+"?review=1";
function relative(p){var i=p.indexOf(proto);p=i===0?p.slice(proto.length):p;if(isApp){p=p.replace(/^\\/+|\\/+$/g,"");return p||"/"}return p===""||/\\/$/.test(p)?p+"index.html":p}
function pins(){if(isApp)return;var out=[];comments.forEach(function(c,i){if(c.page===page)out.push({id:c.id,n:i+1,x:c.x,y:c.y})});try{frame.contentWindow.postMessage(JSON.stringify({servant:"prototype-pins",pins:out}),"*")}catch(x){}}
function showPanel(on){panel.hidden=!on;count.setAttribute("aria-expanded",String(on))}
function draw(on){say(count,comments.length===0?"No comments":comments.length===1?"1 comment":comments.length+" comments");if(on)showPanel(true);empty.hidden=comments.length>0;while(list.firstChild)list.removeChild(list.firstChild);
comments.forEach(function(c,i){var li=document.createElement("li");li.setAttribute("data-on",String(c.id===on));var n=document.createElement("span");n.className="pin";n.textContent=String(i+1);n.setAttribute("aria-hidden","true");
var w=document.createElement("p");w.className="words";w.textContent=c.text;var where=document.createElement("p");where.className="where";where.textContent=(c.anchor?"On \\u201c"+c.anchor+"\\u201d \\u00b7 ":"")+(c.page==="/"?"First screen":c.page)+(c.asked?" \\u00b7 Sent to the team\\u2019s agent":"");
var head=document.createElement("div");head.appendChild(n);var lab=document.createElement("strong");lab.textContent="Comment "+(i+1);head.appendChild(lab);li.appendChild(head);li.appendChild(w);li.appendChild(where);list.appendChild(li);if(c.id===on)li.scrollIntoView({block:"nearest"})});pins()}
addEventListener("message",function(e){if(e.source!==frame.contentWindow)return;var d=e.data;try{d=typeof d==="string"?JSON.parse(d):d}catch(x){return}if(!d||d.servant!=="prototype-review")return;
if(typeof d.page==="string")page=relative(d.page);
if(d.type==="ready")pins();
else if(d.type==="pin")draw(d.id);
else if(d.type==="at"){if(session)ask(d);else{showGate(true);say(err,"Confirm your email with a code to leave a comment");sendBtn.focus()}}});
var spot={left:0,top:0};
function place(){var r=frame.getBoundingClientRect(),host=composer.parentElement.getBoundingClientRect();var left=r.left-host.left+spot.left+12,top=r.top-host.top+spot.top+12;
left=Math.max(8,Math.min(left,host.width-composer.offsetWidth-8));top=Math.max(8,Math.min(top,host.height-composer.offsetHeight-8));composer.style.left=left+"px";composer.style.top=top+"px"}
function note(m){say(cerr,m);place()}
function ask(d){pending={page:page,x:d.x,y:d.y,anchor:String(d.anchor||"").slice(0,120)};say(cerr,"");say(onWhat,pending.anchor?"On \\u201c"+pending.anchor+"\\u201d":d.whole?"About this page as a whole":"At this spot");composer.hidden=false;
spot={left:+d.left||0,top:+d.top||0};text.value="";place();text.focus()}
text.addEventListener("input",function(){if(cerr.textContent)note("")});addEventListener("resize",function(){if(!composer.hidden)place()});
function closeComposer(){composer.hidden=true;pending=null}
cancel.addEventListener("click",closeComposer);
count.addEventListener("click",function(){showPanel(panel.hidden)});$("closePanel").addEventListener("click",function(){showPanel(false);count.focus()});
// Without a mouse or a long press: a comment about the page as a whole, pinned at its top.
$("add").addEventListener("click",function(){ask({x:.5,y:0,left:frame.clientWidth/2-170,top:0,anchor:"",whole:true})});
composer.addEventListener("keydown",function(e){if(e.key==="Escape")closeComposer();if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))save.click()});
save.addEventListener("click",function(){if(!pending)return;var words=text.value.trim();if(!words){note("Write your comment first");return}
busy(save,true,"Saving…");api("POST","/comments",{page:pending.page,x:pending.x,y:pending.y,anchor:pending.anchor,text:words}).then(function(j){comments.push(j.comment);busy(save,false,"Save comment");closeComposer();draw()},
function(e){busy(save,false,"Save comment");if(e.status===401){try{sessionStorage.removeItem(KEY)}catch(x){}location.reload();return}note(e.message)})});
if(session){api("GET","/comments").then(open,function(){session=null;try{sessionStorage.removeItem(KEY)}catch(x){}showGate(true)})}else showGate(true);
})();`;

/**
 * The page for one share. `ended` shows a plain message instead (a link that was replaced or ended, or never
 * existed: the page says the same thing for all three, so a guess learns nothing).
 */
export function reviewPage({ nonce, theme, title = "", sharedBy = "", masked = "", serverName = "Servant", ended = false, app = false, prototype = "", invited = false }) {
  // The same page shows a prototype or a project's app preview; only the words differ.
  const the = app ? "the app" : "the prototype";
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow">
<title>${ended ? "This link doesn't work" : `Review: ${esc(title)}`}</title><style nonce="${nonce}">${pageStyle(theme)}${CSS}</style></head><body>`;
  if (ended) {
    return `${head}<main class="gate"><h1>This link doesn't work</h1><p>It may have been replaced by a newer one, or the person who shared it ended it. Ask them to share it with you again.</p></main></body></html>`;
  }
  return `${head}
<div id="viewer" class="viewer" data-prototype="${esc(prototype)}"${app ? ' data-app="1"' : ""}>
  <div class="work">
    <h1 class="sr">${esc(title)}</h1>
    <iframe id="frame" title="${app ? "App preview" : "Prototype"}: ${esc(title)}" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>
    <aside class="corner stack" id="gate" aria-label="${invited ? `Join ${esc(serverName)}` : "Leave comments"}" hidden>
      <div class="cornerHead"><h2>${invited ? `Do more with ${esc(serverName)}` : `${esc(sharedBy)} would like your comments`}</h2><button class="secondary" id="hide" type="button" aria-label="Hide this box">Hide</button></div>
      <p>${invited
        ? `${esc(sharedBy)} shared this with you, and you are invited to join ${esc(serverName)}. Have a look around. To comment on ${the}, or to join and do more, we'll email you a code to type here.`
        : `${esc(sharedBy)} shared this with you. Have a look around. To leave a comment, we'll email you a code to type here.`}</p>
      <p class="small muted">The code goes to <strong>${esc(masked)}</strong>.</p>
      <button class="primary full" id="send" type="button">Email me a code</button>
      <div id="codeBox" class="stack" hidden>
        <label for="code">Six-digit code</label>
        <input class="code" id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" aria-describedby="error">
        <button class="primary full" id="check" type="button">${invited ? "Confirm and continue" : "Confirm"}</button>
      </div>
      <p class="notice error" id="error" role="alert"></p>
    </aside>
    <button class="secondary reopen" id="reopen" type="button" hidden>${invited ? `Comment or join ${esc(serverName)}` : "Leave a comment"}</button>
    <div class="bar" role="group" aria-label="Comments" id="bar" hidden>
      <p class="small muted"><span class="mouse">Right-click anywhere to comment</span><span class="touch">Press and hold anywhere to comment</span></p>
      <button class="secondary" id="add" type="button">Comment on this page</button>
      <a class="join" id="join" target="_blank" rel="noopener" hidden></a>
      <button class="secondary" id="count" type="button" aria-expanded="false" aria-controls="panel">No comments</button>
    </div>
    <aside class="panel" id="panel" aria-label="Your comments" hidden>
      <div class="panelHead"><h2>Your comments</h2><button class="secondary" id="closePanel" type="button">Close</button></div>
      <p class="small muted" id="empty">None yet. Right-click the part of ${the} you want to talk about.</p>
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
