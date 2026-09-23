const PROGRESS_ENTRY = 'pivane-task-progress';
const MAX_STEPS = 20, MAX_STEP_LENGTH = 200, MAX_EXPLANATION_LENGTH = 1000;
const STATUSES = ['pending', 'in_progress', 'completed'];

// A complete replacement, never a patch: replay and branch restoration have no
// dependency on a browser cache or a previous tool result surviving compaction.
function validatePlan(input) {
    if (!input || !Array.isArray(input.plan) || input.plan.length > MAX_STEPS) throw new Error('plan must contain 0–20 steps');
    const plan = input.plan.map(item => {
        if (!item || typeof item.step !== 'string' || !item.step.trim() || item.step.length > MAX_STEP_LENGTH
            || !STATUSES.includes(item.status)) throw new Error('Each step needs a non-empty description of at most 200 characters and a valid status');
        return { step: item.step.trim(), status: item.status };
    });
    if (plan.filter(item => item.status === 'in_progress').length > 1) throw new Error('At most one step may be in_progress');
    if (input.explanation != null && (typeof input.explanation !== 'string' || input.explanation.length > MAX_EXPLANATION_LENGTH))
        throw new Error('explanation must be at most 1000 characters');
    return { plan, explanation: input.explanation?.trim() || '' };
}

function progressValue(data) {
    if (!data || data.version !== 1 || typeof data.id !== 'string' || !data.id || data.id.length > 80) return null;
    try { return { version: 1, id: data.id, ...validatePlan(data) }; } catch { return null; }
}

function currentProgress(sessionManager) {
    // An invalid latest entry hides the card rather than reviving an older plan.
    const entry = sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === PROGRESS_ENTRY);
    return progressValue(entry?.data);
}

module.exports = { PROGRESS_ENTRY, MAX_STEPS, MAX_STEP_LENGTH, MAX_EXPLANATION_LENGTH, STATUSES, validatePlan, progressValue, currentProgress };
