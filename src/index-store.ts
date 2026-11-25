/**
 * On-disk index of a bucket (pure: text ↔ records; the host does the I/O):
 * <storage>/index/<bucket>.json (records) and <bucket>.sig.json (event
 * signatures, loaded only when fork-lineage inference needs them).
 * The index is a cache validated against the session files by size + mtime:
 * a missing, corrupt, foreign or older-version file is ignored and its
 * sessions are rebuilt from the logs — the logs are the only truth.
 */
import type { HandoffHit } from './parse.js'
import type { Rec, RecOk, SigColumns } from './record.js'

/** Bump whenever record semantics change: files of other versions are ignored. */
export const INDEX_VERSION = 1

type Obj = Record<string, unknown>
type Check = (v: unknown) => boolean

const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const count = (v: unknown): v is number => num(v) && Number.isInteger(v) && v >= 0
const str = (v: unknown): boolean => typeof v === 'string'
const text = (v: unknown): boolean => typeof v === 'string' && v !== ''
const bool = (v: unknown): boolean => typeof v === 'boolean'
const nullable = (ok: Check): Check => (v) => v === null || ok(v)
const list = (ok: Check): Check => (v) => Array.isArray(v) && v.every(ok)
const hit = (v: unknown): boolean => obj(v) && num(v.seq) && num(v.at) && count(v.turn) && v.turn >= 1
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str)
const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every(num)
const counts = (v: unknown): v is number[] => Array.isArray(v) && v.every(count)

type RecFields = Omit<RecOk, 'size' | 'mtimeMs' | 'fail'>

const textFields = (r: Obj): boolean => (r.fail === undefined || r.fail === false) && str(r.head) && bool(r.nl) && nullable(text)(r.title) && nullable(text)(r.parent) && nullable(text)(r.cwd)
const flagFields = (r: Obj): boolean => bool(r.seeded) && bool(r.handoffFirst) && bool(r.handoffUsed) && nullable(num)(r.forkMarkerSeq)
const timeFields = (r: Obj): boolean => num(r.createdAt) && num(r.firstUserAt) && num(r.lastAt) && count(r.users) && nums(r.tail) && list(hit)(r.handoffHits)
const fieldsOk = (r: Obj): r is Obj & RecFields => textFields(r) && flagFields(r) && timeFields(r)

/** Stored record → record; null = malformed (its session is rebuilt from the log). */
export function readRec(r: Obj): Rec | null {
  if (!num(r.size) || r.size < 0 || !num(r.mtimeMs)) return null
  if (r.fail === true) return Object.keys(r).length === 3 ? { size: r.size, mtimeMs: r.mtimeMs, fail: true } : null
  if (!fieldsOk(r)) return null
  return {
    size: r.size,
    mtimeMs: r.mtimeMs,
    head: r.head,
    nl: r.nl,
    title: r.title,
    createdAt: r.createdAt,
    firstUserAt: r.firstUserAt,
    lastAt: r.lastAt,
    parent: r.parent,
    seeded: r.seeded,
    cwd: r.cwd,
    handoffFirst: r.handoffFirst,
    handoffUsed: r.handoffUsed,
    handoffHits: r.handoffHits,
    forkMarkerSeq: r.forkMarkerSeq,
    users: r.users,
    tail: r.tail,
  }
}

/** Column arrays agree with each other and with the type dictionary. */
function columnsOk(s: Obj): s is Obj & SigColumns {
  if (!strs(s.d) || !counts(s.k) || !counts(s.s) || !nums(s.t)) return false
  const { d, k, s: seqs, t } = s
  return k.length === seqs.length && t.length === k.length && k.every((at) => at < d.length)
}

/** Stored signature columns → columns; null = malformed. `raw` is either
 *  absent (times are deltas) or true (times as stored); nothing else. */
export function readSig(s: Obj): SigColumns | null {
  if (!columnsOk(s) || (s.raw !== undefined && s.raw !== true)) return null
  const { d, k, s: seqs, t } = s
  return s.raw === true ? { d, k, s: seqs, t, raw: true } : { d, k, s: seqs, t }
}

/** Parse <bucket>.json (null = absent, unreadable or unusable → rebuild). */
export function parseIndex(text: string, bucket: string): Map<string, Rec> | null {
  const raw = parseEnvelope(text, bucket, 'recs')
  if (raw === null) return null
  const recs = new Map<string, Rec>()
  for (const [sid, value] of Object.entries(raw)) {
    const rec = obj(value) ? readRec(value) : null
    if (rec !== null) recs.set(sid, rec)
  }
  return recs
}

/** Parse <bucket>.sig.json (same contract as parseIndex). */
export function parseSigs(text: string, bucket: string): Map<string, SigColumns> | null {
  const raw = parseEnvelope(text, bucket, 'sigs')
  if (raw === null) return null
  const sigs = new Map<string, SigColumns>()
  for (const [sid, value] of Object.entries(raw)) {
    const sig = obj(value) ? readSig(value) : null
    if (sig !== null) sigs.set(sid, sig)
  }
  return sigs
}

/** The `table` of a well-formed index file envelope ({ v, bucket, <table> }). */
function parseEnvelope(text: string, bucket: string, table: 'recs' | 'sigs'): Obj | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj(raw) || raw.v !== INDEX_VERSION || raw.bucket !== bucket || !obj(raw[table])) return null
  return raw[table]
}

export function serializeIndex(bucket: string, recs: ReadonlyMap<string, Rec>): string {
  return JSON.stringify({ v: INDEX_VERSION, bucket, recs: Object.fromEntries(recs) })
}

export function serializeSigs(bucket: string, sigs: ReadonlyMap<string, SigColumns>): string {
  return JSON.stringify({ v: INDEX_VERSION, bucket, sigs: Object.fromEntries(sigs) })
}

export type FileClass = 'same' | 'grow' | 'work'

/** What a session file's current size + mtime ask for, given its record:
 *  same → both match: the record is current.
 *  grow → the file grew past a record that ends on a frame boundary: merge the appended bytes.
 *  work → everything else (no record, shrunk, rewritten, failed record): rebuild. */
export function classify(rec: Rec | undefined, size: number, mtimeMs: number): FileClass {
  if (rec === undefined) return 'work'
  if (rec.size === size && rec.mtimeMs === mtimeMs) return 'same'
  if (size > rec.size && rec.fail !== true && rec.nl) return 'grow'
  return 'work'
}
