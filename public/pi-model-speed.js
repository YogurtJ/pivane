(() => {
    const t = (text, ...values) => globalThis.PiI18n?.t?.(text, ...values) ?? text.replace(/\{(\d+)\}/g, (_, n) => values[n] ?? '');
    const labels = () => ({ auto: t('跟随供应商'), standard: t('标准 Standard'), fast: 'Fast', ultrafast: 'Ultrafast' });
    class PiModelSpeed {
        constructor(options) {
            this.options = options; this.value = null; this.epoch = 0; this.pending = false; this.blocked = true;
            this.field = document.createElement('label'); this.field.className = 'pi-control-field pi-speed-field'; this.field.hidden = true;
            const name = document.createElement('span'); name.textContent = t('速度');
            this.select = document.createElement('select'); this.select.id = 'pi-speed-select'; this.select.setAttribute('aria-label', t('速度')); this.select.disabled = true;
            this.field.append(name, this.select); document.querySelector('.pi-thinking-field').after(this.field);
            this.select.addEventListener('change', () => void this.change(this.select.value));
            this.summary = document.createElement('span'); this.summary.id = 'pi-mobile-composer-speed'; document.getElementById('pi-mobile-composer-thinking').after(this.summary);
        }
        mobileRow() {
            this.mobileField = document.createElement('label'); this.mobileField.className = 'pi-mobile-sheet-row pi-mobile-thinking pi-mobile-speed'; this.mobileField.hidden = true;
            const icon = document.createElement('i'); icon.className = 'fa-solid fa-bolt'; icon.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span'); name.textContent = t('速度');
            const choice = document.createElement('span'); choice.className = 'pi-mobile-thinking-choice';
            this.mobile = document.createElement('select'); this.mobile.id = 'pi-mobile-speed'; this.mobile.setAttribute('aria-label', t('速度'));
            const chevron = document.createElement('i'); chevron.className = 'fa-solid fa-chevron-down'; chevron.setAttribute('aria-hidden', 'true');
            this.mobileCost = document.createElement('small'); this.mobileCost.className = 'pi-mobile-speed-cost';
            choice.append(this.mobile, chevron); this.mobileField.append(icon, name, choice, this.mobileCost);
            this.mobile.addEventListener('change', () => void this.change(this.mobile.value));
            return this.mobileField;
        }
        reset() { this.epoch++; this.value = null; this.pending = false; this.render(); }
        apply(value) {
            if (value && this.value?.runtimeId === value.runtimeId && this.value.revision > value.revision) return;
            this.value = value || null; this.render(); this.options.changed();
        }
        setBlocked(blocked) { this.blocked = blocked; this.disable(); }
        disable() {
            this.select.disabled = !this.value?.levels?.length || this.blocked || this.pending;
            if (this.mobile) this.mobile.disabled = this.select.disabled;
        }
        render() {
            const levels = this.value?.levels || [], names = labels();
            this.field.hidden = levels.length === 0;
            if (this.mobileField) this.mobileField.hidden = this.field.hidden;
            this.select.replaceChildren(...levels.map(level => {
                const mode = this.value.modes?.[level];
                return new Option(mode ? `${names[level]} · ${t('费用 {0}×', mode.costMultiplier)}` : names[level], level);
            }));
            this.select.value = this.value?.level || 'auto';
            this.select.title = this.select.selectedOptions[0]?.textContent || t('速度');
            if (this.mobile) {
                this.mobile.replaceChildren(...levels.map(level => new Option(names[level], level))); this.mobile.value = this.select.value;
                this.mobileCost.textContent = Object.entries(this.value?.modes || {}).map(([level, mode]) => `${names[level]} · ${t('费用 {0}×', mode.costMultiplier)}`).join(' / ');
                this.mobileCost.hidden = !this.mobileCost.textContent;
            }
            this.summary.textContent = ['fast', 'ultrafast'].includes(this.value?.level) ? ` · ${names[this.value.level]}` : '';
            this.disable();
        }
        async change(level) {
            if (this.select.disabled || !this.value?.levels.includes(level)) { this.render(); return; }
            const epoch = this.epoch, generation = this.options.generation(), value = this.value;
            this.pending = true; this.disable(); this.options.changed();
            try {
                const result = await this.options.request({ runtimeId: value.runtimeId, revision: value.revision,
                    provider: value.provider, modelId: value.modelId, level });
                if (epoch !== this.epoch || generation !== this.options.generation()) return;
                this.apply(result);
                this.options.toast(t('速度：{0}', labels()[result.level]), 'success');
            } catch (error) { if (epoch === this.epoch && generation === this.options.generation()) this.options.toast(error.message, 'error'); }
            finally { if (epoch === this.epoch && generation === this.options.generation()) { this.pending = false; this.render(); this.options.changed(); } }
        }
    }
    globalThis.PiModelSpeed = PiModelSpeed;
})();
