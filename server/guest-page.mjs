// The guest page (<server>/m/<code>): one self-contained HTML string, plain JavaScript, the browser's
// own calling. No app bundle, no scripts, fonts or images from anywhere else: the only network traffic
// is to this server's /g/<code>/… routes and the media servers the meeting view names. It runs on
// iPhone Safari, Android Chrome and desktop browsers.
//
// The script mirrors app/src/lib/meeting-call.ts: one send-and-receive connection to join, one
// receive-only connection per person to watch, a state poll every two seconds, a report when mute
// or camera changes, and leave. Names from the server only ever go through textContent.
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const CONSENT = "This meeting is recorded and an AI writes notes. By joining you agree to that.";

/** Response headers for every guest page: nothing loads from anywhere else, nothing is cached or indexed. */
export function pageHeaders(nonce) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src blob: mediastream:; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  };
}

const CSS = `
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:#0B1220;color:#fff;font:17px/1.4 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{min-height:100%;display:flex;flex-direction:column;padding:max(16px,env(safe-area-inset-top)) 20px max(16px,env(safe-area-inset-bottom))}
.card{width:100%;max-width:460px;margin:0 auto;display:flex;flex-direction:column;gap:14px;flex:1}
h1{font-size:26px;line-height:1.2;margin:8px 0 0}
p{margin:0;color:#C9D3E0}
.muted{color:#8E9BB3;font-size:15px}
label{font-size:15px;color:#C9D3E0;display:block;margin-bottom:6px}
input{width:100%;min-height:52px;padding:12px 14px;border-radius:12px;border:1px solid #2A3650;background:#131C2E;color:#fff;font:inherit;font-size:18px}
input:focus{outline:2px solid #4A9EE8;outline-offset:1px}
.preview{position:relative;width:100%;aspect-ratio:4/3;max-height:42vh;border-radius:12px;overflow:hidden;background:#1B2433}
.preview video,.tile video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#1B2433}
.preview video{transform:scaleX(-1)}
.center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#C9D3E0;font-size:16px;text-align:center;padding:12px}
.row{display:flex;gap:10px}
button{appearance:none;border:0;border-radius:999px;min-height:52px;padding:0 18px;font:600 17px -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;color:#fff;background:#243045;cursor:pointer;flex:1;touch-action:manipulation}
button:disabled{opacity:.5;cursor:default}
button.on{background:#fff;color:#0B1220}
button.primary{background:#0071BC}
button.leave{background:#D11242;flex:1.6;min-height:56px;font-size:18px}
button.small{min-height:44px;font-size:15px;flex:0 0 auto}
.consent{font-size:15px;color:#C9D3E0;background:#131C2E;border-radius:12px;padding:12px 14px;border:1px solid #2A3650}
.err{color:#FFB4C0;font-size:15px;min-height:1.2em}
.hidden{display:none !important}
#enter>button,#waiting>button{width:100%;flex:none}
#join{min-height:56px;font-size:18px}
#enter,#waiting,#done{width:100%;max-width:520px;margin:0 auto}
#enter{display:flex;flex-direction:column;gap:14px}
.wait{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px}
.dot{width:12px;height:12px;border-radius:50%;background:#4A9EE8;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:1;transform:scale(1.15)}}
.rec{display:inline-block;width:10px;height:10px;border-radius:50%;background:#E5484D;margin-right:6px;vertical-align:1px}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:15px;color:#C9D3E0;padding:4px 0}
.grid{flex:1;display:grid;gap:8px;align-content:center;justify-items:center;grid-template-columns:repeat(var(--cols,1),1fr);min-height:160px}
.stage{flex:1;min-height:220px;position:relative;border-radius:12px;overflow:hidden;background:#000}
.stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}
.strip .tile{flex:0 0 128px;height:96px;aspect-ratio:auto}
.tile{position:relative;aspect-ratio:4/3;width:min(100%,calc((100vh - 330px) * 4 / 3));border-radius:12px;overflow:hidden;background:#1B2433}
.tile .initial{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:700}
.tile .name,.stage .name{position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.5);padding:2px 8px;border-radius:6px;font-size:13px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.self{align-self:flex-end;width:120px;height:90px;border-radius:10px;overflow:hidden;position:relative;background:#1B2433;border:1px solid rgba(255,255,255,.25)}
.self video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
.controls{display:flex;gap:10px;padding-top:6px}
.controls button{white-space:nowrap}
@media (max-width:420px){.controls button{font-size:15px;padding:0 8px;gap:8px}.controls{gap:8px}.controls button.leave{font-size:17px}}
.done{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px}
.callbox{display:flex;flex-direction:column;gap:8px;flex:1;min-height:calc(100vh - 40px)}
@media (min-width:700px){.card{max-width:1100px}.self{width:160px;height:120px}.grid{min-height:240px}}
`;

/** The page for a live, open link. `hostName` is the starter's display name (never the room). */
export function guestPage({ hostName, nonce }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><title>Join the meeting</title>
<style nonce="${nonce}">${CSS}</style></head><body><main><div class="card">
<section id="enter">
<h1>Join the meeting</h1>
<p id="host" class="muted">${esc(hostName)} is hosting</p>
<div><label for="name">Your name</label><input id="name" autocomplete="name" maxlength="40" placeholder="Your name" enterkeyhint="go"></div>
<div class="preview" aria-label="Your camera"><video id="preview" autoplay playsinline muted></video><div id="previewText" class="center">Starting your camera…</div></div>
<div class="row"><button id="mute" type="button" disabled>Mute</button><button id="camera" type="button" disabled>Camera off</button></div>
<p class="consent" id="consent">${esc(CONSENT)}</p>
<p id="enterErr" class="err" role="alert"></p>
<button id="join" type="button" class="primary" disabled>Join</button>
</section>
<section id="waiting" class="wait hidden">
<div class="dot" aria-hidden="true"></div>
<h1 id="waitTitle">Waiting for the host to let you in</h1>
<p id="waitText" class="muted">Keep this page open.</p>
<button id="cancel" type="button" class="small">Leave</button>
</section>
<section id="call" class="callbox hidden">
<div class="top"><span id="status"><span class="rec" aria-hidden="true"></span>Recording · an AI writes notes</span><span id="count"></span></div>
<div id="stage" class="stage hidden"><video id="stageVideo" autoplay playsinline></video><div id="stageName" class="name"></div></div>
<div id="grid" class="grid"></div>
<div class="self" id="self" aria-label="Your camera"><video id="selfVideo" autoplay playsinline muted></video><div id="selfOff" class="center hidden">Camera off</div></div>
<p id="callErr" class="err" role="alert"></p>
<div class="controls"><button id="mute2" type="button">Mute</button><button id="camera2" type="button">Camera off</button><button id="leave" type="button" class="leave">Leave</button></div>
</section>
<section id="done" class="done hidden">
<h1 id="doneTitle"></h1>
<p id="doneText" class="muted"></p>
</section>
</div></main>
<script nonce="${nonce}">
(function(){
"use strict";
var HOST=${JSON.stringify(String(hostName || "Someone")).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};
var code=decodeURIComponent(location.pathname.split("/")[2]||"");
var base="/g/"+encodeURIComponent(code)+"/";
var $=function(id){return document.getElementById(id)};
var token=null,pid=null,pc=null,local=null,hasCamera=false,muted=false,cameraOff=false,closed=false,pollTimer=null,seenMute=0,ice=[],watching={},tiles={},inCall=false,joining=false;
var sections=["enter","waiting","call","done"];
var KEY="servant.guest."+code;function saved(){try{return sessionStorage.getItem(KEY)}catch(e){return null}}function keep(t){try{if(t)sessionStorage.setItem(KEY,t);else sessionStorage.removeItem(KEY)}catch(e){}}
function show(name){for(var i=0;i<sections.length;i++)$(sections[i]).classList.toggle("hidden",sections[i]!==name);}
var VOICE={echoCancellation:true,noiseSuppression:true,autoGainControl:true};
function stopTracks(){if(local){local.getTracks().forEach(function(t){t.stop()});}local=null;}
function setButtons(){var m=muted?"Unmute":"Mute",c=cameraOff?"Camera on":"Camera off";["mute","mute2"].forEach(function(id){$(id).textContent=m;$(id).classList.toggle("on",muted);$(id).setAttribute("aria-pressed",String(muted));});["camera","camera2"].forEach(function(id){$(id).textContent=c;$(id).classList.toggle("on",cameraOff);$(id).classList.toggle("hidden",!hasCamera);$(id).setAttribute("aria-pressed",String(cameraOff));});$("previewText").classList.toggle("hidden",!!local&&hasCamera&&!cameraOff);if(local&&(!hasCamera||cameraOff))$("previewText").textContent="Camera off";$("selfOff").classList.toggle("hidden",hasCamera&&!cameraOff);}
function toggleMute(){muted=!muted;if(local)local.getAudioTracks().forEach(function(t){t.enabled=!muted});setButtons();report();}
function toggleCamera(){if(!hasCamera)return;cameraOff=!cameraOff;if(local)local.getVideoTracks().forEach(function(t){t.enabled=!cameraOff});setButtons();report();}
["mute","mute2"].forEach(function(id){$(id).onclick=toggleMute});["camera","camera2"].forEach(function(id){$(id).onclick=toggleCamera});
function openMedia(){var md=navigator.mediaDevices;if(!md||!md.getUserMedia){$("previewText").textContent="This browser can't make calls. Try Safari or Chrome";return Promise.resolve(null);}
return md.getUserMedia({audio:VOICE,video:{width:640,height:480,frameRate:24}}).then(function(s){hasCamera=s.getVideoTracks().length>0;return s;},function(){return md.getUserMedia({audio:VOICE,video:false}).then(function(s){hasCamera=false;$("enterErr").textContent="We can't see a camera. You can still join with sound only";return s;},function(){$("previewText").textContent="Allow the camera and microphone, then reload this page";$("enterErr").textContent="This page can't use your camera or microphone. Allow both in your browser, then try again";return null;});});}
function startPreview(){return openMedia().then(function(s){if(!s){return null;}local=s;$("preview").srcObject=s;$("selfVideo").srcObject=s;$("mute").disabled=false;$("camera").disabled=false;$("join").disabled=false;setButtons();return s;});}
function api(path,method,body){var h={"Content-Type":"application/json"};if(token)h["Authorization"]="Bearer "+token;return fetch(base+path,{method:method,headers:h,body:method==="GET"?undefined:JSON.stringify(body||{}),cache:"no-store",credentials:"omit"}).then(function(r){return r.text().then(function(t){var j=null;try{j=JSON.parse(t)}catch(e){}return{status:r.status,body:j||{}};});});}
function gathered(p){return new Promise(function(res){if(p.iceGatheringState==="complete")return res();var t=setTimeout(done,3000);function done(){clearTimeout(t);p.removeEventListener("icegatheringstatechange",chk);res();}function chk(){if(p.iceGatheringState==="complete")done();}p.addEventListener("icegatheringstatechange",chk);});}
function finish(kind,why){if(closed)return;closed=true;keep(null);inCall=false;if(pollTimer)clearTimeout(pollTimer);Object.keys(watching).forEach(unwatch);if(pc){try{pc.close()}catch(e){}pc=null;}stopTracks();$("preview").srcObject=null;$("selfVideo").srcObject=null;
var titles={left:"You left the meeting",denied:"The host didn't let you in",removed:"You were removed from the meeting",ended:"This meeting has ended",failed:"Couldn't stay in the meeting",full:"This meeting is full"};
$("doneTitle").textContent=titles[kind]||titles.ended;$("doneText").textContent=why||"";show("done");}
// Knock: name + consent, then wait at the door.
$("join").onclick=function(){if(joining)return;var name=$("name").value.replace(/\\s+/g," ").trim();if(!name){$("enterErr").textContent="Enter your name";$("name").focus();return;}if(!local){startPreview();return;}joining=true;$("join").disabled=true;$("enterErr").textContent="";
api("knock","POST",{name:name}).then(function(r){joining=false;if(r.status===200&&r.body.guestToken){token=r.body.guestToken;keep(token);show("waiting");poll();return;}$("join").disabled=false;
$("enterErr").textContent=r.status===404?"This link doesn't work any more. Ask the host for a new one":r.status===429?(r.body.error&&r.body.error.message)||"Too many tries. Wait a little and try again":(r.body.error&&r.body.error.message)||"Couldn't reach the meeting. Check your connection and try again";},function(){joining=false;$("join").disabled=false;$("enterErr").textContent="Couldn't reach the meeting. Check your connection and try again";});};
$("name").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();$("join").click();}});
$("cancel").onclick=function(){finish("left","You left before the host let you in.");};
$("leave").onclick=function(){var p=pid;if(p){api("leave","POST",{participantId:p,final:true}).catch(function(){});}finish("left");};
function report(){if(pid&&!closed)api("state-report","POST",{participantId:pid,muted:muted,cameraOff:cameraOff}).catch(function(){});}
function poll(){if(closed)return;api("state","GET").then(function(r){if(closed)return;var b=r.body,wait=2000;
if(r.status===401){finish("ended","Your place in this meeting has expired. Ask the host for a new link.");return;}
if(r.status!==200){wait=4000;}
else if(b.state==="pending"){var hostHere=b.hostPresent!==false;$("waitTitle").textContent=hostHere?"Waiting for the host to let you in":"Waiting for the host to start the meeting";$("waitText").textContent="Keep this page open.";wait=hostHere?2000:4000;}
else if(b.state==="denied"){finish("denied","If that was a mistake, ask "+HOST+" to send you a new link.");return;}
else if(b.state==="removed"){finish("removed");return;}
else if(b.state==="ended"){finish("ended");return;}
else if(b.state==="admitted"){ice=b.iceServers||[];if(!inCall&&!joining){joining=true;join().then(function(){joining=false;},function(e){joining=false;finish("failed",String(e&&e.message||e));});}else if(inCall)sync(b);}
pollTimer=setTimeout(poll,wait);},function(){if(!closed)pollTimer=setTimeout(poll,4000);});}
function iceConfig(){return{iceServers:ice.length?ice:[{urls:"stun:stun.l.google.com:19302"}]};}
function join(){if(!local)return Promise.reject(new Error("Your camera and microphone were closed. Reload this page to join again."));pc=new RTCPeerConnection(iceConfig());local.getTracks().forEach(function(t){pc.addTrack(t,local)});
pc.addEventListener("connectionstatechange",function(){if(pc&&pc.connectionState==="failed"&&!closed)finish("failed","The call dropped before it connected. Check your connection (some Wi-Fi blocks calls) and open the link again.");});
return pc.createOffer().then(function(o){return pc.setLocalDescription(o)}).then(function(){return gathered(pc)}).then(function(){return api("join","POST",{sdp:pc.localDescription.sdp})}).then(function(r){
if(r.status!==200){var m=(r.body.error&&r.body.error.message)||"Couldn't join";if(r.body.error&&r.body.error.code==="guests_full")throw Object.assign(new Error(m),{full:true});throw new Error(m);}
pid=r.body.participantId;return pc.setRemoteDescription({type:"answer",sdp:r.body.sdp});}).then(function(){inCall=true;show("call");setButtons();if(muted||cameraOff)report();}).catch(function(e){if(e&&e.full){finish("full","Ask the host to make room, then open the link again.");}throw e;});}
function sync(v){var ps=(v.participants||[]).filter(function(p){return !p.screen});$("count").textContent=ps.length===1?"Only you":ps.length+" people";
var me=null;(v.participants||[]).forEach(function(p){if(p.you&&!p.screen)me=p;});
if(me&&(me.muteSeq||0)>seenMute){seenMute=me.muteSeq||0;if(!muted){toggleMute();$("callErr").textContent="The host muted you. Tap Unmute to talk.";setTimeout(function(){$("callErr").textContent=""},6000);}}
var others=(v.participants||[]).filter(function(p){return p.id!==pid&&p.publishing});
others.forEach(function(p){if(watching[p.id]){update(p);}else watch(p);});
Object.keys(watching).forEach(function(id){if(!others.some(function(p){return p.id===id}))unwatch(id);});
layout();}
function tileFor(p){var t=document.createElement("div");t.className="tile";var v=document.createElement("video");v.autoplay=true;v.playsInline=true;v.setAttribute("playsinline","");t.appendChild(v);var ini=document.createElement("div");ini.className="initial";t.appendChild(ini);var n=document.createElement("div");n.className="name";t.appendChild(n);tiles[p.id]={el:t,video:v,initial:ini,name:n,screen:!!p.screen,label:p.name};update(p);return t;}
function update(p){var t=tiles[p.id];if(!t)return;t.label=p.name;t.name.textContent=(p.screen?p.name+"'s screen":p.name)+(p.muted&&!p.screen?" · Muted":"");t.initial.textContent=(p.name||"?").slice(0,1).toUpperCase();t.initial.classList.toggle("hidden",!!p.hasVideo||!!p.screen);}
function watch(p){var peer=new RTCPeerConnection(iceConfig());watching[p.id]=peer;peer.addTransceiver("audio",{direction:"recvonly"});peer.addTransceiver("video",{direction:"recvonly"});tileFor(p);
peer.addEventListener("track",function(e){var tl=tiles[p.id];if(!tl)return;var s=e.streams&&e.streams[0];if(!s){s=tl.video.srcObject||new MediaStream();s.addTrack(e.track);}tl.video.srcObject=s;if(tl.video.play)tl.video.play().catch(function(){});layout();});
peer.createOffer().then(function(o){return peer.setLocalDescription(o)}).then(function(){return gathered(peer)}).then(function(){return api("watch","POST",{participantId:pid,publisherId:p.id,sdp:peer.localDescription.sdp})}).then(function(r){if(r.status!==200)throw new Error("watch");return peer.setRemoteDescription({type:"answer",sdp:r.body.sdp});}).catch(function(){unwatch(p.id);});
layout();}
function unwatch(id){var peer=watching[id];if(peer){try{peer.close()}catch(e){}}delete watching[id];var t=tiles[id];if(t){if(t.el.parentNode)t.el.parentNode.removeChild(t.el);delete tiles[id];}layout();}
function layout(){var ids=Object.keys(tiles),stageId=null;ids.forEach(function(id){if(tiles[id].screen)stageId=id;});var grid=$("grid"),stage=$("stage");
if(stageId){var st=tiles[stageId];stage.classList.remove("hidden");if($("stageVideo").srcObject!==st.video.srcObject)$("stageVideo").srcObject=st.video.srcObject;$("stageName").textContent=st.label+"'s screen";grid.className="strip";}else{stage.classList.add("hidden");$("stageVideo").srcObject=null;grid.className="grid";}
var shown=ids.filter(function(id){return id!==stageId});shown.forEach(function(id){var el=tiles[id].el;if(el.parentNode!==grid)grid.appendChild(el);});
if(stageId&&tiles[stageId].el.parentNode)tiles[stageId].el.parentNode.removeChild(tiles[stageId].el);
var n=shown.length,cols=n<=1?1:(window.innerWidth>700?Math.min(3,n):2);grid.style.setProperty("--cols",String(cols));grid.classList.toggle("hidden",n===0&&!!stageId);}
window.addEventListener("resize",layout);
// Closing the tab: tell the server at once (keepalive lets the request finish); otherwise it notices the dropped connection within a minute.
window.addEventListener("pagehide",function(){if(pid&&!closed&&token){try{fetch(base+"leave",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify({participantId:pid})});}catch(e){}}});
// A reload keeps your place: the token is kept for this tab only, and only while the meeting lasts.
startPreview().then(function(){var t=saved();if(t&&!closed&&!token){token=t;show("waiting");poll();}});
})();
</script></body></html>`;
}

/** The same page for a bad, expired, switched-off or unknown link. Says nothing about whether a meeting existed. */
export function notFoundPage(nonce, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><title>This link doesn't work</title>
<style nonce="${nonce}">${CSS}</style></head><body><main><div class="card"><div class="done">
<h1>This link doesn't work</h1>
<p class="muted">${esc(message || "The meeting may have ended, or the link was turned off or copied wrong. Ask the person who invited you for a new link.")}</p>
</div></div></main></body></html>`;
}
