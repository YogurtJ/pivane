# LinkedIn Post — Pi Hermes Memory v0.4

**Best time to post:** 7:30-8:30 AM (morning engagement peak)

**Attach:** `docs/images/pi_memory.png` as the post image

---

🚀 **I just open-sourced a persistent memory system for AI coding agents.**

Every time you start a new session with an AI coding agent, it forgets everything. That debugging session from last week? Gone. The architecture decision you discussed for 2 hours? Vanished. The user preferences you explained 5 times? You'll explain them a 6th.

I got tired of re-explaining context every session. So I built **Pi Hermes Memory** — an extension that gives your AI agent a brain that actually works.

**What it does:**

🧠 **Persistent memory** — facts, preferences, corrections survive across sessions
🔍 **Cross-session & cross-project search** — find any conversation across ALL your projects
📚 **Procedural skills** — the agent saves *how* it solved problems, not just what
🛡️ **Secret scanning** — API keys and tokens are blocked from being persisted
⚡ **Background learning** — reviews your conversation every 10 turns and saves what matters

**The key insight:**

Most memory tools only remember facts. Mine remembers:
- **What you said** (session history — searchable via FTS5)
- **What you learned** (episodic memory — builds over time)
- **How you solved problems** (procedural skills — reusable patterns)
- **What you corrected** (corrections — saves immediately)

And it works **across all your projects**. Ask "what did we discuss about auth?" and it searches every session, every project, instantly.

**The architecture:**

- Core memory (MEMORY.md): Always in context, 5,000 chars
- Extended memory (SQLite): Unlimited, searchable on demand
- Session history (FTS5): Full-text search across all past conversations
- Skills (SKILL.md): Procedural knowledge that builds over time

**The result?**

Instead of starting from zero every session, my agent now says:

*"Last Tuesday we discussed implementing JWT with refresh tokens. You preferred httpOnly cookies over localStorage. We also decided to use the auth0 SDK. Want me to continue from there?"*

**Technical details:**
- 272 tests
- SQLite with FTS5 for fast full-text search
- Hybrid memory: core (always in context) + extended (searchable on demand)
- Auto-consolidation when memory fills up
- Correction detection (saves immediately when you correct the agent)

It's open source and works with the Pi coding agent.

**Get started:**
```
pi install npm:pi-hermes-memory
/memory-index-sessions
```

Your AI agent should remember as much as you do. Now it does.

GitHub: https://github.com/chandra447/pi-hermes-memory
npm: https://www.npmjs.com/package/pi-hermes-memory

---

#coding-agent #agent-harness #memory #ai

---

## Posting Tips

1. **Attach the logo image** — `docs/images/pi_memory.png`
2. **Post at 7:30-8:30 AM** — morning coffee + LinkedIn scroll time
3. **Engage with comments** in the first 2 hours — LinkedIn rewards early engagement
4. **Reply to everyone** — even simple "thanks!" helps visibility
5. **Share to relevant groups** if you're in any AI/dev communities
6. **Tag people** if you know anyone in the Pi community or AI dev space

## Hashtag Strategy

Primary (high volume):
- #AI
- #OpenSource
- #SoftwareEngineering
- #DevTools

Niche (targeted):
- #CodingAgent
- #DeveloperProductivity
- #MachineLearning
- #ArtificialIntelligence

Brand (discoverable):
- #Pi
- #TypeScript
