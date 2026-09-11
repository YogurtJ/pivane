const { randomUUID } = require('node:crypto');

// Ephemeral presentation state only. Pi remains the owner of the live queue.
class PiRuntimeControls {
    constructor() {
        this.runtimeId = randomUUID();
        this.revision = 0;
        this.queue = { steering: [], followUp: [] };
        this.recoveries = [];
        this.stopping = false;
        this.statuses = new Map();
        this.widgets = new Map();
        this.drafts = [];
        this.draftOverflow = false;
        this.title = '';
    }

    snapshot() {
        return { runtimeId: this.runtimeId, revision: this.revision, queue: this.queue,
            recoveries: this.recoveries, stopping: this.stopping,
            drafts: this.drafts, draftOverflow: this.draftOverflow,
            extension: { title: this.title, statuses: [...this.statuses], widgets: [...this.widgets] } };
    }

    changed() { this.revision++; }

    handle(event) {
        if (event.type === 'queue_update') {
            this.queue = { steering: event.steering || [], followUp: event.followUp || [] };
        } else if (event.type === 'extension_ui_request') {
            const text = value => typeof value === 'string' ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 16000) : '';
            const key = value => typeof value === 'string' && value.length <= 256 ? value : null;
            if (event.method === 'set_editor_text') {
                if (typeof event.text !== 'string' || !event.text) return false;
                if (this.drafts.some(d => d.id === event.id)) return false;
                if (this.drafts.length >= 8 || event.text.length > 65536) this.draftOverflow = true;
                else this.drafts.push({ id: event.id || randomUUID(), text: event.text });
            } else if (event.method === 'setTitle') this.title = text(event.title).slice(0, 512);
            else if (event.method === 'setStatus') {
                const name = key(event.statusKey);
                if (name === null) return false;
                if (event.statusText == null) this.statuses.delete(name);
                else if (this.statuses.has(name) || this.statuses.size < 64) this.statuses.set(name, text(event.statusText));
            } else if (event.method === 'setWidget') {
                const name = key(event.widgetKey);
                if (name === null) return false;
                if (event.widgetLines == null) this.widgets.delete(name);
                else if (Array.isArray(event.widgetLines) && (this.widgets.has(name) || this.widgets.size < 32)) {
                    this.widgets.set(name, { lines: event.widgetLines.slice(0, 100).map(text).join('\n').slice(0, 32000),
                        placement: event.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' });
                }
            } else return false;
        } else return false;
        this.changed();
        return true;
    }

    ackDraft(id) {
        this.drafts = this.drafts.filter(draft => draft.id !== id);
        if (!this.drafts.length) this.draftOverflow = false;
        this.changed();
    }

    reserveRecovery() {
        if (this.recoveries.length >= 32 || Buffer.byteLength(JSON.stringify([...this.recoveries, this.queue])) > 32 * 1024 * 1024) {
            throw new Error('取回列表已满，请先处理已取回内容');
        }
        const recovery = { id: randomUUID(), status: 'pending', ...this.queue };
        this.recoveries.push(recovery);
        this.changed();
        return recovery;
    }

    finishRecovery(recovery, queue) {
        recovery.steering = queue.steering || [];
        recovery.followUp = queue.followUp || [];
        recovery.status = 'recovered';
        if (!recovery.steering.length && !recovery.followUp.length) this.recoveries = this.recoveries.filter(item => item !== recovery);
        this.changed();
    }

    acknowledge(id) {
        const item = this.recoveries.find(item => item.id === id);
        if (!item || item.status === 'pending') throw new Error('取回内容不存在或操作尚未结束');
        this.recoveries = this.recoveries.filter(item => item !== item);
        this.changed();
    }
}

module.exports = { PiRuntimeControls };
