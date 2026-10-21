// ask_user_question: a panel docked above the composer plus a transcript receipt.
// Each question is still a native select/input request (see server/pi-user-question.js);
// the panel recognises them from the running tool call's arguments, collects every
// answer locally and only then answers the pending requests in order. Anything it
// cannot recognise stays with the generic request dialog.
(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, className, text) => {
        const element = document.createElement(tag); if (className) element.className = className;
        if (text !== undefined) element.textContent = text; return element;
    };
    const glyph = (name, style = 'solid') => { const element = node('i', `fa-${style} fa-${name}`); element.setAttribute('aria-hidden', 'true'); return element; };
    const iconButton = (label, name, className) => {
        const element = node('button', className); element.type = 'button'; element.title = label; element.setAttribute('aria-label', label);
        element.append(glyph(name)); return element;
    };
    const tr = (zh, en) => globalThis.PiI18n?.locale?.startsWith('en') ? en : zh;
    const MAX_ANSWER = 4000;

    // Mirrors normalizeQuestions(); a mismatch only means the generic dialog is used.
    function questionsOf(args) {
        const list = args?.questions;
        if (!Array.isArray(list) || !list.length || list.length > 4) return null;
        const seen = new Set(), questions = [];
        for (const item of list) {
            const question = typeof item?.question === 'string' ? item.question.trim() : '';
            if (!question || seen.has(question)) return null;
            seen.add(question);
            const options = Array.isArray(item.options) ? item.options.map(option => {
                const value = typeof option === 'string' ? { label: option } : option || {};
                return { label: typeof value.label === 'string' ? value.label.trim() : '', description: typeof value.description === 'string' ? value.description.trim() : '' };
            }) : [];
            if (options.some(option => !option.label)) return null;
            questions.push({ question, header: typeof item.header === 'string' ? item.header.trim() : '', options,
                allowCustom: !options.length || item.allowCustom !== false, placeholder: typeof item.placeholder === 'string' ? item.placeholder.trim() : '' });
        }
        return questions;
    }
    function requestFits(event, question) {
        if (event?.title !== question.question) return false;
        if (!question.options.length) return event.method === 'input';
        const labels = question.options.map(option => option.label), offered = event.options;
        return event.method === 'select' && Array.isArray(offered) && offered.length === labels.length + (question.allowCustom ? 1 : 0)
            && labels.every((label, index) => offered[index] === label);
    }

    function create(host) {
        let current = null, timer = 0, tick = 0;
        const known = new Map();
        const panel = node('section', 'pi-question-panel'); panel.id = 'pi-question-panel'; panel.hidden = true;
        panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', translateUi('Agent 提问'));
        const head = node('div', 'pi-question-head');
        const kicker = node('span', 'pi-question-kicker'), kickerText = node('span');
        kicker.append(glyph('circle-question', 'regular'), kickerText);
        const pager = node('div', 'pi-question-pager'), position = node('span', 'pi-question-position');
        const previous = iconButton(translateUi('上一题'), 'chevron-left', 'pi-question-icon'), next = iconButton(translateUi('下一题'), 'chevron-right', 'pi-question-icon');
        pager.append(previous, position, next);
        const collapse = iconButton(translateUi('收起提问'), 'chevron-down', 'pi-question-icon pi-question-collapse');
        const close = iconButton(translateUi('不回答并关闭'), 'xmark', 'pi-question-icon');
        head.append(kicker, node('span', 'pi-question-summary'), pager, collapse, close);
        const body = node('div', 'pi-question-body');
        const text = node('p', 'pi-question-text'); text.id = 'pi-question-text';
        const options = node('div', 'pi-question-options'); options.setAttribute('role', 'group'); options.setAttribute('aria-labelledby', text.id);
        const compose = node('div', 'pi-question-compose');
        const field = node('label', 'pi-question-field'), input = node('textarea');
        input.rows = 1; input.maxLength = MAX_ANSWER; input.setAttribute('aria-labelledby', text.id); input.enterKeyHint = 'send';
        field.append(glyph('pen'), input);
        const actions = node('div', 'pi-question-actions');
        const skip = node('button', 'pi-question-skip', tr('跳过', 'Skip')); skip.type = 'button';
        const submit = node('button', 'pi-question-submit'); submit.type = 'button';
        actions.append(skip, submit); compose.append(field, actions);
        const foot = node('p', 'pi-question-foot'); foot.setAttribute('role', 'status'); foot.setAttribute('aria-live', 'polite');
        body.append(text, options, compose, foot); panel.append(head, body);
        head.querySelector('.pi-question-summary').id = 'pi-question-summary';

        function locate(event) {
            if (!event || !['select', 'input'].includes(event.method)) return null;
            if (known.has(event.id)) return known.get(event.id);
            for (const call of host.calls()) {
                const questions = questionsOf(call.args);
                const index = questions ? questions.findIndex(question => requestFits(event, question)) : -1;
                if (index >= 0) { const found = { key: call.id, questions, index }; known.set(event.id, found); return found; }
            }
            return null;
        }
        const answerOf = index => current.answers[index];
        const answered = index => Boolean(answerOf(index));
        // Mirrors advance(): answering this question submits only when it is the last
        // question and every other open question already has an answer.
        const isLastStep = () => current.index === current.questions.length - 1
            && current.questions.every((_, index) => index === current.index || index < current.minIndex || answered(index));
        function hide() {
            clearTimeout(timer); clearInterval(tick); tick = 0;
            const hadFocus = panel.contains(document.activeElement);
            current = null; panel.hidden = true; host.changed?.();
            if (hadFocus) host.focusComposer?.();
        }
        function value(question, answer) {
            if (answer.skipped) return '';
            return answer.choice !== null ? question.options[answer.choice].label : answer.text;
        }
        function respond(event, index) {
            const question = current.questions[index], answer = answerOf(index);
            current.sent = index; host.respond({ id: event.id, value: value(question, answer) });
        }
        function finish() {
            current.submitting = true; render();
            if (current.event && current.sent !== current.requestIndex) respond(current.event, current.requestIndex);
        }
        function advance() {
            const total = current.questions.length, from = current.index;
            let target = -1;
            for (let step = 1; step <= total && target < 0; step++) {
                const index = (from + step) % total;
                if (index >= current.minIndex && !answered(index)) target = index;
            }
            if (target < 0 && from + 1 < total) target = from + 1;
            if (target < 0) { finish(); return; }
            current.index = target; render(); focusFirst();
        }
        function choose(index) {
            if (!current || current.submitting) return;
            current.answers[current.index] = { choice: index, text: '', skipped: false }; advance();
        }
        function submitTyped() {
            if (!current || current.submitting) return;
            const typed = input.value.trim();
            if (typed) current.answers[current.index] = { choice: null, text: typed, skipped: false };
            if (!answered(current.index)) { input.focus(); return; }
            advance();
        }
        function focusFirst() {
            if (!current || panel.classList.contains('is-collapsed')) return;
            const answer = answerOf(current.index);
            const target = options.querySelector('[aria-pressed="true"]') || (answer?.text || !current.questions[current.index].options.length ? input : options.querySelector('button'));
            (target || input).focus({ preventScroll: true });
        }
        function resize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
        function remaining() {
            if (!current?.event?.expiresAt || current.submitting) return '';
            const seconds = Math.ceil((current.event.expiresAt - Date.now()) / 1000);
            return seconds > 0 && seconds <= 120 ? translateUi('{0} 秒后自动关闭', seconds) : '';
        }
        function renderFoot() {
            if (!current) return;
            const question = current.questions[current.index];
            const status = current.submitting ? translateUi('正在提交回答…') : remaining();
            foot.textContent = status || (question.options.length > 1 ? translateUi('按数字键 1–{0} 快速选择', Math.min(question.options.length, 9)) : '');
            foot.classList.toggle('is-hint', !status);
        }
        function render() {
            if (!current) return;
            const question = current.questions[current.index], answer = answerOf(current.index), total = current.questions.length;
            panel.hidden = false; panel.classList.toggle('is-submitting', Boolean(current.submitting));
            kickerText.textContent = question.header || translateUi('问题');
            head.querySelector('.pi-question-summary').textContent = question.question;
            pager.hidden = total < 2; position.textContent = translateUi('{0} / {1}', current.index + 1, total);
            previous.disabled = current.submitting || current.index <= current.minIndex;
            next.disabled = current.submitting || current.index >= total - 1;
            text.textContent = question.question;
            options.replaceChildren(...question.options.map((option, index) => {
                const button = node('button', 'pi-question-option'); button.type = 'button';
                button.setAttribute('aria-pressed', String(answer?.choice === index)); button.disabled = Boolean(current.submitting);
                const label = node('span', 'pi-question-option-label'); label.append(node('strong', '', option.label));
                if (option.description) label.append(node('small', '', option.description));
                button.append(node('span', 'pi-question-key', String(index + 1)), label, glyph('arrow-right'));
                button.addEventListener('click', () => choose(index));
                return button;
            }));
            options.hidden = !question.options.length;
            field.hidden = !question.allowCustom;
            const typed = answer && answer.choice === null && !answer.skipped ? answer.text : '';
            if (current.renderedIndex !== current.index) { input.value = typed; current.renderedIndex = current.index; }
            input.placeholder = question.options.length ? translateUi('或自行撰写回复') : question.placeholder || translateUi('输入你的回答');
            input.disabled = skip.disabled = Boolean(current.submitting);
            compose.classList.toggle('is-text-only', !question.options.length);
            resize();
            const last = isLastStep();
            submit.textContent = last ? translateUi('提交') : translateUi('下一步');
            submit.disabled = current.submitting || !(input.value.trim() || answer && !answer.skipped);
            skip.textContent = tr('跳过', 'Skip');
            renderFoot();
            host.changed?.();
        }
        function present(found, event) {
            clearTimeout(timer);
            const fresh = current?.key !== found.key;
            if (current && current.sessionKey !== host.sessionKey()) hide();
            if (fresh || !current) {
                const focusable = !document.activeElement || document.activeElement === document.body || host.transcript?.contains(document.activeElement);
                current = { key: found.key, sessionKey: host.sessionKey(), questions: found.questions, answers: [], index: found.index, minIndex: found.index,
                    requestIndex: found.index, event, submitting: false, sent: -1, renderedIndex: -1 };
                panel.classList.remove('is-collapsed'); collapse.setAttribute('aria-expanded', 'true');
                render();
                if (!tick) tick = setInterval(renderFoot, 1000);
                if (focusable) focusFirst();
                return;
            }
            // Re-syncs of the same request must not rebuild the controls under the user.
            if (current.event?.id === event.id) return;
            current.event = event; current.requestIndex = found.index;
            if (current.submitting) {
                // The extension asks the next question only after the previous answer.
                if (current.sent === found.index) return;
                if (answered(found.index)) respond(event, found.index);
                else { current.submitting = false; current.index = found.index; render(); }
                return;
            }
            if (found.index > current.minIndex) current.minIndex = found.index;
            if (current.index < current.minIndex) current.index = current.minIndex;
            render();
        }

        previous.addEventListener('click', () => { if (current && current.index > current.minIndex) { current.index--; render(); focusFirst(); } });
        next.addEventListener('click', () => { if (current && current.index < current.questions.length - 1) { current.index++; render(); focusFirst(); } });
        collapse.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('is-collapsed');
            collapse.setAttribute('aria-expanded', String(!collapsed)); collapse.title = collapse.ariaLabel = collapsed ? translateUi('展开提问') : translateUi('收起提问');
            if (!collapsed) focusFirst(); host.changed?.();
        });
        head.addEventListener('click', event => { if (panel.classList.contains('is-collapsed') && !event.target.closest('button')) collapse.click(); });
        close.addEventListener('click', () => {
            if (!current?.event) { hide(); return; }
            host.respond({ id: current.event.id, cancelled: true }); hide();
        });
        skip.addEventListener('click', () => {
            if (!current || current.submitting) return;
            current.answers[current.index] = { choice: null, text: '', skipped: true }; advance();
        });
        submit.addEventListener('click', submitTyped);
        input.addEventListener('input', () => {
            if (!current) return;
            const typed = input.value.trim(), answer = answerOf(current.index);
            // Typing replaces a chosen option; the typed text is kept only once submitted.
            if (typed && answer && answer.choice !== null) {
                current.answers[current.index] = undefined;
                options.querySelectorAll('[aria-pressed="true"]').forEach(button => button.setAttribute('aria-pressed', 'false'));
            }
            resize(); submit.disabled = Boolean(current.submitting) || !(typed || answerOf(current.index) && !answerOf(current.index).skipped);
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submitTyped(); }
        });
        panel.addEventListener('keydown', event => {
            if (!current || event.defaultPrevented || event.isComposing) return;
            if (event.key === 'Escape') { event.preventDefault(); if (!panel.classList.contains('is-collapsed')) collapse.click(); return; }
            if (event.target === input || event.altKey || event.ctrlKey || event.metaKey) return;
            const buttons = [...options.querySelectorAll('button')];
            if (/^[1-9]$/.test(event.key) && buttons[Number(event.key) - 1]) { event.preventDefault(); buttons[Number(event.key) - 1].click(); return; }
            const at = buttons.indexOf(document.activeElement);
            if (at >= 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                const target = event.key === 'ArrowDown' ? buttons[at + 1] || (field.hidden ? buttons[0] : input) : buttons[at - 1] || buttons.at(-1);
                target.focus();
            } else if (event.key === 'ArrowUp' && document.activeElement === input) { event.preventDefault(); buttons.at(-1)?.focus(); }
        });

        return {
            element: panel,
            owns: event => Boolean(locate(event)),
            visible: () => Boolean(current) && !panel.hidden,
            focus() { if (!current) return false; if (panel.classList.contains('is-collapsed')) collapse.click(); else focusFirst(); panel.scrollIntoView({ block: 'nearest' }); return true; },
            // Called whenever the pending request set changes.
            sync(pending, connected) {
                if (!connected || current && current.sessionKey !== host.sessionKey()) { known.clear(); hide(); if (!connected) return; }
                let found = null, event = null;
                for (const item of pending.values()) { const match = locate(item); if (match) { found = match; event = item; break; } }
                for (const id of known.keys()) if (!pending.has(id)) known.delete(id);
                if (found) { present(found, event); return; }
                if (!current) return;
                current.event = null;
                if (current.submitting && current.sent < current.questions.length - 1) {
                    // Wait briefly for the next native request of the same call.
                    clearTimeout(timer); timer = setTimeout(() => { if (current && !current.event) hide(); }, 8000); render(); return;
                }
                hide();
            },
            reset() { known.clear(); hide(); }
        };
    }

    // Transcript receipt for the finished tool call.
    function receiptOf(message) {
        const value = message?.details?.pivaneQuestion;
        if (message?.isError || message?.toolName !== 'ask_user_question' || !value || typeof value.status !== 'string' || !Array.isArray(value.answers) || value.answers.length > 4) return null;
        if (value.answers.some(answer => typeof answer?.question !== 'string' || answer.answer !== null && typeof answer.answer !== 'string')) return null;
        return value;
    }
    function receipts() {
        const cards = new Map();
        return {
            reset() { cards.clear(); },
            prune() { for (const [id, card] of cards) if (!card.isConnected) cards.delete(id); },
            render(message) {
                const value = receiptOf(message), id = message?.toolCallId;
                if (!id || !value || cards.get(id)?.isConnected) return null;
                const card = node('section', `pi-question-receipt is-${value.status}`); card.dataset.readingKey = `question:${id}`;
                card.setAttribute('aria-label', translateUi('提问与回答'));
                const heading = node('div', 'pi-question-receipt-head');
                const answeredCount = value.answers.filter(answer => !answer.skipped).length;
                const title = value.status === 'answered' ? (value.answers.length > 1 ? translateUi('已回答 {0} / {1} 个问题', answeredCount, value.answers.length) : answeredCount ? translateUi('已回答') : translateUi('已跳过'))
                    : value.status === 'timed_out' ? translateUi('提问已超时，未作答') : value.status === 'aborted' ? translateUi('提问已随任务停止')
                        : value.status === 'unavailable' ? translateUi('当前界面无法提问') : translateUi('已关闭提问，未作答');
                heading.append(glyph(value.status === 'answered' ? 'circle-check' : 'circle-xmark', 'regular'), node('span', '', title));
                card.append(heading);
                if (value.answers.length) {
                    const list = node('dl', 'pi-question-receipt-list');
                    for (const answer of value.answers) {
                        const term = node('dt'); term.textContent = answer.header ? `${answer.header} · ${answer.question}` : answer.question;
                        const detail = node('dd', answer.skipped ? 'is-skipped' : '', answer.skipped ? translateUi('已跳过') : answer.answer);
                        list.append(term, detail);
                    }
                    card.append(list);
                }
                cards.set(id, card); return card;
            }
        };
    }
    globalThis.PiUserQuestion = { create, receipts, questionsOf, requestFits };
})();
