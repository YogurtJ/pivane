'use strict';

// Simulates a caller reading the preflight result and choosing an independent
// create in positive-path fixtures. Gate/binding tests use the raw tool directly.
function withComparison(execute) {
    return async (...args) => {
        const first = await execute(...args);
        if (!first?.details?.comparisonRequired) return first;
        const next = [...args];
        next[1] = { ...args[1], comparisonToken: first.details.comparisonToken };
        return execute(...next);
    };
}
module.exports = { withComparison };
