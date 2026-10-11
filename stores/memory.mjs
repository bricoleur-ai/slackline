// In-memory backend — zero deps, ephemeral (lost on exit). For quick/throwaway use.
export class MemoryStore {
  // thr/outb: key -> timestamp (not bare Sets) so exportTable can round-trip hydrated_at/at —
  // migrating into sqlite/postgres, whose threads/outbound tables carry that column, would
  // otherwise silently fabricate a fresh "now" on every import. .has()/.add() callers below
  // still work unchanged since Map has the same .has(), and .set(k, v) replaces .add(k).
  constructor() { this.msgs = new Map(); this.us = new Map(); this.chs = new Map(); this.thr = new Map(); this.outb = new Map(); this.tok = new Map(); this.apps = new Map(); this.keys = new Map(); this.keyReqs = new Map(); this.pendingOutbound = new Map(); }
  async init() {}
  _k(o, c, t) { return o + '|' + c + '|' + t; }
  _list(org, channel) { return [...this.msgs.values()].filter(m => m.org === org && (!channel || m.channel === channel)).sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0); }

  async putMessage(m) {
    const k = this._k(m.org, m.channel, m.ts), ex = this.msgs.get(k);
    const files = m.files_json ? (typeof m.files_json === 'string' ? JSON.parse(m.files_json) : m.files_json) : (ex ? ex.files_json : null);
    this.msgs.set(k, { org: m.org, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts ?? (ex ? ex.thread_ts : null),
      user: m.user ?? (ex ? ex.user : null), subtype: m.subtype ?? null, text: m.text ?? '',
      has_files: m.has_files ? 1 : 0, files_json: files, edited: m.edited ? 1 : 0,
      // See the sqlite store for why 'human' is sticky alongside 'hub': backfill must never
      // downgrade a live-ingest classification of our own messages.
      origin: (ex && (ex.origin === 'hub' || ex.origin === 'human')) ? ex.origin : (m.origin ?? (ex ? ex.origin : null)),
      deleted: ex ? ex.deleted : 0, deleted_at: ex ? ex.deleted_at : null,
      reactions: ex ? ex.reactions : {}, at: m.at ?? Date.now() });
  }
  async recent(org, channel, limit = 20) { return this._list(org, channel).slice(-limit); }
  async getMessage(org, channel, ts) { return this.msgs.get(this._k(org, channel, ts)) || null; }
  async thread(org, channel, thread_ts) { return this._list(org, channel).filter(m => m.thread_ts === thread_ts || m.ts === thread_ts); }
  async search(org, term, limit = 30) { const t = term.toLowerCase(); return this._list(org).filter(m => (m.text || '').toLowerCase().includes(t)).slice(-limit).reverse(); }
  async around(org, channel, ts, before = 6, after = 3) {
    const all = this._list(org, channel); const i = all.findIndex(m => m.ts === ts);
    if (i < 0) return all.filter(m => m.ts <= ts).slice(-(before + 1));
    return all.slice(Math.max(0, i - before), i + 1 + after);
  }
  async putUser(org, u) { this.us.set(this._k(org, u.id, ''), { org, id: u.id, name: u.name ?? null, real_name: u.real_name ?? null, display_name: u.display_name ?? null, tz: u.tz ?? null, is_bot: u.is_bot ? 1 : 0, updated: Date.now() }); }
  async getUser(org, id) { return this.us.get(this._k(org, id, '')) || null; }
  async putChannel(org, c) { this.chs.set(this._k(org, c.id, ''), { org, id: c.id, name: c.name ?? null, is_private: c.is_private ? 1 : 0, is_im: c.is_im ? 1 : 0, is_mpim: c.is_mpim ? 1 : 0, updated: Date.now() }); }
  async getChannel(org, id) { return this.chs.get(this._k(org, id, '')) || null; }
  async threadHydrated(org, channel, thread_ts) { return this.thr.has(this._k(org, channel, thread_ts)); }
  async markThreadHydrated(org, channel, thread_ts) { this.thr.set(this._k(org, channel, thread_ts), Date.now()); }
  async putToken(t) { this.tok.set(t.org, { org: t.org, team_name: t.team_name ?? null, token: t.token, cookie: t.cookie, user_id: t.user_id ?? null, updated: Date.now() }); }
  async getTokens() { return [...this.tok.values()]; }
  async putApp(a) { this.apps.set(a.org, { ...a }); }
  async getApp(org) { return this.apps.get(org) || null; }
  async listApps() { return [...this.apps.values()]; }
  // ---- keys: scoped consumer credentials (see keys.mjs — hash only, never raw key material) --
  async putKey(k) { this.keys.set(k.id, { id: k.id, hash: k.hash, label: k.label ?? null, orgs: k.orgs ?? '*', created: k.created ?? Date.now(), last_used: k.last_used ?? null, revoked: k.revoked ? 1 : 0 }); }
  async getKey(id) { return this.keys.get(id) || null; }
  async listKeys() { return [...this.keys.values()]; }
  async touchKey(id) { const k = this.keys.get(id); if (k) k.last_used = Date.now(); }
  async revokeKey(id) { const k = this.keys.get(id); if (!k) return false; k.revoked = 1; return true; }

  // ---- key_requests: Slack-mediated key approval flow (see keyrequest.mjs). Metadata only —
  // poll_hash is a hash of the poll token, and key_id (set only once approved) is a key's PUBLIC
  // id; the raw key itself is never written here. Mutations below are single-purpose atomic ops
  // (mirrors touchKey/revokeKey above) rather than a generic update, so every state transition is
  // exactly the one keyrequest.mjs asks for — see that file's header for the idempotency story.
  async putKeyRequest(r) {
    this.keyReqs.set(r.id, { id: r.id, poll_hash: r.poll_hash, code: r.code, label: r.label ?? '',
      orgs: r.orgs, requester: r.requester ?? '', status: r.status ?? 'pending', created: r.created ?? Date.now(),
      expires_at: r.expires_at, approver_org: r.approver_org, dm_channel: r.dm_channel ?? null,
      decided_at: r.decided_at ?? null, decided_by: r.decided_by ?? null, key_id: r.key_id ?? null,
      delivered: r.delivered ? 1 : 0 });
  }
  async getKeyRequest(id) { return this.keyReqs.get(id) || null; }
  async getPendingKeyRequestByCode(code) {
    let best = null;
    for (const r of this.keyReqs.values()) if (r.status === 'pending' && r.code === code && (!best || r.created > best.created)) best = r;
    return best || null;
  }
  async listKeyRequests() { return [...this.keyReqs.values()].sort((a, b) => b.created - a.created); }
  async countPendingKeyRequests(now = Date.now()) {
    let n = 0; for (const r of this.keyReqs.values()) if (r.status === 'pending' && r.expires_at > now) n++; return n;
  }
  async claimKeyRequestApproval(id, { decided_by, decided_at }) {
    const r = this.keyReqs.get(id); if (!r || r.status !== 'pending') return false;
    r.status = 'approved'; r.decided_by = decided_by; r.decided_at = decided_at; return true;
  }
  async setKeyRequestKeyId(id, key_id) { const r = this.keyReqs.get(id); if (r) r.key_id = key_id; }
  async denyKeyRequest(id, { decided_by, decided_at }) {
    const r = this.keyReqs.get(id); if (!r || r.status !== 'pending') return false;
    r.status = 'denied'; r.decided_by = decided_by; r.decided_at = decided_at; return true;
  }
  async expireKeyRequest(id) {
    const r = this.keyReqs.get(id); if (!r || r.status !== 'pending') return false;
    r.status = 'expired'; return true;
  }
  async revertKeyRequestToPending(id) {
    const r = this.keyReqs.get(id); if (!r || r.status !== 'approved') return false;
    r.status = 'pending'; r.key_id = null; r.decided_by = null; r.decided_at = null; return true;
  }
  async markKeyRequestDelivered(id) {
    const r = this.keyReqs.get(id); if (!r || r.delivered) return false;
    r.delivered = 1; return true;
  }

  async putOutbound(org, channel, ts) { this.outb.set(this._k(org, channel, ts), Date.now()); }
  async isOutbound(org, channel, ts) { return this.outb.has(this._k(org, channel, ts)); }
  async setReaction(org, channel, ts, emoji, user, add = true) {
    const m = this.msgs.get(this._k(org, channel, ts)); if (!m) return 0;
    const r = m.reactions || {}; const set = new Set(r[emoji] || []); add ? set.add(user) : set.delete(user);
    if (set.size) r[emoji] = [...set]; else delete r[emoji]; m.reactions = r; return 1;
  }
  async markDeleted(org, channel, ts) { const m = this.msgs.get(this._k(org, channel, ts)); if (!m) return 0; m.deleted = 1; m.deleted_at = Date.now(); return 1; }
  async setLocalFiles(org, channel, ts, files_json) { const m = this.msgs.get(this._k(org, channel, ts)); if (m) m.files_json = typeof files_json === 'string' ? JSON.parse(files_json) : files_json; }
  async since(org, channels, sinceTs, limit = 1000) { const cs = new Set(channels || []); return this._list(org).filter(m => cs.has(m.channel) && m.ts > sinceTs).slice(0, limit); }
  async reconcileOutbound() { for (const m of this.msgs.values()) if (m.origin !== 'hub' && this.outb.has(this._k(m.org, m.channel, m.ts))) m.origin = 'hub'; }
  async prune(retainMs) { const cut = Date.now() - retainMs; let n = 0; for (const [k, m] of this.msgs) if (m.at < cut) { this.msgs.delete(k); n++; } return n; }
  async stats() { let del = 0; for (const m of this.msgs.values()) if (m.deleted) del++; return { messages: this.msgs.size, deleted: del, users: this.us.size, channels: this.chs.size, orgs: this.tok.size }; }

  // ---- migration: bulk dump/load, same portable row shape all three backends agree on
  // (booleans as real true/false, files_json/reactions as parsed objects — see migrate.mjs).
  // MemoryStore already holds everything resident, so exportTable is just a generator over
  // the relevant Map/values — no separate "streaming" trick needed here, unlike sqlite/postgres.
  async *exportTable(name) {
    switch (name) {
      case 'messages': for (const m of this.msgs.values()) yield { ...m, has_files: !!m.has_files, edited: !!m.edited, deleted: !!m.deleted, reactions: m.reactions ?? {} }; return;
      case 'users': for (const u of this.us.values()) yield { ...u, is_bot: !!u.is_bot }; return;
      case 'channels': for (const c of this.chs.values()) yield { ...c, is_private: !!c.is_private, is_im: !!c.is_im, is_mpim: !!c.is_mpim }; return;
      case 'tokens': for (const t of this.tok.values()) yield { ...t }; return;
      case 'apps': for (const a of this.apps.values()) yield { ...a }; return;
      case 'threads': for (const [k, hydrated_at] of this.thr) { const [org, channel, thread_ts] = k.split('|'); yield { org, channel, thread_ts, hydrated_at }; } return;
      case 'outbound': for (const [k, at] of this.outb) { const [org, channel, ts] = k.split('|'); yield { org, channel, ts, at }; } return;
      default: throw new Error(`migrate: unknown table '${name}'`);
    }
  }
  // Raw full-column upsert per row, keyed on each table's natural PK (same keys migrate.mjs
  // documents) — deliberately NOT routed through putMessage/markThreadHydrated/putOutbound,
  // which apply live-ingest semantics (merge-only fields, stamp "now") that would corrupt a
  // faithful copy (e.g. putMessage never sets deleted/deleted_at/reactions; markThreadHydrated
  // always stamps Date.now() instead of preserving the source's hydrated_at).
  async importRows(name, rows) {
    let n = 0;
    for await (const row of rows) {
      switch (name) {
        case 'messages': this.msgs.set(this._k(row.org, row.channel, row.ts), {
          org: row.org, channel: row.channel, ts: row.ts, thread_ts: row.thread_ts ?? null,
          user: row.user ?? null, subtype: row.subtype ?? null, text: row.text ?? '',
          has_files: row.has_files ? 1 : 0, files_json: row.files_json ?? null, edited: row.edited ? 1 : 0,
          origin: row.origin ?? null, deleted: row.deleted ? 1 : 0, deleted_at: row.deleted_at ?? null,
          reactions: row.reactions ?? {}, at: row.at ?? Date.now() }); break;
        case 'users': this.us.set(this._k(row.org, row.id, ''), { org: row.org, id: row.id, name: row.name ?? null, real_name: row.real_name ?? null, display_name: row.display_name ?? null, tz: row.tz ?? null, is_bot: row.is_bot ? 1 : 0, updated: row.updated ?? Date.now() }); break;
        case 'channels': this.chs.set(this._k(row.org, row.id, ''), { org: row.org, id: row.id, name: row.name ?? null, is_private: row.is_private ? 1 : 0, is_im: row.is_im ? 1 : 0, is_mpim: row.is_mpim ? 1 : 0, updated: row.updated ?? Date.now() }); break;
        case 'tokens': this.tok.set(row.org, { org: row.org, team_name: row.team_name ?? null, token: row.token, cookie: row.cookie, user_id: row.user_id ?? null, updated: row.updated ?? Date.now() }); break;
        case 'apps': this.apps.set(row.org, { org: row.org, app_id: row.app_id ?? null, team_id: row.team_id ?? null, team_name: row.team_name ?? null, bot_token: row.bot_token ?? null, app_token: row.app_token ?? null, bot_user_id: row.bot_user_id ?? null, bot_id: row.bot_id ?? null }); break;
        case 'threads': this.thr.set(this._k(row.org, row.channel, row.thread_ts), row.hydrated_at ?? Date.now()); break;
        case 'outbound': this.outb.set(this._k(row.org, row.channel, row.ts), row.at ?? Date.now()); break;
        default: throw new Error(`migrate: unknown table '${name}'`);
      }
      n++;
    }
    return n;
  }
}
