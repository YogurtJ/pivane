// One ask_user_question call presents 1–4 questions. Each question is a native
// select/input request so other clients keep a working fallback dialog. The
// Pivane panel may answer a select directly with typed text (allowCustom) or an
// empty string (skip); the generic dialog uses the explicit "Other" entry.
const LIMITS = Object.freeze({ questions: 4, question: 1000, header: 24, minOptions: 2, maxOptions: 8, label: 120, description: 240, placeholder: 120, answer: 4000 });
const DEFAULT_TIMEOUT_MS = 600000;
const OTHER = '其他 / Other';
const invalid = detail => new Error(`Invalid ask_user_question input: ${detail}`);
const optionalText = (value, limit, name) => {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.trim().length > limit) throw invalid(`${name} must be text of at most ${limit} characters`);
    return value.trim() || null;
};

function normalizeQuestions(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > LIMITS.questions) {
        throw invalid(`supply 1–${LIMITS.questions} questions`);
    }
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 1800000)) {
        throw invalid('timeoutMs must be an integer from 1000 to 1800000');
    }
    const seen = new Set();
    const questions = input.questions.map(item => {
        if (!item || typeof item !== 'object' || typeof item.question !== 'string') throw invalid('each question needs question text');
        const question = item.question.trim();
        if (!question || question.length > LIMITS.question) throw invalid(`question text must contain 1–${LIMITS.question} characters`);
        if (seen.has(question)) throw invalid('question texts must be unique');
        seen.add(question);
        if (item.allowCustom !== undefined && typeof item.allowCustom !== 'boolean') throw invalid('allowCustom must be a boolean');
        let options = [];
        if (item.options !== undefined) {
            if (!Array.isArray(item.options) || item.options.length < LIMITS.minOptions || item.options.length > LIMITS.maxOptions) {
                throw invalid(`options must contain ${LIMITS.minOptions}–${LIMITS.maxOptions} items`);
            }
            options = item.options.map(option => {
                const value = typeof option === 'string' ? { label: option } : option;
                const label = typeof value?.label === 'string' ? value.label.trim() : '';
                if (!label || label.length > LIMITS.label) throw invalid(`option labels must contain 1–${LIMITS.label} characters`);
                const description = optionalText(value.description, LIMITS.description, 'option description');
                return description ? { label, description } : { label };
            });
            if (new Set(options.map(option => option.label)).size !== options.length) throw invalid('option labels must be unique within a question');
        }
        return {
            question, header: optionalText(item.header, LIMITS.header, 'header'), options,
            // A question without options is a text answer; options allow typed answers unless disabled.
            allowCustom: options.length ? item.allowCustom !== false : true,
            placeholder: optionalText(item.placeholder, LIMITS.placeholder, 'placeholder')
        };
    });
    return { questions, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS };
}

function otherLabel(labels) {
    let other = OTHER;
    while (labels.includes(other)) other += '…';
    return other;
}

async function askUserQuestion(input, context, signal) {
    const { questions, timeoutMs } = normalizeQuestions(input);
    const result = (status, answers = []) => ({ status, cancelled: status !== 'answered', answers });
    if (!context.hasUI) return result('unavailable');
    if (signal?.aborted) return result('aborted');
    const timerController = new AbortController(), deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => timerController.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timerController.signal]) : timerController.signal;
    const ended = () => combined.aborted || Date.now() >= deadline;
    const interrupted = () => result(signal?.aborted ? 'aborted' : timerController.signal.aborted || Date.now() >= deadline ? 'timed_out' : 'cancelled');
    const opts = () => ({ signal: combined, timeout: Math.max(1, deadline - Date.now()) });
    const text = value => {
        if (typeof value !== 'string' || value.length > LIMITS.answer) throw new Error(`The submitted answer must be text of at most ${LIMITS.answer} characters`);
        return value.trim();
    };
    try {
        const answers = [];
        for (const item of questions) {
            const placeholder = item.placeholder || '请输入回答 / Type your answer';
            let answer = null, selectedIndex = null, custom = false;
            if (item.options.length) {
                const labels = item.options.map(option => option.label), other = otherLabel(labels);
                const selected = await context.ui.select(item.question, item.allowCustom ? [...labels, other] : labels, opts());
                if (ended() || selected === undefined) return interrupted();
                const value = text(selected);
                if (item.allowCustom && selected === other) {
                    const typed = await context.ui.input(item.question, placeholder, opts());
                    if (ended() || typed === undefined) return interrupted();
                    answer = text(typed) || null; custom = answer !== null;
                } else if (labels.includes(selected)) { answer = selected; selectedIndex = labels.indexOf(selected); }
                else if (labels.includes(value)) { answer = value; selectedIndex = labels.indexOf(value); }
                else if (!value) answer = null;
                else if (item.allowCustom) { answer = value; custom = true; }
                else throw new Error('The submitted answer is not one of the offered options');
            } else {
                const typed = await context.ui.input(item.question, placeholder, opts());
                if (ended() || typed === undefined) return interrupted();
                answer = text(typed) || null; custom = answer !== null;
            }
            answers.push({ question: item.question, ...(item.header ? { header: item.header } : {}), answer, selectedIndex, custom, skipped: answer === null });
        }
        if (ended()) return interrupted();
        return result('answered', answers);
    } catch (error) {
        if (combined.aborted) return interrupted();
        throw error;
    } finally { clearTimeout(timer); }
}

module.exports = { askUserQuestion, normalizeQuestions, LIMITS };
