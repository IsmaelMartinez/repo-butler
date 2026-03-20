// Safety validators for LLM-generated output.
// Structural checks run before any content is published (PRs, issues).
// Inspired by the triage bot's two-layer safety model (ADR-001).

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 8000;
const MAX_ROADMAP_LENGTH = 50000;

// Domains allowed in generated content.
const ALLOWED_URL_HOSTS = [
  'github.com',
  'ismaelmartinez.github.io',
];

// Patterns that should never appear in generated output.
const BLOCKED_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,         // OpenAI-style API keys
  /\bAIza[a-zA-Z0-9_-]{30,}\b/,      // Google API keys
  /\bghp_[a-zA-Z0-9]{36}\b/,         // GitHub personal access tokens
  /\bghs_[a-zA-Z0-9]{36}\b/,         // GitHub server tokens
  /\bpassword\s*[:=]\s*\S+/i,        // Password assignments
  /<script[\s>]/i,                     // Script injection
  /javascript:/i,                      // JS protocol
];

export function validateIssueTitle(title) {
  const errors = [];

  if (!title || typeof title !== 'string') {
    errors.push('Title is empty or not a string');
    return { valid: false, errors };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    errors.push(`Title too long (${title.length}/${MAX_TITLE_LENGTH})`);
  }

  if (title.includes('\n')) {
    errors.push('Title contains newlines');
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(title)) {
      errors.push(`Title contains blocked pattern: ${pattern.source.slice(0, 30)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateIssueBody(body) {
  const errors = [];

  if (!body || typeof body !== 'string') {
    errors.push('Body is empty or not a string');
    return { valid: false, errors };
  }

  if (body.length > MAX_BODY_LENGTH) {
    errors.push(`Body too long (${body.length}/${MAX_BODY_LENGTH})`);
  }

  const urlErrors = validateUrls(body);
  errors.push(...urlErrors);

  const mentionErrors = validateMentions(body);
  errors.push(...mentionErrors);

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(body)) {
      errors.push(`Body contains blocked pattern: ${pattern.source.slice(0, 30)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateRoadmap(content) {
  const errors = [];

  if (!content || typeof content !== 'string') {
    errors.push('Roadmap content is empty or not a string');
    return { valid: false, errors };
  }

  if (content.length > MAX_ROADMAP_LENGTH) {
    errors.push(`Roadmap too long (${content.length}/${MAX_ROADMAP_LENGTH})`);
  }

  if (content.length < 100) {
    errors.push('Roadmap suspiciously short — LLM may have returned an error message');
  }

  // Must look like markdown.
  if (!content.includes('#')) {
    errors.push('Roadmap contains no markdown headings — likely not valid markdown');
  }

  const urlErrors = validateUrls(content);
  errors.push(...urlErrors);

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(content)) {
      errors.push(`Roadmap contains blocked pattern: ${pattern.source.slice(0, 30)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateIdeas(ideas) {
  const errors = [];

  if (!Array.isArray(ideas) || ideas.length === 0) {
    errors.push('No ideas generated — LLM may have returned unparseable output');
    return { valid: false, errors, filtered: [] };
  }

  const filtered = [];

  for (const idea of ideas) {
    const ideaErrors = [];

    const titleResult = validateIssueTitle(idea.title);
    ideaErrors.push(...titleResult.errors.map(e => `Idea "${idea.title?.slice(0, 40)}": ${e}`));

    const bodyResult = validateIssueBody(idea.body);
    ideaErrors.push(...bodyResult.errors.map(e => `Idea "${idea.title?.slice(0, 40)}": ${e}`));

    const validPriorities = ['high', 'medium', 'low'];
    if (!validPriorities.includes(idea.priority)) {
      ideaErrors.push(`Idea "${idea.title?.slice(0, 40)}": invalid priority "${idea.priority}"`);
    }

    if (ideaErrors.length === 0) {
      filtered.push(idea);
    } else {
      errors.push(...ideaErrors);
      console.warn(`Dropped idea "${idea.title?.slice(0, 50)}" — ${ideaErrors.length} safety errors`);
    }
  }

  return { valid: filtered.length > 0, errors, filtered };
}

// Validate that an LLM provider responds before running the full pipeline.
export async function validateProvider(provider) {
  try {
    const response = await provider.generate('Respond with exactly the word OK and nothing else.');
    if (!response || typeof response !== 'string') {
      return { valid: false, error: 'Provider returned empty response' };
    }
    if (!response.trim().startsWith('OK')) {
      return { valid: false, error: `Provider returned unexpected response: "${response.slice(0, 100)}"` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Provider test failed: ${err.message}` };
  }
}


// --- Internal helpers ---

function validateUrls(text) {
  const errors = [];
  const urlRegex = /https?:\/\/[^\s)>\]"']+/g;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    try {
      const url = new URL(match[0]);
      const host = url.hostname;
      const isAllowed = ALLOWED_URL_HOSTS.some(
        allowed => host === allowed || host.endsWith(`.${allowed}`)
      );
      if (!isAllowed) {
        errors.push(`URL with disallowed host: ${host}`);
      }
    } catch {
      // Malformed URL — skip.
    }
  }

  return errors;
}

function validateMentions(text) {
  const errors = [];
  // Match @username patterns but not email addresses.
  const mentionRegex = /(?<!\S)@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)/g;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    const username = match[1];
    // Allow bot self-references and common non-user mentions.
    const allowed = ['repo-butler', 'dependabot', 'github-actions'];
    if (!allowed.includes(username.toLowerCase())) {
      errors.push(`Body contains @mention: @${username} — LLM should not ping real users`);
    }
  }

  return errors;
}
