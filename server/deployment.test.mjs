import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { stageRelease, controlRequest } from './deploy.mjs';
import { startSupervisor, verifyRelease } from './supervisor.mjs';

const fixtureSource = `
import http from 'node:http';
const release = process.env.SERVANT_RELEASE_ID;
const streams = new Set();
let requests = 0;
let probes = 0;
const server = http.createServer((req,res) => {
  const route = new URL(req.url, 'http://local');
  const json = (status, body) => {res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if (route.pathname === '/ready') { probes++; return json(release === 'bad' || (release === 'postbad' && probes > 1) ? 503 : 200, {ok:true, release, deploymentProtocol:1}); }
  if (route.pathname === '/health') return json(200,{ok:true});
  if (route.pathname === '/events') {
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: ready\\ndata: {}\\n\\n');
    streams.add(res);res.on('close',()=>streams.delete(res));return;
  }
  if (route.pathname === '/headers') return json(200,req.headers);
  if (route.pathname === '/slow') {
    requests++;res.writeHead(200,{'Content-Type':'text/plain'});res.write(release+':');
    return setTimeout(()=>{res.end('done');requests--;},250);
  }
  if (route.pathname === '/upload') {
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>json(200,{release,body:Buffer.concat(chunks).toString()}));return;
  }
  json(200,{release});
});
server.requestTimeout=0;
server.listen(0,'127.0.0.1',()=>console.log('[servant] server listening on http://127.0.0.1:'+server.address().port));
process.on('message',m=>{if(m.type==='drain-events') for(const res of streams) res.end();});
process.on('SIGTERM',()=>{for(const res of streams)res.end();server.close(()=>process.exit(0));});
`;

async function until(check) {
  for (let i=0;i<300;i++) { const value=check(); if(value)return value; await sleep(10); }
  throw new Error('Timed out');
}
function removeFixture(directory) {
  const writable = folder => {
    fs.chmodSync(folder,0o700);
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})) if(entry.isDirectory())writable(path.join(folder,entry.name));
  };
  writable(directory);fs.rmSync(directory,{recursive:true,force:true});
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'servant-deploy-'));
  const sourceDir = path.join(directory,'source');
  const runtimeDir = path.join(directory,'runtime');
  const dataDir = path.join(directory,'data');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir,'server.mjs'),fixtureSource);
  fs.writeFileSync(path.join(sourceDir,'package.json'),'{"type":"module"}');
  for(const id of ['one','two','bad','postbad'])stageRelease({sourceDir,runtimeDir,id});
  // A child process can take more than 250 ms to start while the complete
  // suite runs process/crypto fixtures in parallel. Keep failure detection
  // bounded without making scheduler load look like a readiness regression.
  const service = await startSupervisor({runtimeDir,dataDir,port:0,initialRelease:'one',candidateTimeoutMs:2000,restartDelayMs:20,log:{log(){},error(){}}});
  const base=`http://127.0.0.1:${service.proxy.address().port}`;
  t.after(async()=>{await service.close();removeFixture(directory);});
  return {service,base,runtimeDir,sourceDir,directory};
}

test('release staging excludes data, credentials, tests and symlinks and verifies immutable checksums', t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'servant-stage-'));
  t.after(()=>removeFixture(directory));
  const sourceDir=path.join(directory,'source'),runtimeDir=path.join(directory,'runtime');
  fs.mkdirSync(sourceDir);fs.mkdirSync(path.join(sourceDir,'data'));
  fs.writeFileSync(path.join(sourceDir,'server.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(sourceDir,'.env'),'SECRET=never-stage');
  fs.writeFileSync(path.join(sourceDir,'server.test.mjs'),'not shipped');
  fs.writeFileSync(path.join(sourceDir,'encrypted-test-client.mjs'),'not shipped');
  fs.writeFileSync(path.join(sourceDir,'data','state.json'),'secret');
  const staged=stageRelease({sourceDir,runtimeDir,id:'one'});
  assert.deepEqual(fs.readdirSync(staged.directory).sort(),['manifest.json','server.mjs']);
  assert.equal(fs.statSync(path.join(staged.directory,'server.mjs')).mode&0o777,0o400);
  verifyRelease(runtimeDir,'one');
  fs.chmodSync(path.join(staged.directory,'server.mjs'),0o600);
  fs.writeFileSync(path.join(staged.directory,'server.mjs'),'modified');
  assert.throws(()=>verifyRelease(runtimeDir,'one'),/checksum/);
  fs.symlinkSync(path.join(sourceDir,'server.mjs'),path.join(sourceDir,'linked.mjs'));
  assert.throws(()=>stageRelease({sourceDir,runtimeDir,id:'two'}),/regular file/);
});

test('traffic switches without failed requests, old slow responses finish, event feeds reconnect, and rollback works', {timeout:15000},async t=>{
  const f=await fixture(t);
  const stream=await fetch(f.base+'/events');
  const streamBody=stream.text();
  const slow=await fetch(f.base+'/slow');
  const slowBody=slow.text();
  let running=true;
  const results=[];
  const load=(async()=>{while(running){const response=await fetch(f.base+'/');results.push({status:response.status,body:await response.json()});await sleep(2);}})();
  try {
    const changed=await controlRequest(f.runtimeDir,'/deploy',{release:'two'});
    assert.equal(changed.active.release,'two');assert.equal(changed.deploying,false);
    assert.equal(await slowBody,'one:done');
    assert.match(await streamBody,/event: ready/);
    assert.equal((await(await fetch(f.base+'/')).json()).release,'two');
    assert.equal((await controlRequest(f.runtimeDir,'/rollback',{})).active.release,'one');
  } finally {running=false;await load;}
  assert.ok(results.length>5);assert.ok(results.every(r=>r.status===200));
  assert.ok(results.some(r=>r.body.release==='one'));assert.ok(results.some(r=>r.body.release==='two'));
  await until(()=>f.service.status().retiring.length===0);
  assert.equal(fs.statSync(f.service.socketPath).mode&0o777,0o600);
});

test('an upload already assigned to the old API is accepted and completed after the switch', {timeout:10000},async t=>{
  const f=await fixture(t);
  let request;
  const uploaded=new Promise((resolve,reject)=>{
    request=http.request(f.base+'/upload',{method:'POST',headers:{'Content-Length':6}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});
    request.on('error',reject);request.write('abc');
  });
  await until(()=>f.service.status().active.inFlight===1);
  await f.service.deploy('two');
  assert.equal(f.service.status().retiring[0].signaled,false);
  request.end('def');
  assert.deepEqual(await uploaded,{status:200,body:{release:'one',body:'abcdef'}});
  await until(()=>f.service.status().retiring.length===0);
});

test('failed candidates preserve the active release and post-switch smoke failure restores it', {timeout:10000},async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.deploy('bad'),/readiness/);
  assert.equal((await(await fetch(f.base+'/')).json()).release,'one');
  await assert.rejects(f.service.deploy('postbad'),/previous release restored/);
  assert.equal((await(await fetch(f.base+'/')).json()).release,'one');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runtimeDir,'deployment.json'))).activeRelease,'one');
});

test('deployments serialize and active API crashes restart the recorded release', {timeout:10000},async t=>{
  const f=await fixture(t);
  const failed=f.service.deploy('bad');
  await assert.rejects(f.service.deploy('two'),/in progress/);
  await assert.rejects(failed,/readiness/);
  const previousPid=f.service.status().active.pid;
  process.kill(previousPid,'SIGKILL');
  await until(()=>f.service.status().active?.ready&&f.service.status().active.pid!==previousPid);
  assert.equal((await(await fetch(f.base+'/')).json()).release,'one');
});

test('proxy cannot forward local admin routes or administrative headers', {timeout:10000},async t=>{
  const f=await fixture(t);
  for(const route of ['/admin/releases','/%61dmin/releases']){
    const response=await fetch(f.base+route,{headers:{'X-Servant-Admin':'do-not-forward'}});
    assert.equal(response.status,403);await response.text();
  }
  const headers=await(await fetch(f.base+'/headers',{headers:{'X-Servant-Admin':'secret','cf-connecting-ip':'198.51.100.10'}})).json();
  assert.equal(headers['x-servant-admin'],undefined);
  assert.equal(headers['cf-connecting-ip'],'198.51.100.10');
});
