'use strict';

const { WebSocket } = require('ws');

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_SHELL_BUFFERED_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 1000;
// Conservative RFC 6455 header allowance, including a possible mask.
const FRAME_OVERHEAD = 14;

function createWebSocketSender({ maxBufferedBytes = MAX_BUFFERED_BYTES,
    maxShellBufferedBytes = Math.min(MAX_SHELL_BUFFERED_BYTES, maxBufferedBytes), closeGraceMs = CLOSE_GRACE_MS } = {}) {
    for (const value of [maxBufferedBytes, maxShellBufferedBytes, closeGraceMs]) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid WebSocket send budget');
    }
    const states = new WeakMap();
    function stateFor(socket) {
        let state = states.get(socket);
        if (!state) {
            state = { blocked: false, large: null, timer: null };
            states.set(socket, state);
            socket.once('close', () => {
                state.blocked = true; state.large = null;
                clearTimeout(state.timer); state.timer = null;
            });
        }
        return state;
    }
    function disconnect(socket, state, code, reason) {
        if (state.blocked) return false;
        state.blocked = true;
        // close() queues its own frame after pending output. Bound that wait too,
        // otherwise a stalled peer would retain the queue for ws's full timeout.
        state.timer = setTimeout(() => {
            state.timer = null;
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }, closeGraceMs);
        state.timer.unref?.();
        try { socket.close(code, reason); }
        catch { socket.terminate(); }
        return false;
    }
    return function safeSend(socket, payload, closing) {
        if (socket.readyState !== WebSocket.OPEN) return false;
        const state = stateFor(socket);
        if (state.blocked) return false;
        if (socket.workspaceAccess && !socket.workspaceAccess.validIdentity(socket.workspaceIdentity)) {
            return disconnect(socket, state, 4401, 'Access expired or revoked');
        }
        const buffered = socket.bufferedAmount || 0;
        // A synchronous write may already have drained before its callback runs.
        if (!buffered) state.large = null;
        const limit = payload.type === 'gateway_shell' ? maxShellBufferedBytes : maxBufferedBytes;
        // Preserve application close meanings (deleted/moved/classified) when
        // their final notification cannot be queued. Normal close stays with the caller.
        const reason = closing?.reason || (payload.type === 'gateway_shell'
            ? 'Shell output consumer too slow; reconnect for snapshot'
            : 'Output backlog exceeded; reconnect for snapshot');
        const pressureCode = closing?.code || 1013;
        const allowance = state.large?.bytes || 0;
        // Check before serialization so an already-stalled peer does not keep
        // paying for large JSON encodings on every native event.
        if (buffered > limit + allowance) return disconnect(socket, state, pressureCode, reason);
        const wire = JSON.stringify(payload);
        const bytes = Buffer.byteLength(wire) + FRAME_OVERHEAD;
        const large = bytes > limit;
        // Large native snapshots remain valid. Admit one when ordinary queued
        // output fits the budget; subsequent output has only a bounded margin.
        if (large ? buffered > limit : buffered + bytes > limit + allowance) {
            return disconnect(socket, state, pressureCode, reason);
        }
        if (socket.readyState !== WebSocket.OPEN || state.blocked) return false;
        const token = large ? { bytes } : null;
        if (token) state.large = token;
        try {
            socket.send(wire, token ? error => {
                if (state.large === token) state.large = null;
                if (error && socket.readyState === WebSocket.OPEN) {
                    disconnect(socket, state, 1011, 'Output delivery failed');
                }
            } : undefined);
            return true;
        } catch {
            if (state.large === token) state.large = null;
            return disconnect(socket, state, 1011, 'Output delivery failed');
        }
    };
}

module.exports = { createWebSocketSender, MAX_BUFFERED_BYTES, MAX_SHELL_BUFFERED_BYTES, CLOSE_GRACE_MS };
