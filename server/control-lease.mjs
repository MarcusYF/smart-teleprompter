// One presentation controller at a time, with a short renewable lease.
export class ControlLease {
  constructor(now = () => Date.now(), ttlMs = 8000) { this.now = now; this.ttl = ttlMs; this.current = null; }
  claim(owner, pageId) {
    if (![owner, pageId].every(id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id))) throw Object.assign(new Error('Invalid controller identity'), { status: 400 });
    if (this.current && this.current.expiresAt > this.now() && this.current.owner !== owner) throw Object.assign(new Error('Another window is controlling this presentation. Stop its listening session first.'), { status: 409 });
    this.current = { owner, pageId, expiresAt: this.now() + this.ttl };
    return { ok: true, ...this.current };
  }
  assert(owner) {
    if (!owner || !this.current || this.current.owner !== owner || this.current.expiresAt <= this.now()) throw Object.assign(new Error('Presentation control session expired'), { status: 409 });
  }
  release(owner) { if (this.current?.owner === owner) this.current = null; }
  disconnect(pageId) { if (this.current?.pageId === pageId) this.current = null; }
}
