'use strict';

// Blocks credentials and prompt-injection payloads before they are persisted to
// profile memory or skills. Every Pivane knowledge write (manual web edit,
// background learning, Agent tool writes routed through the knowledge service,
// the full-document editor) passes here, because those paths do not call the
// upstream MemoryStore/SkillStore write methods that carry this check.
//
// The English threat and secret patterns are ported from pi-hermes-memory 0.9.9
// src/store/content-scanner.ts (MIT License, Copyright (c) 2025 Chandra Teja),
// which ports hermes-agent's memory threat scan. Pivane adds Chinese injection
// phrases, newer key prefixes and structured error codes. Unlike upstream, a bare
// variable name such as OPENAI_API_KEY is allowed: a name is not a secret, and
// "the project reads OPENAI_API_KEY from .env" is a useful procedure note.
// Messages never echo the matched content.

const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/u;

const THREATS = [
    [/ignore\s+(?:previous|all|above|prior)\s+instructions/i, 'prompt_injection'],
    [/you\s+are\s+now\s+/i, 'role_hijack'],
    [/do\s+not\s+tell\s+the\s+user/i, 'deception_hide'],
    [/system\s+prompt\s+override/i, 'sys_prompt_override'],
    [/disregard\s+(?:your|all|any)\s+(?:instructions|rules|guidelines)/i, 'disregard_rules'],
    [/act\s+as\s+(?:if|though)\s+you\s+(?:have\s+no|don'?t\s+have)\s+(?:restrictions|limits|rules)/i, 'bypass_restrictions'],
    [/curl\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_curl'],
    [/wget\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, 'exfil_wget'],
    [/cat\s+[^\n]*(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, 'read_secrets'],
    [/authorized_keys/i, 'ssh_backdoor'],
    [/\$HOME\/\.ssh|~\/\.ssh/i, 'ssh_access'],
    [/(?:忽略|无视|忘记|忘掉)(?:掉)?(?:你)?(?:之前|以上|上面|前面|先前|所有|全部)(?:的|所有的)?(?:所有)?(?:指令|指示|规则|要求|设定|提示词)/u, 'prompt_injection_zh'],
    [/不要(?:告诉|让)用户(?:知道)?/u, 'deception_hide_zh'],
    [/(?:覆盖|替换|泄露|输出)(?:你的)?系统提示词/u, 'sys_prompt_override_zh'],
];

const SECRETS = [
    [/\bsk-ant-(?:api|admin)\S{10,}/, 'anthropic_api_key'],
    [/\bsk-or-v1-\S{10,}/, 'openrouter_api_key'],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, 'openai_api_key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'aws_access_key'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'github_token'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'github_fine_grained_token'],
    [/\bglpat-[A-Za-z0-9_-]{20,}/, 'gitlab_token'],
    [/\bxox[abpr]-\S{10,}/, 'slack_token'],
    [/\bxapp-\S{10,}/, 'slack_app_token'],
    [/\bntn_\S{10,}/, 'notion_token'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'google_api_key'],
    [/\bhf_[A-Za-z0-9]{30,}/, 'huggingface_token'],
    [/\bBearer\s+\S{20,}/, 'bearer_auth_token'],
    [/-----BEGIN\s+(?:[A-Z]+\s+)?PRIVATE\s+KEY-----/, 'private_key_block'],
    [/\bpassword\s*[=:]\s*\S{6,}/i, 'password_assignment'],
    [/\bsecret\s*[=:]\s*\S{6,}/i, 'secret_assignment'],
    [/\btoken\s*[=:]\s*\S{10,}/i, 'token_assignment'],
    [/(?:密码|口令|密钥|令牌)\s*(?:是|为|[=:：])\s*\S{6,}/u, 'secret_assignment_zh'],
];

// Returns null when the text is safe, otherwise { rule, kind } without the matched text.
function scanKnowledgeContent(...parts) {
    const text = parts.filter(part => typeof part === 'string').join('\n');
    if (INVISIBLE.test(text)) return { rule: 'invisible_unicode', kind: 'injection' };
    for (const [pattern, rule] of THREATS) if (pattern.test(text)) return { rule, kind: 'injection' };
    for (const [pattern, rule] of SECRETS) if (pattern.test(text)) return { rule, kind: 'secret' };
    return null;
}

function assertSafeKnowledgeContent(...parts) {
    const found = scanKnowledgeContent(...parts);
    if (!found) return;
    const message = found.kind === 'secret'
        ? 'Content looks like a credential or secret and cannot be saved to memory or skills'
        : 'Content looks like a prompt-injection instruction and cannot be saved to memory or skills';
    throw Object.assign(new Error(message), { status: 400, code: 'content-blocked', details: found });
}

module.exports = { scanKnowledgeContent, assertSafeKnowledgeContent };
