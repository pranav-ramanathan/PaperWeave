// Presence (Yjs awareness) arrives from every connection, viewers too, and is held and sent on to
// everyone who has the file open. Nothing in it is trusted: it is read for its size without being
// parsed, and what is kept is rebuilt from the few fields the editors really send.

/** The most one person's presence state may come to, as JSON. Larger is dropped, not cut. */
export const MAX_PRESENCE_BYTES = 4096;
/** The largest awareness message that is read at all, before anything is parsed. */
export const MAX_AWARENESS_BYTES = 8 * 1024;
/** The longest name that is kept. The editors cut names to this when they show them. */
export const MAX_PRESENCE_NAME = 80;
/** Removals kept from one message: people whose presence timed out, as the editors report. */
export const MAX_PRESENCE_REMOVALS = 64;

const MESSAGE_AWARENESS = 1;

/** One variable-length unsigned integer, as lib0 writes it. */
function readVarUint(raw: Uint8Array, at: number): [value: number, next: number] | null {
  let value = 0;
  let scale = 1;
  for (let i = at; i < raw.length && i < at + 8; i++) {
    value += (raw[i] & 0x7f) * scale;
    if (raw[i] < 0x80) return [value, i + 1];
    scale *= 128;
  }
  return null;
}

/**
 * How long the body of an awareness message is, read from its framing alone: the file's name
 * (a length and its bytes), the message type (1 for awareness), and the body (a length and its
 * bytes). Null for any other message, and for one whose framing does not hold together: the
 * library refuses such a message itself.
 */
export function presenceSize(raw: Uint8Array): number | null {
  const name = readVarUint(raw, 0);
  if (!name) return null;
  const type = readVarUint(raw, name[0] + name[1]);
  if (!type || type[0] !== MESSAGE_AWARENESS) return null;
  const body = readVarUint(raw, type[1]);
  if (!body || body[1] + body[0] > raw.length) return null;
  return body[0];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const SIMPLE_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A Yjs ID, as it appears in JSON: who made it and when. */
const cleanId = (v: unknown) =>
  isObject(v) && isCount(v.client) && isCount(v.clock)
    ? { client: v.client, clock: v.clock }
    : null;

/**
 * A Yjs relative position. yCollab sends the object itself, with every field and nulls for what
 * is not set; the visual view sends `relativePositionToJSON` of it, which leaves those out. Both
 * come back with the fields they had.
 */
function cleanPosition(v: unknown) {
  if (!isObject(v)) return null;
  const out: Record<string, unknown> = {};
  for (const key of ['type', 'item'] as const) {
    if (v[key] === undefined) continue;
    if (v[key] === null) out[key] = null;
    else {
      const id = cleanId(v[key]);
      if (!id) return null;
      out[key] = id;
    }
  }
  if (v.tname !== undefined) {
    if (v.tname !== null && (typeof v.tname !== 'string' || v.tname.length > 100)) return null;
    out.tname = v.tname;
  }
  if (v.assoc !== undefined) {
    if (typeof v.assoc !== 'number' || !Number.isFinite(v.assoc)) return null;
    out.assoc = v.assoc;
  }
  // A position that points at nothing is of no use.
  return out.type || out.tname || out.item ? out : null;
}

/** One state, rebuilt from known fields only; null if it is too large to be one. */
function cleanState(state: unknown, name?: string): Record<string, unknown> | null {
  if (!isObject(state)) return null;
  let json: string;
  try {
    json = JSON.stringify(state);
  } catch {
    return null;
  }
  if (Buffer.byteLength(json) > MAX_PRESENCE_BYTES) return null;
  const out: Record<string, unknown> = {};
  const sent = isObject(state.user) ? state.user : {};
  const user: Record<string, string> = {};
  // A name the server knows for this connection replaces whatever the client says.
  if (name !== undefined) user.name = name.slice(0, MAX_PRESENCE_NAME);
  else if (typeof sent.name === 'string') user.name = sent.name.slice(0, MAX_PRESENCE_NAME);
  for (const key of ['color', 'colorLight'] as const) {
    const colour = sent[key];
    if (typeof colour === 'string' && SIMPLE_COLOUR.test(colour)) user[key] = colour;
  }
  if (Object.keys(user).length) out.user = user;
  if (state.cursor === null) out.cursor = null;
  else if (isObject(state.cursor)) {
    const anchor = cleanPosition(state.cursor.anchor);
    const head = cleanPosition(state.cursor.head);
    if (anchor && head) out.cursor = { anchor, head };
  }
  return out;
}

/** What a connection is, for presence: the name it goes under and the client IDs it holds. */
export type PresenceOwner = {
  name: string;
  /** True if the client ID is now this connection's (it was, or was free and is taken). */
  claim: (id: number) => boolean;
  /** True if the client ID is this connection's. */
  owns: (id: number) => boolean;
};

/**
 * Bring what one awareness message says down to what an editor sends: its own state, and the
 * removals of people whose presence timed out. At most one state is kept (the first that is
 * usable), rebuilt from `user` (a name, cut to 80 characters, and simple colours) and `cursor`
 * (two relative positions); everything else goes. At most 64 removals are kept. Changes `states`
 * and `removed` in place, as the sync server's hook is made to. Returns how many states it did
 * not keep.
 *
 * With `who`, presence is tied to the connection that sent it: `user.name` is `who.name`, whatever
 * the client said; a state is kept only under a client ID that `who.claim` gives this connection
 * (its own already, or one nobody else holds); and a removal is kept only for its own IDs.
 */
export function cleanPresence(
  states: Map<number, unknown>,
  removed: Set<number>,
  who?: PresenceOwner,
): number {
  const before = states.size;
  let kept: [number, Record<string, unknown>] | null = null;
  for (const [id, state] of states) {
    const clean = cleanState(state, who?.name);
    if (clean && (!who || who.claim(id))) {
      kept = [id, clean];
      break;
    }
  }
  states.clear();
  if (kept) states.set(kept[0], kept[1]);
  if (who) for (const id of removed) if (!who.owns(id)) removed.delete(id);
  let n = 0;
  for (const id of removed) if (++n > MAX_PRESENCE_REMOVALS) removed.delete(id);
  return before - states.size;
}
