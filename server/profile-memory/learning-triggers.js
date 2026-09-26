'use strict';

// Deterministic trigger phrases for background learning. A turn is queued for the
// immediate "correction" pass when the user corrects the assistant or states a
// lasting preference, is skipped when marked temporary, and otherwise waits for
// the periodic review. Built-in patterns cover Chinese and English; users add
// their own phrases (any language) per profile through learning settings.
//
// The English correction patterns follow pi-hermes-memory 0.9.9
// src/constants.ts CORRECTION_* (MIT License, Copyright (c) 2025 Chandra Teja):
// strong patterns always match, weak openers need a directive word after them,
// and negative openers suppress a match.

const LISTS = Object.freeze(['correction', 'preference', 'temporary', 'ignore']);
const MAX_PHRASES = 50, MAX_PHRASE = 80;
const EMPTY = Object.freeze(Object.fromEntries(LISTS.map(key => [key, Object.freeze([])])));

const ZH = {
    correction: /(?:不对|错了|纠正|更正|不是.{0,35}而是|应该是|应为|请记住.{0,50}(?:不是|而是))/u,
    preference: /(?:请|务必)?记住(?:[，,:： ]{0,3})?(?:以后|今后|往后)?|(?:以后|今后|往后)(?:请|要|默认|都|一直|按|使用|用)|(?:以后|今后|往后)[^，。,.!！?？]{1,8}(?:都|一直|默认|先|别|不要)|(?:请|要).{0,20}(?:记住|默认)/u,
    temporary: /(?:仅|只)(?:在|对|限于)?(?:这|本|此)(?:一)?(?:次|轮|回|条|个任务|段对话)|不要记住|别记住|临时(?:要求|用)/u,
    quoted: /^(?:比如|例子|引用|假设|如果|反问|举例|原文|示例|他说|她说|你说)[：:,，\s“"'‘]/u,
};
const EN = {
    strong: [/don'?t do that/i, /not like that/i, /^I said\b/i, /^I told you\b/i, /we already discussed/i, /^please don'?t\b/i,
        /^that'?s not what I/i, /\bthat'?s (?:wrong|incorrect|not right)\b/i, /\byou(?:'re| are) wrong\b/i],
    weak: [/^no[,.\s!]/i, /^wrong[,.\s!]/i, /^actually[,.\s]/i, /^stop[,.\s!]/i],
    negative: [/^no worries/i, /^no problem/i, /^no thanks/i, /^no need/i,
        /^no,?\s+(?:that(?:'s| is)|it(?:'s| is)) (?:all|it|fine|ok|okay|enough)\b/i,
        /^actually.{0,10}(?:looks? great|perfect|good|correct|right)/i, /^stop.{0,5}(?:there|here|for now)/i],
    directive: /\b(?:use|don'?t|dont|do|try|make|run|install|add|remove|delete|change|fix|put|set|write|go|stop|start|the|that|this|it|should|instead)\b/i,
    preference: /\b(?:remember (?:that|to)|from now on|going forward|in (?:the )?future,? (?:please|always|never|use)|I (?:always )?prefer|my preference is)\b|^(?:please\s+)?(?:always|never)\s/i,
    temporary: /\b(?:(?:just|only) (?:this|for this) (?:once|time|turn|task|conversation|reply)|this time only|for now only|don'?t (?:remember|save|memori[sz]e) (?:this|that))\b/i,
    quoted: /^(?:for example|e\.g\.|suppose|if|quote|he said|she said|you said)[:,\s"']/i,
};

// Plain phrases only (no user regex): case-insensitive substring matches.
function normalizePhrases(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
    return Object.freeze(Object.fromEntries(LISTS.map(key => [key, Object.freeze(Array.isArray(value[key])
        ? value[key].filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().toLocaleLowerCase()).slice(0, MAX_PHRASES)
        : [])])));
}
function validPhrases(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every(key => LISTS.includes(key))
        && LISTS.every(key => value[key] === undefined || Array.isArray(value[key]) && value[key].length <= MAX_PHRASES
            && value[key].every(item => typeof item === 'string' && item.trim() && item.length <= MAX_PHRASE && !/[\u0000-\u001f\u007f]/.test(item)));
}
const custom = (text, phrases, key) => {
    const list = phrases?.[key] || [];
    if (!list.length) return false;
    const lower = String(text).toLocaleLowerCase();
    return list.some(item => lower.includes(item));
};
const ignored = (text, phrases) => custom(text, phrases, 'ignore') || EN.negative.some(pattern => pattern.test(text));

function correction(text, phrases = EMPTY) {
    if (typeof text !== 'string' || ignored(text, phrases)) return false;
    if (ZH.correction.test(text) || EN.strong.some(pattern => pattern.test(text)) || custom(text, phrases, 'correction')) return true;
    for (const pattern of EN.weak) {
        const match = pattern.exec(text);
        if (match && match.index === 0 && EN.directive.test(text.slice(match[0].length))) return true;
    }
    return false;
}
function preference(text, phrases = EMPTY) {
    return typeof text === 'string' && !ignored(text, phrases)
        && (ZH.preference.test(text) || EN.preference.test(text) || custom(text, phrases, 'preference'));
}
function temporary(text, phrases = EMPTY) {
    return typeof text === 'string' && (ZH.temporary.test(text) || EN.temporary.test(text) || custom(text, phrases, 'temporary'));
}
// Questions and quoted or hypothetical text are not instructions to remember.
function intent(text) {
    return typeof text === 'string' && !/[?？]\s*$/u.test(text) && !ZH.quoted.test(text) && !EN.quoted.test(text);
}

module.exports = { LISTS, MAX_PHRASES, MAX_PHRASE, EMPTY, normalizePhrases, validPhrases, correction, preference, temporary, intent };
