// Synthetic provider for release rehearsals. Never forwards requests or logs credentials.
const http = require('node:http');
const assert = require('node:assert/strict');
let requests = 0;
const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ fixture: 'pi-release-rehearsal-v1', requests, runId: process.env.PI_RELEASE_RUN_ID || null }));
    try {
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer release-fixture-key');
        let bytes = '';
        for await (const chunk of req) { bytes += chunk; assert.ok(bytes.length < 4000000); }
        const body = JSON.parse(bytes); assert.equal(body.model, 'release-fixture'); requests++;
        const text = 'RELEASE_REHEARSAL_OK 中文恢复验证';
        if (!body.stream) {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ id:'fixture', object:'chat.completion', model:body.model, choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}], usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20} }));
        }
        res.writeHead(200, {'Content-Type':'text/event-stream'});
        for (const [delta, finish_reason] of [[{role:'assistant',content:text},null],[{},'stop']]) {
            res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
        }
        res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}})}\n\n`);
        res.end('data: [DONE]\n\n');
    } catch { res.writeHead(400); res.end('Invalid synthetic fixture request'); }
});
server.listen(8089, '127.0.0.1');
