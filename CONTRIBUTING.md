# Contributing to Repo Butler

Thanks for your interest in contributing! This guide covers the workflow and conventions you need to know.

## Getting Started

Repo Butler is a GitHub Action built with Node 22 and ES modules. It has zero npm dependencies by design -- do not add any packages. The project uses only Node built-in APIs (fetch, crypto, fs/promises).

To set up locally:

1. Fork and clone the repository.
2. Ensure you have Node.js 22 or later installed.
3. Copy `.env.example` to `.env.local` and add your GitHub token (if running the pipeline locally).

## Making Changes

Create a feature branch from `main`, make your changes, and open a pull request. Keep PRs focused on a single change when possible.

Run the test suite before submitting:

```bash
npm test
```

Tests use `node:test` and `node:assert/strict`, and are colocated as `*.test.js` files alongside the modules they test. If you're adding new functionality, add tests in the same pattern.

For a dry run of the full pipeline without writing to GitHub:

```bash
INPUT_DRY_RUN=true npm start
```

## Project Conventions

All source code lives in `src/`. The pipeline runs six phases (OBSERVE, ASSESS, UPDATE, IDEATE, PROPOSE, REPORT), each as an independent module. `src/github.js` is the shared API client, and `src/safety.js` validates all LLM output before it reaches GitHub.

When working with the GitHub API, prefer list/paginate endpoints over the search API to stay within rate limits. New API fetchers in `observe.js` should follow the existing try/catch pattern and return `null` on failure.

Config lives in `.github/roadmap.yml` with defaults in `src/config.js`.

## Pull Request Process

Every PR receives automated code review from CodeRabbit and Gemini Code Assist. These reviews typically complete within a few minutes. Please address or respond to all review comments before requesting a merge.

Your PR should include a brief summary of the change, a test plan, and confirmation that `npm test` passes.

## Reporting Issues

Use the issue templates provided. For bugs, include steps to reproduce and any relevant log output. For feature requests, describe the use case and expected behavior.
