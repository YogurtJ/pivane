// Optional capabilities are installed separately from Pivane's required dependencies.
// Keep versions exact; adding an entry also requires an adapter/validation review.
// compatibleVersions lists releases whose settings keys and host protocols were
// reviewed; older compatible releases can be upgraded to `version` on request.
module.exports = Object.freeze([
    Object.freeze({ id: 'subagents', name: 'pi-subagents', version: '0.71.0', source: 'npm:pi-subagents@0.71.0',
        compatibleVersions: Object.freeze(['0.69.0', '0.70.0', '0.70.1', '0.71.0']) })
]);
