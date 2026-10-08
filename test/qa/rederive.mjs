// Re-derive split-variant labels offline from the stored manner distribution:
// on-script mass = P(reading) + P(paraphrase); if it beats every other option
// the speech is script content and code derives the relation from `where`.
//   node test/qa/rederive.mjs results/v3-split-prefix.json results/v3m-split-prefix.json
import { readJson, writeJson, loadDoc } from './lib.mjs';
import { loadCases } from './metrics.mjs';

const MAP = { own_words: 'adlib_related', slip: 'false_start', off_topic: 'unrelated', unclear: 'unclear' };
export function deriveMass(doc, cur, manner, where) {
  const P = manner.probabilities;
  const on = (P.reading || 0) + (P.paraphrase || 0);
  const others = Object.entries(P).filter(([k]) => k !== 'reading' && k !== 'paraphrase').sort((a, b) => b[1] - a[1]);
  if (!(on > (others[0]?.[1] ?? 0))) return { label: MAP[others[0][0]], p: others[0][1] };
  const wi = where && /^P\d+$/.test(where) ? parseInt(where.slice(1), 10) : -1;
  const kind = (P.reading || 0) >= (P.paraphrase || 0) ? 'reading_current' : 'paraphrase';
  if (wi < 0) return { label: kind, p: on };
  const cs = doc.phrases[cur].sent;
  const ws = doc.phrases[wi].sent;
  if (ws < cs) return { label: 'went_back', p: on };
  if (ws > cs + 1) return { label: 'jumped_ahead', p: on };
  return { label: kind, p: on };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dst] = process.argv.slice(2);
  const r = readJson(src);
  const cases = Object.fromEntries(loadCases(r.casesFile || 'jev-cases.json').map((c) => [c.id, c]));
  for (const x of r.results) {
    if (!x.manner) continue;
    const c = cases[x.id];
    const d = deriveMass(loadDoc(c.script), c.cur, x.manner, x.where?.choice);
    x.relation = { choice: d.label, confidence: x.manner.confidence, probabilities: { ...x.manner.probabilities, [d.label]: d.p } };
  }
  r.variant = `${r.variant}+mass`;
  r.tag = dst.replace(/^.*\//, '').replace(/\.json$/, '');
  writeJson(dst, r);
  console.log('wrote', dst);
}
