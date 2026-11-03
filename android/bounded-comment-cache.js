// Keep whole comment responses so upstream count/order semantics remain
// untouched, but let Android retain only the most recently used episodes.
export class BoundedLruMap extends Map {
  constructor(maxEntries = 2) {
    super();
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 2));
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
