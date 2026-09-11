// Seed/check durable state through the real isolated application's APIs.
const assert=require('node:assert/strict');
const base=process.env.PI_RELEASE_TEST_URL;
assert.ok(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !base.endsWith(':3001'));
const cwd=process.env.PI_RELEASE_PROJECT_DIR || '/home/node/pi-workspace/projects/demo';
require('./guard.cjs').rehearsalRoot(cwd,true);
const projectRoot=require('node:path').dirname(cwd);
const mode=process.argv[2];assert.ok(['seed','verify'].includes(mode));
async function api(url,method='GET',body){const r=await fetch(base+url,{method,headers:{Origin:base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,`${r.status} ${JSON.stringify(data)}`);return data;}
(async()=>{
 assert.deepEqual((await api('/api/pi/status')).projectRoots,[projectRoot]);
 assert.equal((await api('/api/pi/settings/models')).customProviders.find(p=>p.id==='release-fixture')?.baseUrl,'http://127.0.0.1:8089/v1');
 assert.equal((await api('/api/pi/files/content?'+new URLSearchParams({cwd,path:'release-marker.txt'}))).content,'pi-release-rehearsal-v1\n');
 const sessions=(await api('/api/pi/sessions?'+new URLSearchParams({cwd}))).sessions;assert.equal(sessions.length,1);const id=sessions[0].id;
 if(mode==='seed'){
  await api(`/api/pi/sessions/${id}`,'PATCH',{cwd,name:'安装恢复验收'});
  await api('/api/pi/projects/pin','PATCH',{cwd,pinned:true});
  await api('/api/pi/settings/media-agent','PATCH',{provider:'release-fixture',modelId:'release-fixture'});
  await api('/api/pi/media/lab/models','POST',{confirmed:true,model:{id:'release-manual',name:'Recovery manual model',kind:'image',adapter:'manual',parameters:{prompt:{type:'textarea',required:true}}}});
  const job=await api(`/api/pi/sessions/${id}/deferred`,'POST',{cwd,id:require('node:crypto').randomUUID(),dueAt:Date.now()+86400000,message:'DO NOT DISPATCH: paused recovery fixture'});
  await api(`/api/pi/sessions/${id}/deferred/${job.id}`,'PATCH',{cwd,revision:job.revision,action:'pause'});
 }else{
  assert.equal(sessions[0].name,'安装恢复验收');
  assert.deepEqual((await api('/api/pi/activity')).pinnedProjects,[cwd]);
  const models=await api('/api/pi/settings/models');
  assert.equal(models.preferences.defaultProvider,'release-fixture');assert.equal(models.preferences.mediaAgent.provider,'release-fixture');
  assert.ok(models.providers.find(p=>p.id==='release-fixture').configured);
  const test=await api('/api/pi/settings/models/test','POST',{provider:'release-fixture',modelId:'release-fixture',prompt:'Synthetic restored credential check'});
  assert.ok(JSON.stringify(test).includes('RELEASE_REHEARSAL_OK'));
  const lab=await api('/api/pi/media/lab');assert.ok(JSON.stringify(lab).includes('release-manual'));
  const jobs=(await api(`/api/pi/sessions/${id}/deferred?`+new URLSearchParams({cwd}))).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].status,'paused');
  for(const kind of ['image','video','tts']){
   const history=await api('/api/pi/media/lab/history?kind='+kind);assert.equal(history.length,1);
   const r=await fetch(base+history[0].url);assert.equal(r.status,200);assert.ok((await r.arrayBuffer()).byteLength>40);
  }
  assert.equal((await api('/api/prompts')).length,1);
  const files=await api('/api/pi/composer/files?'+new URLSearchParams({cwd,q:'release-marker'}));assert.ok(JSON.stringify(files).includes('release-marker.txt'));
  const to=new Date().toISOString().slice(0,10),from=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  const usage=await api('/api/pi/settings/usage?'+new URLSearchParams({from,to,timeZone:'UTC'}));
  assert.ok(usage.total.total>0,'native persisted usage must remain positive');assert.equal(usage.coverage.skippedFiles,0);
 }
 console.log(JSON.stringify({mode,status:'passed',sessionId:id,checked:mode==='seed'?'name, pin, planner preference, private model, paused deferred':'name, pin, model preference, restored credential request, private model, paused deferred, all media downloads, saved prompt, ripgrep search'}));
})().catch(e=>{console.error(e);process.exitCode=1;});
