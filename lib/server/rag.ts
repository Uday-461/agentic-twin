import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Retrieval over the equipment manuals in knowledge/. The corpus is a few pages, so BM25
// keyword scoring is enough and keeps the agent grounded without an embeddings service.

export type Chunk = { source: string; heading: string; text: string };
export type Hit = Chunk & { score: number };

const K1 = 1.4, B = 0.75;

type Index = { chunks: Chunk[]; tokens: string[][]; df: Map<string, number>; avgLen: number };
let index: Index | null = null;

export function loadChunks(dir = path.join(process.cwd(), "knowledge")): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    let heading = "";
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join("\n").trim();
      if (text) chunks.push({ source: file, heading, text });
      buf = [];
    };
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (line.startsWith("## ")) { flush(); heading = line.slice(3).trim(); }
      else if (!line.startsWith("# ")) buf.push(line);
    }
    flush();
  }
  return chunks;
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

function build(): Index {
  const chunks = loadChunks();
  const tokens = chunks.map((c) => tokenize(`${c.heading} ${c.heading} ${c.text}`));
  const df = new Map<string, number>();
  for (const t of tokens) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const avgLen = tokens.reduce((a, t) => a + t.length, 0) / Math.max(1, tokens.length);
  return { chunks, tokens, df, avgLen };
}

export function searchManual(query: string, k = 3): Hit[] {
  index ??= build();
  const { chunks, tokens, df, avgLen } = index;
  const n = chunks.length;
  const q = [...new Set(tokenize(query))];
  return chunks
    .map((c, i) => {
      const doc = tokens[i];
      let score = 0;
      for (const term of q) {
        const tf = doc.filter((t) => t === term).length;
        if (!tf) continue;
        const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLen));
      }
      return { ...c, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
