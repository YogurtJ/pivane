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
                this.busy = true; button.disabled = true;
                try { await handler(); }
                catch (error) { if (epoch === this.epoch) this.options.toast(error.message, 'error'); }
                finally { if (epoch === this.epoch) { this.busy = false; if (this.dialog.open) this.renderDialog(); } }
            }); return button;
        }
        renderDialog() {
            this.body.replaceChildren();
            if (!this.value) return;
            const { queue, recoveries, stopping } = this.value;
            this.body.append(el('p', translateUi("引导：本轮工具执行后补充。后续：当前任务全部完成后继续。取回仅包含文字；如原消息含图片，请重新添加图片。"), 'pi-native-help'));
            this.body.append(el('p', translateUi("取回内容只在当前运行实例中保留，退出会话运行实例或服务重启后不恢复。"), 'pi-native-help'));
            for (const [kind, label] of [['steering', translateUi("引导")], ['followUp', translateUi("后续")]]) {
                queue[kind].forEach(text => {
                    const card = el('article', undefined, 'pi-recovery-card'); card.append(el('strong', label), el('pre', text)); this.body.append(card);
                });
            }
            if (queue.steering.length || queue.followUp.length) {
                const take = this.action(translateUi("全部取回文字"), () => this.options.take(false)); take.id = 'pi-queue-take'; take.disabled ||= stopping;
                this.body.append(take);
            }
            for (const recovery of recoveries) {
                const card = el('article', undefined, 'pi-recovery-card'); card.dataset.recoveryId = recovery.id;
                const text = [...recovery.steering, ...recovery.followUp].join('\n\n');
                card.append(el('strong', recovery.status === 'recovered' ? translateUi("已从队列取回") : recovery.status === 'pending' ? translateUi("正在取回") : translateUi("取回结果不确定，请先核对会话")), el('pre', text));
                if (recovery.status === 'recovered' && text) {
                    const appliedKey = `${this.value.runtimeId}:${recovery.id}`;
                    const append = this.action(this.applied.has(appliedKey) ? translateUi("本页已追加到草稿") : translateUi("追加到草稿"), async () => {
                        // Record locally before acknowledging, so a failed acknowledgement cannot duplicate the draft.
                        if (!this.applied.has(appliedKey)) { this.options.append(text); this.applied.add(appliedKey); }
                        this.apply(await this.options.ack(recovery.id));
                        this.options.toast(translateUi("已追加到草稿，请核对后发送"), 'success');
                    }); append.dataset.recoveryAppend = ''; card.append(append);
                }
                if (recovery.status !== 'pending') {
                    card.append(this.action(translateUi("复制文字"), () => this.options.copy(text).then(() => this.options.toast(translateUi("已复制"), 'success'))));
                    const dismiss = this.action(translateUi("移除"), async () => {
                        if (window.confirm(translateUi("从取回列表移除这组文字？"))) this.apply(await this.options.ack(recovery.id));
                    }); card.append(dismiss);
                }
                this.body.append(card);
            }
            if (!queue.steering.length && !queue.followUp.length && !recoveries.length) this.body.append(el('p', translateUi("没有待执行或已取回的消息。")));
        }
    }
    window.PiRuntimeControls = PiRuntimeControls;
})();
