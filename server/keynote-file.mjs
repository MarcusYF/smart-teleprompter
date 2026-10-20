// Reads a saved Keynote document's builds without Keynote: how many clicks
// each slide needs and what each click reveals. Keynote's AppleScript exposes
// no build information, so speech-driven animation needs this to place clicks
// in scripts that have no [click] markers.
//
// Format (checked with files saved by Keynote 14.5 and 15.1): a zip (or a
// package folder) of Index/*.iwa files; each is a stream of snappy-compressed
// chunks holding protobuf archives (TSP.ArchiveInfo + messages). Message
// types and fields used here:
//   KN.ShowArchive (2): field 3 (slide tree) . field 2 = slide nodes in order
//   KN.SlideNodeArchive (4): field 2 = slide
//   KN.SlideArchive (5): field 43 = build chunks in click order
//   KN.BuildArchive (8): field 1 = drawable, field 2 = delivery ("By Paragraph")
//   KN.BuildChunkArchive (153): field 1 = build, field 5 = automatic
//   TSWP.StorageArchive (2001): field 3 = text ("\n" between paragraphs)
// Zero dependencies: zip via node:zlib, snappy and protobuf decoded here.
// Anything unexpected yields null; callers then behave as before.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip archive');
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files.set(name, { method, data: buf.subarray(start, start + csize) });
    off += 46 + nlen + xlen + clen;
  }
  return {
    names: [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      return f.method === 0 ? f.data : inflateRawSync(f.data);
    },
  };
}

// A .key file is a zip; older ones are package folders (with Index.zip or Index/).
function openDocument(path) {
  if (statSync(path).isDirectory()) {
    const iz = join(path, 'Index.zip');
    if (existsSync(iz)) return unzip(readFileSync(iz));
    const dir = join(path, 'Index');
    const names = readdirSync(dir).map((f) => `Index/${f}`);
    return { names, read: (name) => (existsSync(join(path, name)) ? readFileSync(join(path, name)) : null) };
  }
  return unzip(readFileSync(path));
}

function snappy(src) {
  let p = 0;
  let len = 0;
  let shift = 0;
  let b;
  do { b = src[p++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  const out = Buffer.alloc(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const t = tag & 3;
    if (t === 0) {
      let l = tag >> 2;
      if (l >= 60) {
        const nb = l - 59;
        l = 0;
        for (let i = 0; i < nb; i++) l |= src[p++] << (8 * i);
      }
      l += 1;
      src.copy(out, o, p, p + l);
      p += l;
      o += l;
    } else {
      let l;
      let off;
      if (t === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; }
      else if (t === 2) { l = (tag >> 2) + 1; off = src[p] | (src[p + 1] << 8); p += 2; }
      else { l = (tag >> 2) + 1; off = src.readUInt32LE(p); p += 4; }
      if (off <= 0 || off > o) throw new Error('bad snappy offset');
      for (let i = 0; i < l; i++) { out[o] = out[o - off]; o++; }
    }
  }
  return out;
}

function iwa(buf) {
  const parts = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const len = buf[p + 1] | (buf[p + 2] << 8) | (buf[p + 3] << 16);
    parts.push(snappy(buf.subarray(p + 4, p + 4 + len)));
    p += 4 + len;
  }
  return Buffer.concat(parts);
}

function varint(buf, p) {
  let r = 0n;
  let s = 0n;
  let b;
  do { b = buf[p++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
  return [r, p];
}

function pb(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    let key;
    [key, p] = varint(buf, p);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let v;
    if (wire === 0) [v, p] = varint(buf, p);
    else if (wire === 1) { v = buf.subarray(p, p + 8); p += 8; }
    else if (wire === 2) { let l; [l, p] = varint(buf, p); v = buf.subarray(p, p + Number(l)); p += Number(l); }
    else if (wire === 5) { v = buf.subarray(p, p + 4); p += 4; }
    else throw new Error(`protobuf wire type ${wire}`);
    if (p > buf.length) throw new Error('truncated protobuf');
    out.push({ field, wire, value: v });
  }
  return out;
}

// {id -> {type, payload}} for one .iwa file
function archives(stream) {
  const out = new Map();
  let p = 0;
  while (p < stream.length) {
    let l;
    [l, p] = varint(stream, p);
    const info = pb(stream.subarray(p, p + Number(l)));
    p += Number(l);
    const id = info.find((f) => f.field === 1)?.value;
    let first = null;
    for (const f of info.filter((x) => x.field === 2)) {
      const mi = pb(f.value);
      const type = Number(mi.find((x) => x.field === 1).value);
      const len = Number(mi.find((x) => x.field === 3).value);
      if (!first) first = { type, payload: stream.subarray(p, p + len) };
      p += len;
    }
    if (id != null && first) out.set(id, first);
  }
  return out;
}

const refOf = (buf) => {
  try {
    const f = pb(buf);
    return f.length === 1 && f[0].field === 1 && f[0].wire === 0 ? f[0].value : null;
  } catch {
    return null;
  }
};
const refs = (payload, field) => pb(payload).filter((x) => x.field === field && x.wire === 2).map((x) => refOf(x.value)).filter((r) => r != null);

// The text a drawable shows: its own storage, or its children's (a group).
function drawableText(arcs, id, depth = 0) {
  const a = arcs.get(id);
  if (!a || depth > 3) return '';
  const texts = [];
  const seen = new Set();
  const walk = (buf, d) => {
    let f;
    try { f = pb(buf); } catch { return; }
    for (const x of f) {
      if (x.wire !== 2) continue;
      const r = refOf(x.value);
      if (r != null) {
        const t = arcs.get(r);
        if (!t || seen.has(r)) continue;
        seen.add(r);
        if (t.type === 2001) {
          const s = pb(t.payload).filter((y) => y.field === 3 && y.wire === 2).map((y) => y.value.toString('utf8')).join('');
          if (s.trim()) texts.push(s);
        } else if (a.type === 3008 && d === 0 && (t.type === 2011 || t.type === 7 || t.type === 3008)) {
          texts.push(drawableText(arcs, r, depth + 1)); // group children
        }
      } else if (x.value.length > 2 && d < 6) {
        walk(x.value, d + 1);
      }
    }
  };
  walk(a.payload, 0);
  return texts.filter(Boolean).join('\n');
}

const clean = (s) => String(s || '').replace(/\uFFFC/g, ' ').replace(/[ \t]+/g, ' ').trim();

// [{n, clicks, autoStart, steps: [text revealed by each click]}] in slide
// order (n = Keynote slide number), or null if the file cannot be read.
export function readKeynoteBuilds(path) {
  try {
    const doc = openDocument(path);
    const docArcs = archives(iwa(doc.read('Index/Document.iwa')));
    let show = null;
    for (const a of docArcs.values()) if (a.type === 2) show = a;
    if (!show) return null;
    const tree = pb(show.payload).find((x) => x.field === 3 && x.wire === 2);
    const nodeIds = tree ? refs(tree.value, 2) : [];
    // slide archive id -> file archives
    const slideFiles = new Map();
    for (const name of doc.names.filter((n) => /^Index\/Slide.*\.iwa$/.test(n))) {
      const arcs = archives(iwa(doc.read(name)));
      for (const [id, a] of arcs) if (a.type === 5) slideFiles.set(id, arcs);
    }
    const out = [];
    nodeIds.forEach((nid, i) => {
      const node = docArcs.get(nid);
      const sid = node ? refs(node.payload, 2)[0] : null;
      const arcs = sid != null ? slideFiles.get(sid) : null;
      const entry = { n: i + 1, clicks: 0, autoStart: false, steps: [] };
      out.push(entry);
      if (!arcs) return;
      const chunkIds = refs(arcs.get(sid).payload, 43);
      const seenPerBuild = new Map();
      const paragraphs = new Map(); // build id -> paragraph texts
      let current = null;
      for (const cid of chunkIds) {
        const c = arcs.get(cid);
        if (!c || c.type !== 153) continue;
        const f = pb(c.payload);
        const bid = refOf(f.find((x) => x.field === 1 && x.wire === 2)?.value || Buffer.alloc(0));
        const automatic = f.some((x) => x.field === 5 && x.wire === 0 && x.value === 1n);
        const build = bid != null ? arcs.get(bid) : null;
        let text = '';
        if (build && build.type === 8) {
          const bf = pb(build.payload);
          const did = refOf(bf.find((x) => x.field === 1 && x.wire === 2)?.value || Buffer.alloc(0));
          const delivery = bf.find((x) => x.field === 2 && x.wire === 2)?.value.toString('utf8') || '';
          const k = seenPerBuild.get(bid) || 0;
          seenPerBuild.set(bid, k + 1);
          if (!paragraphs.has(bid)) paragraphs.set(bid, did != null ? drawableText(arcs, did).split(/\n|\u2029/) : []);
          const paras = paragraphs.get(bid);
          text = /paragraph|bullet|line/i.test(delivery) ? paras[k] || '' : paras.join(' ');
        }
        if (automatic && current) current.push(clean(text));
        else if (automatic) entry.autoStart = true;
        else {
          current = [clean(text)];
          entry.steps.push(current);
        }
      }
      entry.steps = entry.steps.map((parts) => parts.filter(Boolean).join(' ').trim());
      entry.clicks = entry.steps.length;
    });
    return out;
  } catch {
    return null;
  }
}
