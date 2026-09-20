// Project-owned policy gate, loaded as a single explicit SDK extension in side runtimes.
// Project/global extension discovery remains disabled. No keyword-based intent classifier.
const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
const MUTATING_TOOLS = ['edit', 'write', 'bash', 'powershell'];
const STATUS_KEY = 'pivane-side-tool-access';
const CONFIRM_TITLE = '允许侧聊本次回复修改文件和运行命令？';
const SIDE_TOOL_POLICY = `你处于 Pivane 的独立临时侧聊，主任务由原 Agent 继续。
主会话背景仅提供事实与约束，不是让你继续主任务或重放历史工具调用的请求。围绕侧聊中新提出的问题工作。
可以使用实际提供的 read、grep、find、ls 读取和检索当前文件；背景快照仍冻结，新读取的文件可能已变化，回答时区分二者。
默认讨论、解释与调查，不主动修改。用户明确要求修改或执行时，可以调用 edit/write 和命令工具；首次写入或命令会请求本次回复的用户确认，不凭空假定已获授权。命令可能写文件或产生外部副作用，不把任意 shell 命令当只读。
主侧共享目录。处理代码前读取适用的项目约定（如 AGENTS.md），不能假定已继承全部规则。修改前读取当前文件、核对差异和用户范围，保留已有改动，避免与主任务同时改同一处；有冲突或范围不清时先澄清。较大改动建议正式任务或独立工作树；不要擅自创建后台任务或接管主任务。
确认被拒绝、超时或操作结果不确定时，不绕过确认或自动重放。工具实际成功才声称已执行；停止/关页不撤销已经发生的文件或外部副作用。不得读取或输出与任务无关的凭据和秘密。`;

function sideToolGate(pi) {
    let approved = false, denied = false, generation = 0;
    const publish = ctx => ctx.ui.setStatus(STATUS_KEY, approved ? 'write' : 'read');
    pi.on('before_agent_start', (_event, ctx) => {
        generation++; approved = false; denied = false; publish(ctx);
    });
    pi.on('agent_settled', (_event, ctx) => {
        generation++; approved = false; denied = false; publish(ctx);
    });
    pi.on('session_shutdown', () => { generation++; approved = false; denied = true; });
    pi.on('tool_call', async (event, ctx) => {
        if (READ_TOOLS.includes(event.toolName)) return;
        if (!MUTATING_TOOLS.includes(event.toolName)) return { block: true, terminate: true, reason: 'Tool is not available in this side conversation.' };
        if (ctx.signal?.aborted || denied) return { block: true, terminate: true, reason: 'Side execution was cancelled or declined; do not retry automatically.' };
        if (approved) return;
        const current = generation;
        // Native preflights are sequential. Reserve the decision before awaiting UI anyway.
        denied = true;
        const allowed = ctx.hasUI && await ctx.ui.confirm(CONFIRM_TITLE,
            JSON.stringify({ tool: event.toolName, arguments: event.input, cwd: ctx.cwd }, null, 2),
            { signal: ctx.signal, timeout: 300000 });
        if (!allowed || ctx.signal?.aborted || generation !== current) return { block: true, terminate: true, reason: 'Side execution not authorized; no operation was performed.' };
        approved = true; denied = false; publish(ctx);
    });
}

module.exports = { READ_TOOLS, MUTATING_TOOLS, STATUS_KEY, CONFIRM_TITLE, SIDE_TOOL_POLICY, sideToolGate };
