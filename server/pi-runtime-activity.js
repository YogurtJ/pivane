function isCompactionNoop(event) {
    return /^Compaction failed: (Already compacted|Nothing to compact \(session too small\))$/.test(event.errorMessage || '');
}

// In-memory projection of RPC lifecycle events; never a second session history.
class PiRuntimeActivity {
    constructor() {
        this.running = false;
        this.compacting = false;
        this.retrying = false;
        this.tools = new Set();
        this.outcome = null;
        this.waitingCount = 0;
        this.replyReady = false;
    }

    handle(event) {
        switch (event.type) {
            case 'agent_start':
                this.running = true;
                this.outcome = null;
                this.replyReady = false;
                break;
            case 'agent_settled': {
                const completed = this.running && this.replyReady && !this.outcome;
                this.replyReady = false;
                this.running = false;
                this.compacting = false;
                this.retrying = false;
                this.tools.clear();
                return completed;
            }
            case 'tool_execution_start':
                this.tools.add(event.toolCallId);
                break;
            case 'tool_execution_end':
                this.tools.delete(event.toolCallId);
                break;
            case 'compaction_start':
                this.compacting = true;
                this.outcome = null;
                break;
            case 'compaction_end':
                this.compacting = false;
                if (event.errorMessage) this.outcome = isCompactionNoop(event) ? null : 'error';
                else if (event.aborted) this.outcome = 'stopped';
                break;
            case 'auto_retry_start':
            case 'summarization_retry_scheduled':
                this.retrying = true;
                break;
            case 'summarization_retry_attempt_start':
            case 'summarization_retry_finished':
                this.retrying = false;
                break;
            case 'auto_retry_end':
                this.retrying = false;
                this.outcome = event.success ? null : 'error';
                break;
            case 'message_end':
                if (event.message?.role === 'assistant') {
                    const reason = event.message.stopReason;
                    this.outcome = reason === 'error' ? 'error' : reason === 'aborted' ? 'stopped' : null;
                    const content = event.message.content;
                    this.replyReady = ['stop', 'length'].includes(reason) && (typeof content === 'string'
                        ? Boolean(content.trim()) : Array.isArray(content) && content.some(block => block.type === 'text' && block.text?.trim()));
                }
                break;
        }
    }

    snapshot() {
        const busy = this.waitingCount > 0 || this.running || this.compacting || this.retrying || this.tools.size > 0;
        const phase = this.waitingCount ? 'waiting' : this.retrying ? 'retrying' : this.compacting ? 'compacting'
            : this.tools.size ? 'tool' : this.running ? 'running' : this.outcome || 'idle';
        return { phase, busy };
    }
}

module.exports = { PiRuntimeActivity, isCompactionNoop };
