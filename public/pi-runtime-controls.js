(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const el = (tag, text, className) => {
        const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
        if (className) node.className = className; return node;
    };
    class PiRuntimeControls {
        constructor(options) {
            this.options = options;
            this.epoch = 0;
            this.extensionSignature = '';
            this.value = null;
            this.baseTitle = document.title;
            this.enabled = false;
            this.applied = new Set();
            this.busy = false;
            this.dialog = document.createElement('dialog'); this.dialog.id = 'pi-queue-dialog'; this.dialog.className = 'pi-native-dialog';
            this.dialog.setAttribute('aria-labelledby', 'pi-queue-title');
            const heading = el('div', undefined, 'pi-native-heading');
            const title = el('strong', translateUi("消息队列")); title.id = 'pi-queue-title'; title.tabIndex = -1; heading.append(title);
            const close = el('button', translateUi("关闭")); close.type = 'button'; close.addEventListener('click', () => this.dialog.close()); heading.append(close);
            this.body = el('div', undefined, 'pi-native-body'); this.dialog.append(heading, this.body); document.body.append(this.dialog);
            this.button = el('button', '', 'pi-queue-open'); this.button.id = 'pi-queue-open'; this.button.type = 'button';
            this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-controls', this.dialog.id);
            this.button.addEventListener('click', () => { this.renderDialog(); this.dialog.showModal(); });
            this.dialog.addEventListener('close', () => {
                if (!document.getElementById('pi-queue').hidden) this.button.focus();
                else document.getElementById('pi-input')?.focus();
            });
            this.extension = document.getElementById('pi-extension-state');
            this.extensionBody = document.getElementById('pi-extension-body');
        }
        disconnected() {
            this.extension.querySelector('summary').textContent = translateUi("扩展状态（连接已断开）");
            document.title = this.baseTitle;
            if (this.dialog.open) this.renderDialog();
        }
        reset() {
            this.epoch++; this.extensionSignature = '';
            this.value = null; this.busy = false; this.enabled = false;
            document.getElementById('pi-queue').hidden = true;
            if (this.dialog.open) this.dialog.close();
            document.title = this.baseTitle;
            this.extension.hidden = true;
            this.extensionBody.replaceChildren();
        }
        apply(value) {
            if (!value) return;
            if (this.value?.runtimeId === value.runtimeId && this.value.revision >= value.revision) return;
            this.enabled = true; this.value = value;
            this.extension.querySelector('summary').textContent = translateUi("扩展状态");
            this.render(); this.options.changed();
        }
        renderLegacyQueue(steering, followUp) {
            this.value = { queue: { steering, followUp }, recoveries: [], stopping: false, extension: { title: '', statuses: [], widgets: [] } };
            this.render();
        }
        render() {
            if (!this.value) return;
            const { queue, recoveries, stopping, extension } = this.value;
            const count = queue.steering.length + queue.followUp.length;
            const container = document.getElementById('pi-queue');
            if (!container.contains(this.button)) container.replaceChildren(this.button);
            container.hidden = !count && !recoveries.length && !stopping && !this.value.persistenceError;
            const attention = this.value.persistenceError || recoveries.some(item => item.status === 'uncertain');
            container.dataset.tone = attention ? 'attention' : '';
            const label = stopping ? translateUi("正在取回") : attention ? translateUi("待核对") : count && recoveries.length ? translateUi("消息队列") : count ? translateUi("待执行") : translateUi("已取回");
            const icon = el('i', undefined, `fa-solid ${attention ? 'fa-circle-exclamation' : 'fa-list-ul'}`); icon.setAttribute('aria-hidden', 'true');
            this.button.replaceChildren(icon, el('strong', label), document.createTextNode(' '), el('span', String(count + recoveries.length), 'pi-queue-count'));
            const description = translateUi("待执行 {0} 条，取回记录 {1} 组", count, recoveries.length);
            this.button.title = description; this.button.setAttribute('aria-label', `${label} · ${description}`);
            const signature = JSON.stringify(extension);
            if (signature !== this.extensionSignature) {
                this.extensionSignature = signature;
                const visible = extension.title || extension.statuses.length || extension.widgets.length;
                this.extension.hidden = !visible;
                document.title = extension.title ? `${extension.title} · Pivane` : this.baseTitle;
                const content = [];
                if (extension.title) content.push(el('p', extension.title, 'pi-extension-title'));
                for (const [key, text] of extension.statuses) {
                    const item = el('div', undefined, 'pi-extension-item'); item.append(el('strong', key), el('p', text)); content.push(item);
                }
                for (const [key, widget] of extension.widgets) {
                    const item = el('details', undefined, 'pi-extension-widget');
                    const old = [...this.extensionBody.querySelectorAll('details')].find(node => node.dataset.widgetKey === key);
                    item.dataset.widgetKey = key; item.open = old?.open ?? true;
                    item.append(el('summary', key), el('pre', widget.lines)); content.push(item);
                }
                this.extensionBody.replaceChildren(...content);
            }
            if (this.dialog.open && !this.busy) this.renderDialog();
        }
        action(text, handler) {
            const button = el('button', text); button.type = 'button'; button.disabled = this.busy || !this.options.connected();
            button.addEventListener('click', async () => {
                if (this.busy) return;
                const epoch = this.epoch;
                this.busy = true;
                const finish = window.PiActionFeedback.begin(button, translateUi("正在处理…"));
                const controls = [...this.body.querySelectorAll('button')];
                controls.forEach(item => { item.disabled = true; });
                try { await handler(); }
                catch (error) { if (epoch === this.epoch) this.options.toast(error.message, 'error'); }
                finally { finish(); if (epoch === this.epoch) { this.busy = false; if (this.dialog.open) this.renderDialog(); } }
            }); return button;
        }
        renderDialog() {
            const helpOpen = this.body.querySelector('.pi-queue-help')?.open || false;
            const scrollTop = this.body.scrollTop;
            const focused = this.body.contains(document.activeElement) ? document.activeElement : null;
            const focusedRecovery = focused?.closest('[data-recovery-id]')?.dataset.recoveryId;
            const focusedAction = focused?.dataset.queueAction;
            this.body.replaceChildren();
            if (!this.value) return;
            const { queue, recoveries, stopping } = this.value;
            const count = queue.steering.length + queue.followUp.length;
            const notice = (text, warning = false) => el('p', text, warning ? 'pi-queue-notice is-warning' : 'pi-queue-notice');
            if (this.value.persistenceError) this.body.append(notice(translateUi("队列持久化未完成，请重新打开并核对恢复记录。不要重复发送不确定内容。"), true));
            if (stopping) this.body.append(notice(translateUi("正在取回队列，请稍候…")));
            if (count) {
                const section = el('section', undefined, 'pi-queue-section');
                const header = el('div', undefined, 'pi-queue-section-heading');
                header.append(el('h3', translateUi("待执行 {0} 条", count)));
                if (this.enabled) {
                    const take = this.action(this.value.durable ? translateUi("全部取回") : translateUi("全部取回文字"), () => this.options.take(false));
                    take.id = 'pi-queue-take'; take.dataset.queueAction = 'take'; take.disabled ||= stopping; header.append(take);
                }
                section.append(header);
                if (this.enabled) section.append(el('p', translateUi("取回后可编辑，不会停止当前任务。"), 'pi-queue-caption'));
                for (const [kind, label, timing] of [
                    ['steering', translateUi("引导"), translateUi("本轮工具执行后")],
                    ['followUp', translateUi("后续"), translateUi("当前任务完成后")]
                ]) {
                    if (!queue[kind].length) continue;
                    const group = el('div', undefined, 'pi-queue-group'); group.dataset.kind = kind;
                    const groupHeading = el('div', undefined, 'pi-queue-group-heading');
                    groupHeading.append(el('strong', label), el('span', timing)); group.append(groupHeading);
                    queue[kind].forEach((text, index) => {
                        const card = el('article', undefined, 'pi-recovery-card pi-queued-message');
                        card.append(el('span', String(index + 1).padStart(2, '0'), 'pi-queue-position'), el('pre', text)); group.append(card);
                    });
                    section.append(group);
                }
                this.body.append(section);
            }
            const recoveredSection = el('section', undefined, 'pi-queue-section');
            if (recoveries.length) {
                const header = el('div', undefined, 'pi-queue-section-heading');
                header.append(el('h3', translateUi("取回记录 {0} 组", recoveries.length)));
                recoveredSection.append(header, el('p', translateUi("追加到草稿后，由你确认发送。"), 'pi-queue-caption'));
                this.body.append(recoveredSection);
            }
            for (const recovery of recoveries) {
                const card = el('article', undefined, 'pi-recovery-card'); card.dataset.recoveryId = recovery.id;
                const text = [...recovery.steering, ...recovery.followUp].join('\n\n');
                card.dataset.status = recovery.status;
                const status = el('div', undefined, 'pi-recovery-heading');
                status.append(el('span', recovery.status === 'recovered' ? translateUi("已取回") : recovery.status === 'pending' ? translateUi("正在取回") : translateUi("待核对"), 'pi-recovery-status'));
                card.append(status, el('pre', text));
                if (recovery.status === 'uncertain') card.append(notice(translateUi("可能已经执行，请先核对会话再追加。"), true));
                if (recovery.imageCount) card.append(el('p', translateUi("已保留 {0} 张图片，明确追加时读取完整内容", recovery.imageCount), 'pi-queue-caption'));
                if (recovery.legacy) card.append(notice(translateUi("这条旧队列记录仅保留文字；原图片需要重新添加。")));
                if (recovery.originalOnly) card.append(notice(translateUi("仅保留发送前的原始文字和图片；变换后的内容未完整保存。原生可能仍在处理，请先核对队列和会话。"), true));
                if (recovery.state === 'started') card.append(notice(translateUi("原生已开始处理；尚未核实对应记录已保存。"), true));
                const actions = el('div', undefined, 'pi-recovery-actions');
                const fullPayload = recovery.hasPayload && this.options.readRecovery && this.options.appendRecovery;
                if ((recovery.status === 'recovered' || recovery.durable && recovery.status === 'uncertain') && (text || recovery.imageCount)
                    && (!recovery.hasPayload || fullPayload)) {
                    const appliedKey = recovery.durable ? recovery.id : `${this.value.runtimeId}:${recovery.id}`;
                    const append = this.action(this.applied.has(appliedKey) ? translateUi("本页已追加到草稿") : translateUi("追加到草稿"), async () => {
                        const epoch = this.epoch, runtimeId = this.value.runtimeId;
                        if (!this.applied.has(appliedKey)) {
                            if (recovery.status === 'uncertain' && !window.confirm(translateUi("这条内容可能已经执行。核对会话后，仍要追加到草稿吗？"))) return;
                            if (fullPayload) {
                                const result = await this.options.readRecovery(recovery.id, { runtimeId, revision: this.value.revision });
                                if (epoch !== this.epoch || this.value?.runtimeId !== runtimeId) return;
                                await this.options.appendRecovery(result.payload);
                            } else await this.options.append(text);
                            if (epoch !== this.epoch || this.value?.runtimeId !== runtimeId) return;
                            // Save locally before ack so a failed disk commit cannot duplicate the draft.
                            this.applied.add(appliedKey);
                        }
                        const value = await this.options.ack(recovery.id, { runtimeId, revision: this.value.revision });
                        if (epoch !== this.epoch || this.value?.runtimeId !== runtimeId) return;
                        this.apply(value);
                        this.options.toast(translateUi("已追加到草稿，请核对后发送"), 'success');
                    }); append.dataset.recoveryAppend = ''; append.dataset.queueAction = 'append'; append.className = 'pi-queue-primary'; actions.append(append);
                }
                if (recovery.status !== 'pending') {
                    const copy = this.action(translateUi("复制文字"), () => this.options.copy(text).then(() => this.options.toast(translateUi("已复制"), 'success')));
                    copy.dataset.queueAction = 'copy'; actions.append(copy);
                    const dismiss = this.action(translateUi("移除"), async () => {
                        if (!window.confirm(translateUi("从取回列表移除这组内容？"))) return;
                        const epoch = this.epoch, runtimeId = this.value.runtimeId;
                        const value = await this.options.ack(recovery.id, { runtimeId, revision: this.value.revision });
                        if (epoch === this.epoch && this.value?.runtimeId === runtimeId) this.apply(value);
                    }); dismiss.dataset.queueAction = 'dismiss'; dismiss.className = 'pi-queue-dismiss'; actions.append(dismiss);
                }
                card.append(actions); recoveredSection.append(card);
            }
            if (!count && !recoveries.length) this.body.append(el('p', translateUi("没有待执行或已取回的消息。"), 'pi-queue-empty'));
            if (this.enabled) {
                const help = el('details', undefined, 'pi-queue-help'); help.open = helpOpen;
                help.append(el('summary', translateUi("取回与保存说明")));
                help.append(el('p', this.value.durable
                    ? translateUi("已保存排队意图的文字、图片和文档引用。取回与恢复只供核对，不会自动发送；不确定内容可能已经执行，请先查看会话。")
                    : translateUi("取回仅包含文字；如原消息含图片，请重新添加图片。")));
                help.append(el('p', this.value.durable
                    ? translateUi("未处理内容在运行实例退出和服务重建后保留。追加后请保存当前草稿；从列表移除会取消服务器上的恢复凭据。")
                    : translateUi("取回内容只在当前运行实例中保留，退出会话运行实例或服务重启后不恢复。")));
                this.body.append(help);
            }
            this.body.scrollTop = scrollTop;
            if (focused) {
                const target = [...this.body.querySelectorAll('[data-queue-action]')].find(node => node.dataset.queueAction === focusedAction && node.closest('[data-recovery-id]')?.dataset.recoveryId === focusedRecovery);
                (target || this.body.querySelector('.pi-queue-help > summary') || document.getElementById('pi-queue-title')).focus({ preventScroll: true });
            }
        }
    }
    window.PiRuntimeControls = PiRuntimeControls;
})();
