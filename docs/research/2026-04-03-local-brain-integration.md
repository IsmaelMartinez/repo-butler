# Giving Reginald a Local Brain — Research

Date: 2026-04-03

## Context

Repo-butler (Reginald) runs a 6-phase pipeline daily at 2am UTC to observe repos, assess health, generate improvement ideas, and produce dashboards. It currently uses Gemini Flash (free tier, default provider) and Claude Sonnet (deep provider for IDEATE). Both are cloud APIs.

Separately, the local-brain project has validated LoRA fine-tuning on personal data (spike 09) — training a local model on commit messages, Claude Code session history, and CLAUDE.md conventions to produce a model that understands the owner's style, preferences, and patterns. The fine-tuned model produces conventional commit messages and understands PLG infrastructure conventions without explicit prompting.

The question: can we give Reginald a local model with personality — one that reasons about the portfolio using a model shaped by the owner's own engineering style?

## Why This Is Interesting

Reginald's current LLM calls are generic. The IDEATE phase preamble says "You are a technical advisor for an open-source project" or "You are a portfolio governance advisor." It has no knowledge of how the owner actually thinks about infrastructure, what conventions matter, or what style of proposals would actually get implemented. The proposals read like they came from a stranger who read the README.

A fine-tuned local model would change the tone entirely. Instead of "Consider implementing a CI/CD pipeline for improved reliability," Reginald would propose "feat: add gitlab-ci.yml with the standard PLG pipeline template from core-provisioning" — because it knows the owner's conventions, their commit style, and their infrastructure patterns. The butler would sound like the butler, not like a generic chatbot wearing a top hat.

## Integration Architecture

Repo-butler has a clean provider abstraction. Every LLM call goes through `LLMProvider.generate(prompt) → string`. Adding a local provider means creating one file:

```
src/providers/local.js
```

This provider would call Ollama's OpenAI-compatible API at `http://localhost:11434/v1/chat/completions` with the fine-tuned model. The key design decision is whether to use a base Ollama model (e.g. `qwen3-coder:30b-a3b-q8_0`) with a personality system prompt, or serve the LoRA-adapted model via a custom Modelfile.

### Option A: Base model + system prompt

The simpler approach. Use any Ollama model and inject a system prompt that encodes Reginald's personality and the owner's conventions. No fine-tuning infrastructure needed at runtime. The system prompt would draw from conventions extracted during the local-brain fine-tuning process.

Pros: zero setup beyond Ollama, easy to iterate on the personality, works with any model. Cons: limited by context window for convention knowledge, personality is prompt-engineered rather than baked in.

### Option B: Fine-tuned model via Ollama Modelfile

Create an Ollama Modelfile that loads the base model with the LoRA adapter from local-brain's spike 09 output. The personality and conventions are in the weights, not the prompt. This frees up the full context window for the actual portfolio data.

Pros: deeper personalisation, full context window available for data, feels more genuinely "shaped." Cons: requires the fine-tuning pipeline to have run, model must be registered with Ollama, adapter updates need redeployment.

### Option C: Hybrid

Use the fine-tuned model for IDEATE (where personality and deep understanding matter) and a base model with system prompt for ASSESS (where summarisation quality is more important than personality). This mirrors the existing default/deep provider split.

### Recommendation

Start with Option A. The provider is trivial to implement, and the personality via system prompt is immediately testable. If the results are promising, evolve to Option B by integrating the local-brain fine-tuning pipeline. Option C is the eventual target but premature to implement now.

## The Provider Implementation

The `local.js` provider would follow the same pattern as `gemini.js` and `claude.js`:

```javascript
import { LLMProvider } from './base.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const DEFAULT_MODEL = 'qwen3-coder:30b-a3b-q8_0';

export class LocalProvider extends LLMProvider {
  constructor({ endpoint, model, systemPrompt } = {}) {
    super('local');
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.model = model || DEFAULT_MODEL;
    this.systemPrompt = systemPrompt || REGINALD_PROMPT;
  }

  async generate(prompt) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Local LLM error: ${res.status} ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content
      || (() => { throw new Error('Local LLM returned no content'); })();
  }
}
```

Zero dependencies. Uses Node 22 built-in fetch. Fits the existing patterns exactly.

## Reginald's Personality

The system prompt is where the butler comes to life. Rather than generic "you are a technical advisor," Reginald would have a voice:

```
You are Reginald, a meticulous portfolio butler for a cloud infrastructure team.
You understand PLG engineering conventions: conventional commits (feat/fix/chore
prefixes), layered Terraform architecture, UK English, ADR-driven decisions,
safety-first validation, and zero-dependency Node.js where possible.

When proposing improvements, be specific and actionable. Reference actual
conventions from the portfolio. Prefer small, focused changes over sweeping
refactors. Use the owner's commit style when suggesting titles.

You observe before you act. You are concise, practical, and slightly dry.
You do not over-engineer.
```

This prompt alone, paired with a capable 30B model, would make the IDEATE output noticeably more relevant. The fine-tuned model (Option B) would amplify this further because the conventions would be in the weights, not consuming prompt tokens.

## Configuration

Following repo-butler's existing `.github/roadmap.yml` pattern:

```yaml
providers:
  default: gemini
  deep: local           # Use local model for IDEATE
  local:
    endpoint: http://localhost:11434/v1/chat/completions
    model: qwen3-coder:30b-a3b-q8_0
```

The provider initialisation in `src/index.js` would check for `config.providers.local` and instantiate `LocalProvider` accordingly. The existing fallback logic (deep → default) continues to work.

## When Does This Run?

Repo-butler runs as a GitHub Action at 2am UTC. The Action runner doesn't have access to the local Ollama instance. This means the local provider is for local runs only — `npm start` on the developer machine, or triggered via MCP's `trigger_refresh` tool.

This is actually a feature, not a limitation. The cloud providers handle the automated daily runs. The local provider gives Reginald a different voice when the owner is interacting directly — via the MCP server, via local CLI runs, or during development. The butler behaves differently when the master is home.

For fully local automated runs, the alternative is a launchd plist on macOS that runs repo-butler locally via cron, bypassing GitHub Actions entirely. This would use zero cloud API credits and keep all reasoning on-device.

## Connection to local-brain

The local-brain project (~/projects/github/local-brain) is exploring a "caddie" concept — a fine-tuned local model that understands the owner's patterns. If that fine-tuning pipeline matures, repo-butler's local provider could consume the resulting adapter directly. The data pipeline would be:

```
Claude Code sessions + commits + CLAUDE.md files
    → local-brain fine-tuning pipeline
    → LoRA adapter
    → Ollama Modelfile
    → repo-butler LocalProvider
```

This creates a feedback loop: repo-butler observes repos and proposes improvements, local-brain learns from the owner's responses to those proposals, and the fine-tuned model improves its future proposals. The butler learns what the master actually implements.

## Open Questions

1. Should the local provider validate connectivity at startup (like Gemini's "respond with OK" check), or fail gracefully per-call?
2. How should the MCP server handle queries when Ollama isn't running? Fall back to cached responses, or return an error?
3. Is the 30B model sufficient for IDEATE quality, or does governance analysis need the 70B Nemotron?
4. Should Reginald's personality prompt be hardcoded or configurable via roadmap.yml?
5. Can the launchd cron approach replace the GitHub Action entirely for a single-user setup?

## Next Steps

1. Implement `src/providers/local.js` (Option A — base model + system prompt)
2. Add `local` to provider config in `src/index.js`
3. Test locally with `INPUT_PHASE=ideate npm start`
4. Compare IDEATE output: Gemini vs Claude vs Local
5. If promising, integrate local-brain's fine-tuning pipeline (Option B)
