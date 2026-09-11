/* Read-only settings usage view. All labels and server values use textContent. */
window.PiUsage = (() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const number = value => Number(value || 0).toLocaleString(globalThis.PiI18n?.locale || 'zh-CN');
    const cost = value => `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
    function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    function create({ apiFetch }) {
        const $ = id => document.getElementById(`settings-usage-${id}`);
        const form = $('filters'), result = $('result'), status = $('status');
        const range = $('range'), from = $('from'), to = $('to');
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        let epoch = 0, controller = null, opened = false;
        const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        function preset() {
            if (range.value === 'custom') return;
            const end = new Date(), start = new Date(end);
            if (range.value === 'month') start.setDate(1);
            if (range.value === 'week') start.setDate(start.getDate() - 6);
            from.value = localDate(start); to.value = localDate(end);
        }
        function cancel() { epoch++; controller?.abort(); controller = null; result.removeAttribute('aria-busy'); }
        function invalidate() {
            cancel(); result.replaceChildren(); status.textContent = translateUi("日期已修改，点击刷新统计。");
        }
        async function load() {
            if (!form.reportValidity()) return;
            if (from.value > to.value || (Date.parse(to.value) - Date.parse(from.value)) / 86400000 > 365) {
                invalidate(); status.textContent = translateUi("请选择有效的起止日期，范围最多 366 天。"); return;
            }
            cancel(); const revision = epoch;
            controller = new AbortController();
            result.replaceChildren(); result.setAttribute('aria-busy', 'true');
            status.textContent = translateUi("正在读取持久会话用量…");
            try {
                const options = { signal: controller.signal };
                const capabilities = await apiFetch('/api/pi/status', options);
                if (revision !== epoch || !opened) return;
                if (!capabilities.usageStats) { status.textContent = translateUi("用量统计后端尚未启用，服务空闲更新后可使用。"); return; }
                const params = new URLSearchParams({ from: from.value, to: to.value, timeZone });
                const data = await apiFetch(`/api/pi/settings/usage?${params}`, options);
                if (revision !== epoch || !opened) return;
                render(data);
            } catch (error) {
                if (revision === epoch && opened && error.name !== 'AbortError') status.textContent = translateUi("统计失败：{0}。可点击刷新重试。", error.message);
            } finally { if (revision === epoch) result.removeAttribute('aria-busy'); }
        }
        function table(title, rows, columns) {
            const section = node('section', undefined, 'pi-usage-section');
            section.append(node('h4', title));
            if (!rows.length) { section.append(node('p', translateUi("此时间范围没有记录。"), 'pi-usage-muted')); return section; }
            const wrapper = node('div', undefined, 'pi-usage-table-scroll'); wrapper.tabIndex = 0;
            wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', title);
            const table = node('table'), head = node('thead'), tr = node('tr');
            for (const [label] of columns) { const th = node('th', label); th.scope = 'col'; tr.append(th); }
            head.append(tr); table.append(head);
            const body = node('tbody'); table.append(body); wrapper.append(table); section.append(wrapper);
            let count = 0;
            const more = node('button', translateUi("显示更多"), 'pi-secondary-button'); more.type = 'button';
            function append() {
                for (const row of rows.slice(count, count + 20)) {
                    const tr = node('tr');
                    for (const [, value] of columns) tr.append(node('td', value(row)));
                    body.append(tr);
                }
                count = Math.min(rows.length, count + 20);
                more.textContent = translateUi("显示更多（{0} / {1}）", count, rows.length); more.hidden = count === rows.length;
            }
            more.addEventListener('click', append); section.append(more); append(); return section;
        }
        function render(data) {
            const c = data.coverage, total = data.total;
            status.textContent = translateUi("{0} 至 {1} · {2} · 更新于 {3} · 已扫描 {4} 个会话文件", data.from, data.to, data.timeZone, new Date(data.generatedAt).toLocaleTimeString(globalThis.PiI18n?.locale), number(c.scannedFiles));
            if (data.partial) {
                result.append(node('p', translateUi("统计不完整：跳过 {0} 个文件，{1} 条记录缺少有效日期，{2} 条记录缺少完整用量{3}。以下为已读取部分。", number(c.skippedFiles), number(c.invalidDates), number(total.missingUsage), c.limited ? translateUi("；扫描达到限额") : ''), 'pi-usage-warning'));
            }
            const cards = node('div', undefined, 'pi-usage-cards');
            for (const [label, value] of [[translateUi("总 Token"), number(total.total)], [translateUi("输入"), number(total.input)], [translateUi("输出"), number(total.output)],
                [translateUi("缓存读取"), number(total.cacheRead)], [translateUi("缓存写入"), number(total.cacheWrite)], [translateUi("估算费用（USD）"), cost(total.cost)]]) {
                const card = node('div'); card.append(node('span', label), node('strong', value)); cards.append(card);
            }
            result.append(cards);
            result.append(node('p', translateUi("已去重 {0} 条副本记录 · {1} 条用量记录 · {2} 条缺少价格／费用，{3} 条记录费用为零。", number(c.duplicates), number(total.records), number(total.missingCost), number(total.zeroCost)), 'pi-usage-muted'));
            if (!total.records) result.append(node('p', translateUi("此时间范围内没有持久会话用量记录。"), 'settings-empty'));
            const chart = node('section', undefined, 'pi-usage-section'); chart.append(node('h4', translateUi("每日用量")));
            const metric = node('select'); metric.setAttribute('aria-label', translateUi("每日趋势指标"));
            for (const [value, label] of [['total', translateUi("总 Token")], ['input', translateUi("输入 Token")], ['output', translateUi("输出 Token")], ['cacheRead', translateUi("缓存读取")], ['cacheWrite', translateUi("缓存写入")], ['cost', translateUi("估算费用（USD）")]]) {
                const option = node('option', label); option.value = value; metric.append(option);
            }
            const plot = node('div', undefined, 'pi-usage-chart');
            const detail = node('p', translateUi("点击或用键盘选择日期查看数值。"), 'pi-usage-muted'); detail.setAttribute('aria-live', 'polite');
            function draw() {
                plot.replaceChildren();
                const max = Math.max(...data.daily.map(day => day[metric.value]), 1);
                for (const day of data.daily) {
                    const value = metric.value === 'cost' ? cost(day.cost) : number(day[metric.value]);
                    const label = `${day.date}：${value}`;
                    const bar = node('button', undefined, 'pi-usage-bar'); bar.type = 'button'; bar.title = label; bar.setAttribute('aria-label', label);
                    const fill = node('span'); fill.style.height = `${Math.max(0, day[metric.value] / max * 100)}%`; bar.append(fill);
                    const select = () => { detail.textContent = translateUi("{0} · 输入 {1} · 输出 {2} · 缓存读取 {3} · 缓存写入 {4} · {5}", label, number(day.input), number(day.output), number(day.cacheRead), number(day.cacheWrite), cost(day.cost)); };
                    bar.addEventListener('focus', select); bar.addEventListener('click', select); plot.append(bar);
                }
            }
            metric.addEventListener('change', draw); draw(); chart.append(metric, plot, node('p', `${data.from} — ${data.to}`, 'pi-usage-muted'), detail); result.append(chart);
            const values = [['Token', row => number(row.total)], [translateUi("输入 / 输出"), row => `${number(row.input)} / ${number(row.output)}`],
                [translateUi("缓存读 / 写"), row => `${number(row.cacheRead)} / ${number(row.cacheWrite)}`], [translateUi("估算 USD"), row => cost(row.cost)]];
            result.append(table(translateUi("按供应商"), data.providers, [[translateUi("供应商"), row => row.provider], ...values]));
            result.append(table(translateUi("按模型"), data.models, [[translateUi("模型"), row => `${row.provider} / ${row.model}`], ...values]));
            result.append(table(translateUi("按项目"), data.projects, [[translateUi("项目"), row => row.cwd], ...values]));
            const sessions = node('details', undefined, 'pi-usage-scope'); sessions.append(node('summary', translateUi("会话明细（{0}）", data.sessions.length)));
            let built = false;
            sessions.addEventListener('toggle', () => {
                if (sessions.open && !built) { built = true; sessions.append(table(translateUi("去重后的会话归属"), data.sessions, [[translateUi("会话 / 项目"), row => `${row.name}\n${row.cwd}`], ...values])); }
            });
            result.append(sessions);
        }
        range.addEventListener('change', () => { preset(); invalidate(); if (range.value !== 'custom') load(); });
        for (const input of [from, to]) input.addEventListener('change', () => { range.value = 'custom'; invalidate(); });
        form.addEventListener('submit', event => { event.preventDefault(); load(); });
        preset();
        return { open() { opened = true; preset(); load(); }, close() { opened = false; cancel(); } };
    }
    return { create };
})();
