const { randomUUID } = require('node:crypto');
const MAX_TEXT = 512 * 1024, MAX_TOOL = 64 * 1024, MAX_TOOLS = 32;
const clone = value => value == null ? value : structuredClone(value);
// Presentation state only. Completed messages remain owned by Pi, never persisted here.
class PiLiveState {
    constructor() { this.runtimeId = randomUUID(); this.sequence = 0; this.message = null; this.tools = new Map(); this.running = false; this.compacting = false; this.truncated = false; this.characters = 0; }
    state(data) { this.running = Boolean(data.isStreaming); this.compacting = Boolean(data.isCompacting); }
    handle(event) {
        if (event.type === 'agent_start') this.running = true;
        if (event.type === 'agent_settled') { this.running = false; this.message = null; this.tools.clear(); this.truncated = false; }
        if (event.type === 'compaction_start') this.compacting = true;
        if (event.type === 'compaction_end') this.compacting = false;
        if (event.type === 'message_start' && event.message?.role === 'assistant') {
            this.message = { role: 'assistant', timestamp: event.message.timestamp, content: [] }; this.characters = 0; this.truncated = false;
        }
        if (event.type === 'message_update' && this.message) {
            const d = event.assistantMessageEvent, index = d?.contentIndex;
            if (typeof d?.type !== 'string' || !Number.isInteger(index) || index < 0 || index > 1024) { this.truncated = true; return; }
            const blocks = this.message.content;
            const type = d.type.startsWith('thinking') ? 'thinking' : d.type.startsWith('toolcall') ? 'toolCall' : 'text';
            const block = blocks[index] ||= type === 'toolCall' ? { type, id: '', name: '', arguments: '' } : { type, [type]: '' };
            if (d.type === 'toolcall_start') { block.id = d.id; block.name = d.toolName; }
            const field = type === 'toolCall' ? 'arguments' : type;
            if (d.type.endsWith('_delta')) {
                const text = typeof d.delta === 'string' ? d.delta : '', remaining = Math.max(0, MAX_TEXT - this.characters);
                const part = text.slice(0, remaining); block[field] += part; this.characters += part.length;
                if (part.length < text.length) this.truncated = true;
            }
            if (d.type === 'toolcall_end' && d.toolCall) {
                const text = JSON.stringify(d.toolCall.arguments || {});
                block.id = d.toolCall.id; block.name = d.toolCall.name;
                if (text.length <= MAX_TOOL && this.characters - String(block.arguments).length + text.length <= MAX_TEXT) {
                    this.characters += text.length - String(block.arguments).length; block.arguments = clone(d.toolCall.arguments);
                } else this.truncated = true;
            }
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') this.message = null;
        if (event.type === 'message_end' && event.message?.role === 'toolResult') this.tools.delete(event.message.toolCallId);
        if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
            if (!this.tools.has(event.toolCallId) && this.tools.size >= MAX_TOOLS) { this.truncated = true; return; }
            let row = clone(event);
            if (JSON.stringify(row).length > MAX_TOOL) {
                const result = event.partialResult || event.result;
                row = { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError,
                    args: JSON.stringify(event.args || {}).slice(0, 8192),
                    ...(result ? { result: { content: [{ type: 'text', text: '[恢复预览已截断，仅显示输出尾部]\n' + (typeof result.content === 'string' ? result.content : Array.isArray(result.content) ? result.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '').slice(-32768) }] } } : {}) };
                this.truncated = true;
            }
            this.tools.set(event.toolCallId, row);
        }
    }
    snapshot() { return { runtimeId: this.runtimeId, sequence: this.sequence, running: this.running, compacting: this.compacting, message: clone(this.message), tools: clone([...this.tools.values()]), truncated: this.truncated }; }
}
module.exports = { PiLiveState };
