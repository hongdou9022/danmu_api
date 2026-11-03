// Request-local response deduplication can retain large segment payloads.
// Keep only recent cached copies; each original httpGet result still flows to
// its caller and is not sampled or truncated.
export class BoundedResponseCache extends Map {
  constructor(maxEntries = 16) {
    super();
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 16));
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    if (super.has(key)) super.delete(key);
    super.set(key, value);
    while (super.size > this.maxEntries) {
      super.delete(super.keys().next().value);
    }
    return this;
  }
}
