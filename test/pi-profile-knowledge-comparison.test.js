'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createHash } = require('node:crypto');
const compare = require('../server/profile-memory/knowledge-compare');
const { decision } = require('../server/profile-memory/learning-decision');
const { createKnowledgeMemoryTools } = require('../server/profile-memory/tool-mutations');
const { ProfileKnowledgeService } = require('../server/profile-memory/knowledge-service');
const profileId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bundle = process.env.PIVANE_TEST_HERMES_BUNDLE;
const hash = s => createHash('sha256').update(s).digest('hex');

function toolFixture() {
    let revision = 'a'.repeat(64);
    const rows = [{ id: 'b'.repeat(64), revision: 'c'.repeat(64), kind: 'memory', scope: 'profile', target: 'user', category: 'fact',
        state: 'active', content: 'Yummy 是母边境牧羊犬，生日为 2 月 18 日。' },
    { id: 'd'.repeat(64), revision: 'e'.repeat(64), kind: 'memory', scope: 'project', target: 'project', projectKey: hash('/different/project'),
        state: 'active', content: 'Foreign project fact about Yummy.' }];
    const writes = [];
    const service = { snapshot: async () => ({ status: 'ready', revision, items: rows, hasMore: false, capabilities: { memory: true } }),
        mutateFromNative: async (_id, input, source) => { writes.push({ input, source });return {receipt:{id:'r',status:'saved'}}; } };
    const context = { cwd: '/tmp/comparison-project', sessionManager: { getSessionFile: () => '/tmp/comparison-native.jsonl',
        getSessionId: () => 'comparison-session', getBranch: () => [{id:'native-entry'}] } };
    const raw = createKnowledgeMemoryTools(service, profileId);
    return { service, rows, writes, context, raw, revision: value => { revision=value; },
        call: (args, ctx=context) => raw('memory_add',args,undefined,()=>true,ctx) };
}

test('agent create first provides same-profile USER candidates, makes no write, and can choose an existing update', async () => {
    const f=toolFixture(), args={target:'memory',content:'用户养了一只叫 Yummy 的狗。'};
    const result=await f.call(args);
    assert.equal(result.details.comparisonRequired,true);
    assert.equal(result.details.saved,false);
    assert.equal(f.writes.length,0);
    assert.equal(result.details.candidates[0].target,'user');
    assert.match(result.details.candidates[0].content,/2 月 18 日/);
    assert.ok(!result.details.candidates.some(i=>i.scope==='project'),'foreign cwd records never enter a comparison');
    const update=await f.raw('memory_replace',{target:'user',old_text:f.rows[0].content,content:f.rows[0].content+' 喜欢玩球。'},undefined,()=>true,f.context);
    assert.equal(update.details.success,true);
    assert.deepEqual([f.writes[0].input.operation,f.writes[0].input.itemId],['update',f.rows[0].id]);
});

test('create comparison tokens bind arguments, revision, native session and worker lifetime', async () => {
    const f=toolFixture(), args={target:'memory',content:'独立的新资料入口。'};
    const first=await f.call(args), token=first.details.comparisonToken;
    for(const changed of [{...args,content:'Changed fact.'},{...args,target:'user'}]){
        const result=await f.call({...changed,comparisonToken:token});assert.equal(result.details.success,false);
    }
    const foreign={...f.context,sessionManager:{...f.context.sessionManager,getSessionId:()=> 'another-session'}};
    assert.equal((await f.call({...args,comparisonToken:token},foreign)).details.success,false);
    const other=createKnowledgeMemoryTools(f.service,profileId);
    assert.equal((await other('memory_add',{...args,comparisonToken:token},undefined,()=>true,f.context)).details.success,false);
    assert.equal((await f.call({...args,comparisonToken:token.slice(0,-1)+(token.endsWith('0')?'1':'0')})).details.success,false);
    const clock=Date.now;
    try { Date.now=()=>clock()+11*60000; assert.equal((await f.call({...args,comparisonToken:token})).details.success,false); }
    finally { Date.now=clock; }
    f.revision('f'.repeat(64));
    assert.equal((await f.call({...args,comparisonToken:token})).details.success,false);
    assert.equal(f.writes.length,0);
    const current=await f.call(args);
    const saved=await f.call({...args,comparisonToken:current.details.comparisonToken});
    assert.equal(saved.details.success,true);
    assert.equal(f.writes.length,1);
    assert.equal(f.writes[0].input.expectedRevision,'f'.repeat(64));
    assert.equal(Object.hasOwn(f.writes[0].input,'comparisonToken'),false);
});

test('a deterministic duplicate rejection is reported as already represented without claiming a saved receipt', async () => {
    const f=toolFixture();
    f.service.mutateFromNative=async()=>{throw Object.assign(new Error('duplicate'),{status:409,code:'knowledge-duplicate',details:{itemId:f.rows[0].id,target:'user'}});};
    const args={target:'memory',content:'Yummy 的稳定事实。'}, first=await f.call(args);
    const result=await f.call({...args,comparisonToken:first.details.comparisonToken});
    assert.equal(result.details.unchanged,true);assert.equal(result.details.success,true);
    assert.equal(Object.hasOwn(result.details,'receipt'),false);assert.match(result.content[0].text,/Nothing was saved/);
});

test('bounded comparisons mark long content non-editable and reject changing or incomplete scans', async () => {
    const long={id:'a'.repeat(64),revision:'b'.repeat(64),kind:'memory',scope:'profile',target:'user',category:'fact',state:'active',content:'Yummy '+ '长期事实。'.repeat(300)};
    const service={snapshot:async()=>({status:'ready',revision:'c'.repeat(64),items:[{...long,content:long.content.slice(0,512)}],hasMore:false}),getItem:async()=>({status:'ready',item:long})};
    const result=await compare.comparison(service,profileId,{query:'Yummy',bytes:300});
    assert.equal(result.references[0].truncated,true);assert.equal(result.references[0].editable,false);
    assert.equal(decision({action:'update',itemId:'m1',relation:'supplement',category:'fact',addition:'生日是 2 月 18 日。'},result),null);
    let calls=0;service.snapshot=async()=>({status:'ready',revision:(++calls===1?'c':'d').repeat(64),items:[long],hasMore:false});
    await assert.rejects(compare.comparison(service,profileId,{query:'Yummy'}),/changed during comparison/);
    service.snapshot=async()=>({status:'ready',revision:'c'.repeat(64),items:[],hasMore:true});
    await assert.rejects(compare.readRows(service,profileId,{limit:100}),/scan limit/);
});

test('supplements preserve every original fact; corrections and merge suggestions obey offered editable targets', () => {
    const first={id:'a'.repeat(64),revision:'b'.repeat(64),ref:'m1',kind:'memory',scope:'profile',target:'user',category:'fact',state:'active',editable:true,content:'Yummy 是母边境牧羊犬。'};
    const second={...first,id:'c'.repeat(64),ref:'m2',content:'Yummy 的生日为 2 月 18 日。'};
    const context={rows:[first,second],references:[first,second]};
    const supplement=decision({action:'update',itemId:'m1',relation:'supplement',category:'fact',addition:'生日为 2 月 18 日。'},context);
    assert.equal(supplement.content,first.content+'\n生日为 2 月 18 日。');
    assert.equal(supplement.row.id,first.id);
    const correction={action:'update',itemId:'m1',relation:'correction',category:'correction',content:'Yummy 是母边境牧羊犬，生日为 2 月 18 日。'};
    assert.equal(decision(correction,context),null);assert.equal(decision(correction,context,{isCorrection:true}).action,'update');
    assert.equal(decision({...correction,itemId:'m99'},context,{isCorrection:true}),null);
    const merge={action:'propose_merge',itemIds:['m1','m2'],category:'fact',content:'Yummy 是母边牧，生日 2 月 18 日。'};
    assert.equal(decision(merge,context).action,'propose_merge');
    assert.equal(decision(merge,{...context,references:[first,{...second,target:'memory'}]}),null);
    assert.equal(decision({...correction,itemId:'m2'},{...context,references:[first,{...second,editable:false}]},{isCorrection:true}),null);
    assert.equal(decision({content:'Old implicit create protocol.'},context),null);
});

function setup(t){
    const agent=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'pivane-comparison-')));
    t.after(()=>fs.rmSync(agent,{recursive:true,force:true}));
    const profile={id:profileId,enabled:true,memory:{enabled:true,memoryCharLimit:16000,userCharLimit:8000},skills:{learnedEnabled:true}};
    const service=new ProfileKnowledgeService({profiles:{getProfile:async()=>profile,reserve:work=>work()},getAgentDir:async()=>agent,bundlePath:bundle});
    let serial=0;
    const mutate=async fields=>service.mutate(profileId,{requestId:'comparison-'+(++serial),expectedRevision:(await service.snapshot(profileId)).revision,...fields});
    return{service,agent,mutate};
}

test('atomic normalized duplicate guard spans USER/MEMORY, preserves distinct identifiers and protects deleted facts', {skip:!bundle}, async t=>{
    const f=setup(t), saved=await f.mutate({operation:'create',kind:'memory',target:'user',category:'fact',content:'Cafe\u0301 is preferred. <!-- created=2026-01-01, last=2026-01-01 -->'});
    const duplicate=error=>error.status===409&&error.code==='knowledge-duplicate'&&error.details.itemId===saved.item.id&&error.details.target==='user';
    await assert.rejects(f.mutate({operation:'create',kind:'memory',category:'fact',content:'Café is preferred.'}),duplicate);
    const own=await f.mutate({operation:'create',kind:'memory',category:'fact',content:'Uses /A.'});
    await f.mutate({operation:'create',kind:'memory',category:'fact',content:'Uses /a.'});
    await assert.rejects(f.mutate({operation:'update',kind:'memory',itemId:own.item.id,itemRevision:own.item.revision,category:'fact',content:'Café is preferred.'}),duplicate);
    assert.equal((await f.service.getItem(profileId,own.item.id)).item.content,'Uses /A.');
    // Metadata normalization and category changes retain the same fact and remain editable.
    const changed=await f.mutate({operation:'update',kind:'memory',itemId:saved.item.id,itemRevision:saved.item.revision,category:'preference',content:'Café is preferred.'});
    assert.equal(changed.status,'saved');
    await f.mutate({operation:'delete',kind:'memory',itemId:changed.item.id,itemRevision:changed.item.revision});
    await assert.rejects(f.mutate({operation:'create',kind:'memory',target:'user',category:'fact',content:'Cafe\u0301 is preferred.'}),/cannot be relearned/);
    const preference=await f.mutate({operation:'create',kind:'memory',target:'user',category:'preference',content:'Cafe\u0301 is a favorite. <!-- created=2026-01-01, last=2026-01-01 -->'});
    const replacement=await f.mutate({operation:'update',kind:'memory',itemId:preference.item.id,itemRevision:preference.item.revision,category:'preference',content:'Tea is a favorite.'});
    await assert.rejects(f.mutate({operation:'create',kind:'memory',category:'fact',content:'Café is a favorite.'}),/cannot be relearned/);
    const undo=await f.mutate({operation:'undo',kind:'memory',receiptId:replacement.receipt.id});
    assert.equal(undo.item.state,'active');
    await f.mutate({operation:'update',kind:'memory',itemId:undo.item.id,itemRevision:undo.item.revision,category:'fact',content:undo.item.content});
});

test('parallel cross-target creates publish at most one entry and a renamed identical workflow is refused', {skip:!bundle}, async t=>{
    const f=setup(t), snapshot=await f.service.snapshot(profileId);
    const results=await Promise.allSettled(['user','memory'].map(target=>f.service.mutate(profileId,{requestId:'parallel-'+target,expectedRevision:snapshot.revision,operation:'create',kind:'memory',target,category:'fact',content:'One durable fact.'})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const body='# first-name\n\n## When to use\nWhen checking a bounded study-data archive.\n\n## Procedure\n- Compare original source hashes and stable IDs.\n- Verify full question and solution pairs.\n\n## Verification\n- Confirm every selected page and source link.';
    const skill=await f.mutate({operation:'create',kind:'skill',name:'first-name',description:'Archive checks',content:body});
    await assert.rejects(f.mutate({operation:'create',kind:'skill',name:'different-name',description:'The same archive workflow',content:body.replace('# first-name','# different-name')}),error=>error.code==='knowledge-duplicate'&&error.details.itemId===skill.item.id);
    const listed=await f.service.snapshot(profileId,{kind:'skill'});
    assert.equal(listed.items.filter(i=>i.state==='active').length,1);
    const mechanics='Check the exact target and current version. Keep unrelated records intact. Read the result back and compare its full content with the intended change.';
    await f.mutate({operation:'create',kind:'skill',name:'app-one',description:'Use only for app one',content:mechanics});
    await f.mutate({operation:'create',kind:'skill',name:'app-two',description:'Use only for app two',content:mechanics});
    // Legacy profile-owned files without journal records are compared by verified bytes too.
    const legacyDir=path.join(f.agent,'pivane-profiles','data',profileId,'skills','legacy-workflow');
    fs.mkdirSync(legacyDir,{recursive:true,mode:0o700});
    const legacyBody=body.replace('bounded study-data archive','legacy study-data source');
    fs.writeFileSync(path.join(legacyDir,'SKILL.md'),'---\nname: legacy-workflow\ndescription: Legacy checks\n---\n'+legacyBody,{mode:0o600});
    await assert.rejects(f.mutate({operation:'create',kind:'skill',name:'legacy-copy',description:'Legacy checks again',content:legacyBody.replace('# first-name','# legacy-copy')}),error=>error.code==='knowledge-duplicate');
});
