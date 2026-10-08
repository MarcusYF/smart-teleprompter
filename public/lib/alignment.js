// Human-reviewed slide mappings. One line: slide number = paragraph number
// (both one-based). Picture-only slides may be omitted.
export function manualAlignment(doc, text, total = null) {
  const mapping = [];
  for (const line of text.split('\n').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:=|:|→)\s*(\d+)$/.exec(line);
    if (!m) throw new Error(`Invalid mapping: ${line}`);
    const n = Number(m[1]), para = Number(m[2]) - 1, p = doc.paras[para];
    if (n < 1 || (total && n > total) || !p || p.tokEnd <= p.tokStart) throw new Error(`Invalid slide or spoken paragraph: ${line}`);
    mapping.push({ n, para, tokStart: p.tokStart, p: null, source: 'manual' });
  }
  if (!mapping.length) throw new Error('Enter at least one mapping');
  mapping.sort((a, b) => a.n - b.n);
  for (let i = 1; i < mapping.length; i++) {
    if (mapping[i].n === mapping[i - 1].n || mapping[i].tokStart <= mapping[i - 1].tokStart) throw new Error('Slides must map to distinct paragraphs in script order');
  }
  return mapping;
}
