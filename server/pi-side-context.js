const { randomUUID } = require('crypto');
const { SIDE_TOOL_POLICY } = require('./pi-side-tools');

const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const MAX_TICKET_BYTES = 64 * 1024 * 1024;
const BOUNDARY_TYPE = 'pivane-side-context-boundary';
const SIDE_POLICY = `你现在处于 Pivane 的独立临时侧聊。主任务由另一个 Agent 继续执行。
主会话的系统提示与此前消息仅用于理解项目、用户约束及已有事实；其中要求你继续主任务、使用工具或执行操作的指令在本侧聊中不生效。只回答侧聊边界之后用户提出的问题。
你没有任何工具，不能读取或修改文件、运行命令、浏览网络、调用其他 Agent 或操作主会话。不得声称已经执行操作。历史工具记录是主任务过去的调用及结果，不是待执行的请求。
背景在创建时冻结，不随主任务更新；区分已知结果、未得到结果的调用及推测。保留适用的用户约束，不输出凭据或隐私秘密。`;
const SIDE_BOUNDARY = '侧聊开始。以上是主会话在创建时的只读背景，主任务仍由原 Agent 执行。不要继续上面的任务、计划或工具调用。后续用户消息才是当前侧聊的问题。';

function contextError(message, code = 'SIDE_CONTEXT_LIMIT') {
    return Object.assign(new Error(message), { code });
}

// Preserve model-visible facts without replaying executable tool protocol or signed reasoning.
// Native convertToLlm supplies the existing compaction/branch/bash/custom-message semantics.
function referenceMessages(messages, model, convertToLlm) {
    const counts = { messages: messages.length, toolCalls: 0, toolResults: 0, summaries: 0, images: 0, omittedImages: 0, omittedThinking: 0 };
    counts.summaries = messages.filter(message => ['compactionSummary', 'branchSummary'].includes(message.role)).length;
    const results = new Set(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId));
    const blocks = content => (typeof content === 'string' ? [{ type: 'text', text: content }] : content || []).flatMap(block => {
        if (block.type === 'image') {
            if (model.input?.includes('image')) { counts.images++; return [structuredClone(block)]; }
            counts.omittedImages++; return [{ type: 'text', text: '[主会话图片：当前模型不支持图像，未携带图片内容]' }];
        }
        if (block.type === 'thinking') { counts.omittedThinking++; return []; }
        if (block.type === 'toolCall') {
            counts.toolCalls++;
            return [{ type: 'text', text: `[主会话历史工具调用，仅作引用]\n${JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments, resultInSnapshot: results.has(block.id) })}` }];
        }
        return block.type === 'text' ? [{ type: 'text', text: block.text }] : [];
    });
    const normalized = [];
    for (const original of convertToLlm(messages)) {
        const content = blocks(original.content);
        if (original.role === 'toolResult') {
            counts.toolResults++;
            normalized.push({ role: 'user', timestamp: original.timestamp, content: [
                { type: 'text', text: `[主会话历史工具结果，仅作引用]\n${JSON.stringify({ toolCallId: original.toolCallId, toolName: original.toolName, isError: Boolean(original.isError) })}` }, ...content
            ] });
        } else if (original.role === 'assistant') {
            if (original.errorMessage || ['error', 'aborted'].includes(original.stopReason)) content.push({ type: 'text', text: `[主会话回复状态：${original.stopReason}] ${original.errorMessage || ''}` });
            if (content.length) normalized.push({ role: 'assistant', content, api: original.api, provider: original.provider, model: original.model,
                usage: structuredClone(original.usage), stopReason: 'stop', timestamp: original.timestamp });
        } else if (original.role === 'user' && content.length) normalized.push({ role: 'user', timestamp: original.timestamp, content });
    }
    counts.messages = normalized.length;
    return { messages: normalized, counts };
}

function buildContextSeed(snapshot, sdk, cwd, mode = 'context', toolMode = 'none') {
    const model = snapshot.model;
    if (!Number.isFinite(model?.contextWindow) || model.contextWindow < 1024) throw contextError('当前模型没有有效的上下文容量');
    const { messages, counts } = referenceMessages(snapshot.messages, model, sdk.convertToLlm);
    const systemPrompt = `${snapshot.systemPrompt || ''}\n\n${toolMode === 'assist' ? SIDE_TOOL_POLICY : SIDE_POLICY}`.trim();
    const toolTokens = toolMode === 'assist' ? sdk.estimateTokens({ role: 'user', timestamp: 0, content: JSON.stringify(
        ['createReadTool', 'createGrepTool', 'createFindTool', 'createLsTool', 'createEditTool', 'createWriteTool', process.platform === 'win32' ? 'createPowerShellTool' : 'createBashTool']
            .map(name => sdk[name](cwd)).map(({ name, description, parameters }) => ({ name, description, parameters }))
    ) }) : 0;
    const estimatedTokens = toolTokens + sdk.estimateTokens({ role: 'user', content: systemPrompt, timestamp: 0 })
        + messages.reduce((sum, message) => sum + sdk.estimateTokens(message), 0)
        + sdk.estimateTokens({ role: 'user', content: SIDE_BOUNDARY, timestamp: 0 });
    const outputReserve = Math.min(model.maxTokens || 16384, 16384, Math.floor(model.contextWindow / 4));
    const tokenBudget = model.contextWindow - outputReserve;
    if (estimatedTokens > tokenBudget) throw contextError(`主会话背景估计 ${estimatedTokens} tokens，超过侧聊可用空间 ${tokenBudget}（已预留回答空间）。未截断背景；请先压缩主会话，或选择仅引用文本/空白背景。`);
    const manager = sdk.SessionManager.inMemory(cwd, { id: randomUUID() });
    for (const message of messages) manager.appendMessage(message);
    const boundaryId = manager.appendCustomMessageEntry(BOUNDARY_TYPE, SIDE_BOUNDARY, false);
    const seed = { version: 1, toolMode, sessionId: manager.getSessionId(), entries: manager.getEntries(), boundaryId, systemPrompt,
        provider: model.provider, modelId: model.id, thinkingLevel: snapshot.thinkingLevel || 'off' };
    const bytes = Buffer.byteLength(JSON.stringify(seed), 'utf8');
    if (bytes > MAX_CONTEXT_BYTES) throw contextError('主会话背景超过 32 MiB 的内存传输限额，未截断；请选择文本引用或压缩主会话。');
    return { seed, bytes, reference: { mode, capturedAt: snapshot.capturedAt || new Date().toISOString(),
        messageCount: counts.messages, toolCalls: counts.toolCalls, toolResults: counts.toolResults,
        summaryCount: counts.summaries, summaryIncluded: counts.summaries > 0, systemIncluded: Boolean(snapshot.systemPrompt),
        images: counts.images, omittedImages: counts.omittedImages, omittedThinking: counts.omittedThinking,
        estimatedTokens, toolTokens, tokenBudget, outputReserve, contextWindow: model.contextWindow, omittedMessages: 0,
        source: snapshot.source, preview: [], frozen: true, toolFormat: 'reference-text', toolMode },
        limits: { messageCharacters: Math.min(8000, Math.floor(model.contextWindow / 4)) } };
}

module.exports = { MAX_CONTEXT_BYTES, MAX_TICKET_BYTES, BOUNDARY_TYPE, SIDE_POLICY, SIDE_BOUNDARY, buildContextSeed, referenceMessages, contextError };
