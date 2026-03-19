// Base interface for LLM providers.
// Each provider implements generate(prompt) → string.

export class LLMProvider {
  constructor(name) {
    this.name = name;
  }

  async generate(_prompt) {
    throw new Error(`${this.name}: generate() not implemented`);
  }
}
