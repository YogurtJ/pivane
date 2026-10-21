const test = require('node:test');
const assert = require('node:assert/strict');
const { askUserQuestion, normalizeQuestions } = require('../server/pi-user-question');
const plan = { question: 'Which plan?', header: 'Plan', options: [{ label: 'A', description: 'Fast' }, { label: 'B' }] };
const input = { questions: [plan] };
const ui = overrides => ({ hasUI: true, ui: { select: async () => undefined, input: async () => undefined, ...overrides } });

test('choices, typed answers on a select and skipped questions keep explicit meaning', async () => {
    const calls = [];
    const context = ui({ select: async (title, options) => { calls.push({ title, options }); return 'B'; } });
    assert.deepEqual(await askUserQuestion(input, context), { status: 'answered', cancelled: false,
        answers: [{ question: 'Which plan?', header: 'Plan', answer: 'B', selectedIndex: 1, custom: false, skipped: false }] });
    assert.deepEqual(calls[0], { title: 'Which plan?', options: ['A', 'B', '其他 / Other'] }, 'the generic dialog keeps an explicit Other entry');
    context.ui.select = async () => '  My own plan  ';
    assert.deepEqual((await askUserQuestion(input, context)).answers[0], { question: 'Which plan?', header: 'Plan', answer: 'My own plan', selectedIndex: null, custom: true, skipped: false });
    context.ui.select = async () => '';
    const skipped = await askUserQuestion(input, context);
    assert.equal(skipped.status, 'answered'); assert.deepEqual(skipped.answers[0], { question: 'Which plan?', header: 'Plan', answer: null, selectedIndex: null, custom: false, skipped: true });
    context.ui.select = async () => ' A ';
    assert.equal((await askUserQuestion(input, context)).answers[0].selectedIndex, 0, 'typed text equal to a label selects it');
});

test('the generic Other path, free-text questions and several questions share one call', async () => {
    const seen = [];
    const context = ui({
        select: async (title, options) => { seen.push(['select', title]); return title === 'Which plan?' ? options.at(-1) : 'Dark'; },
        input: async title => { seen.push(['input', title]); return title === 'Which plan?' ? 'Hybrid' : ''; }
    });
    const result = await askUserQuestion({ questions: [plan, { question: 'Theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }, { question: 'Anything else?' }] }, context);
    assert.deepEqual(seen, [['select', 'Which plan?'], ['input', 'Which plan?'], ['select', 'Theme?'], ['input', 'Anything else?']]);
    assert.deepEqual(result.answers.map(answer => [answer.answer, answer.custom, answer.skipped]), [['Hybrid', true, false], ['Dark', false, false], [null, false, true]]);
});

test('cancellation, timeout, no UI and stopping return no answers and never grant consent', async () => {
    for (const question of [input, { questions: [{ question: 'Text?' }] }]) {
        const result = await askUserQuestion(question, ui());
        assert.deepEqual(result, { status: 'cancelled', cancelled: true, answers: [] });
    }
    let asked = 0;
    const partial = await askUserQuestion({ questions: [plan, { question: 'Second?' }] }, ui({ select: async () => { asked++; return 'A'; } }));
    assert.equal(asked, 1); assert.deepEqual(partial.answers, [], 'answers before a cancellation are not returned');
    assert.equal((await askUserQuestion(input, { hasUI: false })).status, 'unavailable');
    const waiting = ui({ select: (_title, _options, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true })) });
    const timed = await askUserQuestion({ ...input, timeoutMs: 1000 }, waiting); assert.equal(timed.status, 'timed_out'); assert.deepEqual(timed.answers, []);
    const controller = new AbortController(), stopped = askUserQuestion(input, waiting, controller.signal); controller.abort();
    assert.equal((await stopped).status, 'aborted');
});

test('invalid inputs and forged responses fail explicitly', async () => {
    const strict = { questions: [{ ...plan, allowCustom: false }] };
    assert.deepEqual(normalizeQuestions(strict).questions[0].allowCustom, false);
    for (const bad of [{}, { questions: [] }, { questions: [plan, plan] }, { questions: Array(5).fill(0).map((_, i) => ({ question: 'Q' + i })) },
        { questions: [{ question: ' ' }] }, { questions: [{ question: 'Q', options: [{ label: 'A' }, { label: 'A' }] }] },
        { questions: [{ question: 'Q', options: [{ label: 'A' }] }] }, { ...input, timeoutMs: 0 }, { questions: [{ question: 'Q', header: 'x'.repeat(25) }] }]) {
        await assert.rejects(askUserQuestion(bad, ui()), /Invalid ask_user_question input/);
    }
    await assert.rejects(askUserQuestion(strict, ui({ select: async () => 'not an option' })), /not one of/);
    await assert.rejects(askUserQuestion(input, ui({ select: async () => 'x'.repeat(4001) })), /at most 4000/);
    await assert.rejects(askUserQuestion(input, ui({ select: async () => 42 })), /must be text/);
});

test('the web panel recognises only requests that match the running call exactly', () => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const context = {}; vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/pi-user-question.js'), 'utf8'), context);
    const { questionsOf, requestFits } = context.PiUserQuestion;
    const [first, second] = questionsOf({ questions: [plan, { question: ' Notes? ' }] });
    assert.equal(first.allowCustom, true); assert.equal(second.question, 'Notes?');
    assert.equal(requestFits({ method: 'select', title: 'Which plan?', options: ['A', 'B', '其他 / Other'] }, first), true);
    assert.equal(requestFits({ method: 'select', title: 'Which plan?', options: ['A', 'B'] }, first), false, 'a different option set is not ours');
    assert.equal(requestFits({ method: 'select', title: 'Other plan?', options: ['A', 'B', '其他 / Other'] }, first), false);
    assert.equal(requestFits({ method: 'input', title: 'Which plan?' }, first), false, 'the generic Other input stays with the dialog');
    assert.equal(requestFits({ method: 'input', title: 'Notes?' }, second), true);
    const [strict] = questionsOf({ questions: [{ ...plan, allowCustom: false }] });
    assert.equal(requestFits({ method: 'select', title: 'Which plan?', options: ['A', 'B'] }, strict), true);
    for (const args of [null, {}, { questions: [] }, { questions: [plan, plan] }, { questions: [{ question: 'Q', options: [{ label: '' }, { label: 'B' }] }] }]) assert.equal(questionsOf(args), null);
});
