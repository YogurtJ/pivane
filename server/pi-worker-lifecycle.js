// The worker owns the meaning of its operation flags. Gateways and sweepers
// consume these projections instead of maintaining separate lists of fields.
function workerLifecycle(worker) {
    const activity = worker.activity.snapshot();
    const operations = [];
    if (worker.navigation.busy || worker.operation) operations.push('navigation');
    if (worker.shell.busy) operations.push('shell');
    if (worker.controlPending) operations.push('control');
    if (worker.promptPending) operations.push('prompt');
    if (worker.compactPending) operations.push('compaction');
    if (worker.modelChangesPending || worker.modelCatalog.inflight) operations.push('model');
    if (worker.titleResults.size) operations.push('title-read');
    if (worker.resourceResults.size) operations.push('resources');
    if (worker.historyPending || worker.historyWriting) operations.push('history');
    if (worker.contextCapture) operations.push('context');
    const blockers = [...operations];
    if (activity.busy) blockers.push('agent');
    if (worker.disposed || worker.restarting) blockers.push('lifecycle');
    if (worker.modelChangeUncertain) blockers.push('model-uncertain');
    if (worker.titleGeneration) blockers.push('title-generation');
    if (worker.pendingUi.size) blockers.push('confirmation');
    if (worker.controls.recoveries.length || worker.controls.drafts.length) blockers.push('unsaved-controls');
    if (worker.controls.queue.steering.length || worker.controls.queue.followUp.length) blockers.push('queue');
    return {
        activity: { ...activity, busy: activity.busy || operations.length > 0,
            phase: !activity.busy && operations.length ? 'running' : activity.phase },
        blockers
    };
}

module.exports = { workerLifecycle };
