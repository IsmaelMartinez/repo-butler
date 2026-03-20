import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIssueTitle, validateIssueBody,
  validateRoadmap, validateIdeas, validateProvider,
} from './safety.js';

describe('validateIssueTitle', () => {
  it('accepts valid titles', () => {
    const result = validateIssueTitle('Add automated dependency updates');
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects empty titles', () => {
    assert.equal(validateIssueTitle('').valid, false);
    assert.equal(validateIssueTitle(null).valid, false);
  });

  it('accepts titles at exactly 120 chars', () => {
    assert.equal(validateIssueTitle('A'.repeat(120)).valid, true);
  });

  it('rejects titles over 120 chars', () => {
    assert.equal(validateIssueTitle('A'.repeat(121)).valid, false);
  });

  it('rejects titles with newlines', () => {
    assert.equal(validateIssueTitle('Line one\nLine two').valid, false);
  });

  it('rejects titles containing API keys', () => {
    assert.equal(validateIssueTitle('Use key AIzaSyB1234567890abcdefghijklmnopqrst').valid, false);
  });
});

describe('validateIssueBody', () => {
  it('accepts valid markdown body', () => {
    const body = 'This issue proposes adding a feature.\n\nSee https://github.com/IsmaelMartinez/repo-butler for details.';
    assert.equal(validateIssueBody(body).valid, true);
  });

  it('rejects bodies with disallowed URLs', () => {
    const body = 'Check out https://evil-site.com/payload for more info.';
    const result = validateIssueBody(body);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('disallowed host')));
  });

  it('rejects bodies with @mentions to real users', () => {
    const body = 'Hey @IsmaelMartinez can you review this?';
    const result = validateIssueBody(body);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('@mention')));
  });

  it('allows @repo-butler and @dependabot mentions', () => {
    const body = 'Created by @repo-butler, reviewed by @dependabot.';
    assert.equal(validateIssueBody(body).valid, true);
  });

  it('rejects bodies with script tags', () => {
    const body = 'Normal text <script>alert("xss")</script>';
    assert.equal(validateIssueBody(body).valid, false);
  });

  it('rejects bodies with leaked tokens', () => {
    const body = 'Use ghp_abcdefghijklmnopqrstuvwxyz1234567890 to authenticate.';
    assert.equal(validateIssueBody(body).valid, false);
  });

  it('rejects bodies over 8000 chars', () => {
    const body = 'A'.repeat(8001);
    assert.equal(validateIssueBody(body).valid, false);
  });
});

describe('validateRoadmap', () => {
  it('accepts valid markdown roadmap', () => {
    const content = '# Roadmap\n\n## Next Up\n\n- Feature A\n- Feature B\n\nSee https://github.com/IsmaelMartinez/teams-for-linux for context.';
    assert.equal(validateRoadmap(content).valid, true);
  });

  it('rejects suspiciously short content', () => {
    assert.equal(validateRoadmap('Error: rate limited').valid, false);
  });

  it('rejects content without markdown headings', () => {
    const noHeadings = 'This is just a paragraph of text without any structure or headings at all and it goes on for a while to pass the length check.';
    assert.equal(validateRoadmap(noHeadings).valid, false);
  });

  it('rejects roadmaps with external URLs', () => {
    const content = '# Roadmap\n\nVisit https://phishing-site.com/steal for details.\n\n' + 'x'.repeat(100);
    const result = validateRoadmap(content);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('disallowed host')));
  });
});

describe('validateIdeas', () => {
  it('passes valid ideas through', () => {
    const ideas = [
      { title: 'Add tests', priority: 'high', body: 'We need more tests.', labels: ['testing'] },
      { title: 'Update docs', priority: 'low', body: 'Docs are outdated.', labels: ['docs'] },
    ];
    const result = validateIdeas(ideas);
    assert.equal(result.valid, true);
    assert.equal(result.filtered.length, 2);
  });

  it('filters out ideas with bad titles', () => {
    const ideas = [
      { title: 'Good idea', priority: 'medium', body: 'This is fine.', labels: [] },
      { title: 'A'.repeat(200), priority: 'medium', body: 'Title too long.', labels: [] },
    ];
    const result = validateIdeas(ideas);
    assert.equal(result.filtered.length, 1);
    assert.equal(result.filtered[0].title, 'Good idea');
  });

  it('filters out ideas with @mentions in body', () => {
    const ideas = [
      { title: 'Ping someone', priority: 'high', body: 'Hey @victim check this out.', labels: [] },
    ];
    const result = validateIdeas(ideas);
    assert.equal(result.filtered.length, 0);
    assert.equal(result.valid, false);
  });

  it('rejects empty ideas array', () => {
    assert.equal(validateIdeas([]).valid, false);
    assert.equal(validateIdeas(null).valid, false);
  });

  it('rejects ideas with invalid priority', () => {
    const ideas = [
      { title: 'Bad priority', priority: 'critical', body: 'Not a valid priority.', labels: [] },
    ];
    const result = validateIdeas(ideas);
    assert.equal(result.filtered.length, 0);
  });
});

describe('validateProvider', () => {
  it('passes when provider returns OK', async () => {
    const mock = { generate: async () => 'OK' };
    const result = await validateProvider(mock);
    assert.equal(result.valid, true);
  });

  it('passes when provider returns OK with extra text', async () => {
    const mock = { generate: async () => 'OK, I am ready.' };
    const result = await validateProvider(mock);
    assert.equal(result.valid, true);
  });

  it('fails when provider returns unexpected text', async () => {
    const mock = { generate: async () => 'Error: invalid API key' };
    const result = await validateProvider(mock);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('unexpected response'));
  });

  it('fails when provider returns empty', async () => {
    const mock = { generate: async () => '' };
    const result = await validateProvider(mock);
    assert.equal(result.valid, false);
  });

  it('fails when provider throws', async () => {
    const mock = { generate: async () => { throw new Error('403 Forbidden'); } };
    const result = await validateProvider(mock);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('403 Forbidden'));
  });
});
