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
            this.dialog.setAttribute('aria-label', translateUi("运行队列与取回内容"));
            const heading = el('div', undefined, 'pi-native-heading'); heading.append(el('strong', translateUi("运行队列与取回内容")));
            const close = el('button', translateUi("关闭")); close.type = 'button'; close.addEventListener('click', () => this.dialog.close()); heading.append(close);
            this.body = el('div', undefined, 'pi-native-body'); this.dialog.append(heading, this.body); document.body.append(this.dialog);
            this.button = el('button', '', 'pi-queue-open'); this.button.id = 'pi-queue-open'; this.button.type = 'button';
            this.button.addEventListener('click', () => { this.renderDialog(); this.dialog.showModal(); });
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
        render() {
            if (!this.value) return;
            const { queue, recoveries, stopping, extension } = this.value;
            const count = queue.steering.length + queue.followUp.length;
            const container = document.getElementById('pi-queue');
            if (!container.contains(this.button)) container.replaceChildren(this.button);
            container.classList.toggle('hidden', !count && !recoveries.length && !stopping);
            this.button.textContent = translateUi("{0}待执行 {1} 条{2} · 查看", stopping ? translateUi("正在停止 / 取回 · ") : '', count, recoveries.length ? translateUi(" · 已取回 {0} 组", recoveries.length) : '');
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
            this.body.replaceChildren();
            if (!this.value) return;
            const { queue, recoveries, stopping } = this.value;
            this.body.append(el('p', this.value.durable
                ? translateUi("已保存排队意图的文字、图片和文档引用。取回与恢复只供核对，不会自动发送；不确定内容可能已经执行，请先查看会话。")
                : translateUi("引导：本轮工具执行后补充。后续：当前任务全部完成后继续。取回仅包含文字；如原消息含图片，请重新添加图片。"), 'pi-native-help'));
            this.body.append(el('p', this.value.durable
                ? translateUi("未处理内容在运行实例退出和服务重建后保留。追加后请保存当前草稿；从列表移除会取消服务器上的恢复凭据。")
                : translateUi("取回内容只在当前运行实例中保留，退出会话运行实例或服务重启后不恢复。"), 'pi-native-help'));
            if (this.value.persistenceError) this.body.append(el('p', translateUi("队列持久化未完成，请重新打开并核对恢复记录。不要重复发送不确定内容。"), 'pi-native-help'));
            for (const [kind, label] of [['steering', translateUi("引导")], ['followUp', translateUi("后续")]]) {
                queue[kind].forEach(text => {
                    const card = el('article', undefined, 'pi-recovery-card'); card.append(el('strong', label), el('pre', text)); this.body.append(card);
                });
            }
            if (queue.steering.length || queue.followUp.length) {
                const take = this.action(this.value.durable ? translateUi("全部取回") : translateUi("全部取回文字"), () => this.options.take(false)); take.id = 'pi-queue-take'; take.disabled ||= stopping;
                this.body.append(take);
            }
            for (const recovery of recoveries) {
                const card = el('article', undefined, 'pi-recovery-card'); card.dataset.recoveryId = recovery.id;
                const text = [...recovery.steering, ...recovery.followUp].join('\n\n');
                card.append(el('strong', recovery.status === 'recovered' ? translateUi("已从队列取回") : recovery.status === 'pending' ? translateUi("正在取回") : translateUi("取回结果不确定，请先核对会话")), el('pre', text));
                if (recovery.imageCount) card.append(el('p', translateUi("已保留 {0} 张图片，明确追加时读取完整内容", recovery.imageCount)));
                if (recovery.legacy) card.append(el('p', translateUi("这条旧队列记录仅保留文字；原图片需要重新添加。")));
                if (recovery.originalOnly) card.append(el('p', translateUi("仅保留发送前的原始文字和图片；变换后的内容未完整保存。原生可能仍在处理，请先核对队列和会话。")));
                if (recovery.state === 'started') card.append(el('p', translateUi("原生已开始处理；尚未核实对应记录已保存。")));
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
                    }); append.dataset.recoveryAppend = ''; card.append(append);
                }
                if (recovery.status !== 'pending') {
                    card.append(this.action(translateUi("复制文字"), () => this.options.copy(text).then(() => this.options.toast(translateUi("已复制"), 'success'))));
                    const dismiss = this.action(translateUi("移除"), async () => {
                        if (!window.confirm(translateUi("从取回列表移除这组内容？"))) return;
                        const epoch = this.epoch, runtimeId = this.value.runtimeId;
                        const value = await this.options.ack(recovery.id, { runtimeId, revision: this.value.revision });
                        if (epoch === this.epoch && this.value?.runtimeId === runtimeId) this.apply(value);
                    }); card.append(dismiss);
                }
                this.body.append(card);
            }
            if (!queue.steering.length && !queue.followUp.length && !recoveries.length) this.body.append(el('p', translateUi("没有待执行或已取回的消息。")));
        }
    }
    window.PiRuntimeControls = PiRuntimeControls;
})();
