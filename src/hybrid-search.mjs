import fs from 'node:fs';
import path from 'node:path';

// --- Compact Porter English Stemmer -----------------------------------------
export function stem(word) {
  if (typeof word !== 'string' || word.length <= 2) return word;
  let w = word.toLowerCase();

  const isConsonant = (str, i) => {
    const c = str[i];
    if ('aeiou'.includes(c)) return false;
    if (c === 'y') return i === 0 ? true : !isConsonant(str, i - 1);
    return true;
  };

  const measure = (str) => {
    let count = 0;
    let i = 0;
    const len = str.length;
    while (i < len && isConsonant(str, i)) i++;
    while (i < len) {
      while (i < len && !isConsonant(str, i)) i++;
      if (i < len) {
        count++;
        while (i < len && isConsonant(str, i)) i++;
      }
    }
    return count;
  };

  const hasVowel = (str) => {
    for (let i = 0; i < str.length; i++) {
      if (!isConsonant(str, i)) return true;
    }
    return false;
  };

  const endsWithDoubleConsonant = (str) => {
    if (str.length < 2) return false;
    const c1 = str[str.length - 1];
    const c2 = str[str.length - 2];
    return c1 === c2 && isConsonant(str, str.length - 1);
  };

  const endsCvc = (str) => {
    const l = str.length;
    if (l < 3) return false;
    return isConsonant(str, l - 1) &&
      !isConsonant(str, l - 2) &&
      isConsonant(str, l - 3) &&
      !'wxy'.includes(str[l - 1]);
  };

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let extra1b = false;
  if (w.endsWith('eed')) {
    const stemPart = w.slice(0, -3);
    if (measure(stemPart) > 0) w = stemPart + 'ee';
  } else if (w.endsWith('ed')) {
    const stemPart = w.slice(0, -2);
    if (hasVowel(stemPart)) {
      w = stemPart;
      extra1b = true;
    }
  } else if (w.endsWith('ing')) {
    const stemPart = w.slice(0, -3);
    if (hasVowel(stemPart)) {
      w = stemPart;
      extra1b = true;
    }
  }

  if (extra1b) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (endsWithDoubleConsonant(w) && !w.endsWith('l') && !w.endsWith('s') && !w.endsWith('z')) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsCvc(w)) {
      w += 'e';
    }
  }

  // Step 1c
  if (w.endsWith('y')) {
    const stemPart = w.slice(0, -1);
    if (hasVowel(stemPart)) w = stemPart + 'i';
  }

  // Step 2
  const step2Pairs = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble']
  ];
  for (const [suf, rep] of step2Pairs) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, -suf.length);
      if (measure(stemPart) > 0) w = stemPart + rep;
      break;
    }
  }

  // Step 3
  const step3Pairs = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
    ['ical', 'ic'], ['ful', ''], ['ness', '']
  ];
  for (const [suf, rep] of step3Pairs) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, -suf.length);
      if (measure(stemPart) > 0) w = stemPart + rep;
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement',
    'ment', 'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'
  ];
  for (const suf of step4Suffixes) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, -suf.length);
      if (measure(stemPart) > 1) w = stemPart;
      break;
    }
  }
  if (w.endsWith('ion')) {
    const stemPart = w.slice(0, -3);
    if (measure(stemPart) > 1 && (stemPart.endsWith('s') || stemPart.endsWith('t'))) {
      w = stemPart;
    }
  }

  // Step 5a
  if (w.endsWith('e')) {
    const stemPart = w.slice(0, -1);
    const m = measure(stemPart);
    if (m > 1 || (m === 1 && !endsCvc(stemPart))) {
      w = stemPart;
    }
  }

  // Step 5b
  if (w.endsWith('ll') && measure(w.slice(0, -1)) > 1) {
    w = w.slice(0, -1);
  }

  return w;
}

// --- Technical Tokenizer & Stopwords ----------------------------------------
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'cannot', 'could', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'isn', 'it', 'its',
  'itself', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'very', 'was', 'wasn', 'we', 'were', 'weren', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours'
]);

export function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  // Split on camelCase (e.g. 'openViking' -> 'open Viking')
  const camelSplit = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  // Split on non-alphanumeric characters
  const rawWords = camelSplit.toLowerCase().split(/[^a-z0-9]+/);
  const tokens = [];
  for (const w of rawWords) {
    if (w.length >= 2 && !STOP_WORDS.has(w)) {
      tokens.push(w);
    }
  }
  return tokens;
}

// --- Developer Technical Synonym Map ----------------------------------------
const RAW_SYNONYMS = {
  desync: ['stale', 'unhealthy', 'corrupt', 'disconnect', 'desynchronized', 'desynchronization', 'hang'],
  stale: ['desync', 'outdated', 'unhealthy', 'corrupt'],
  docker: ['container', 'wsl', 'mount', 'daemon', 'openviking', 'vhdx'],
  container: ['docker', 'podman', 'wsl', 'image', 'instance'],
  wsl: ['docker', 'windows', 'mount', 'drvfs', 'vhdx', 'eaccessdenied'],
  mount: ['bind', 'volume', 'wsl', 'disk', 'directory', 'storage'],
  bind: ['mount', 'volume', 'bindmount'],
  auth: ['jwt', 'token', 'session', 'guard', 'oauth', 'bearer', 'header'],
  jwt: ['auth', 'token', 'bearer', 'header'],
  token: ['jwt', 'auth', 'bearer'],
  guard: ['middleware', 'auth', 'protect', 'policy', 'interceptor'],
  perm: ['permission', 'accessdenied', 'eaccessdenied', 'chmod', 'acl'],
  permission: ['perm', 'accessdenied', 'eaccessdenied', 'chmod'],
  k8s: ['kubernetes', 'cluster', 'pod', 'deployment'],
  db: ['database', 'postgres', 'postgresql', 'sqlite', 'mysql', 'migration'],
  database: ['db', 'postgres', 'postgresql', 'sqlite', 'sql'],
  sync: ['reconcile', 'mirror', 'parity', 'reconciliation']
};

// Pre-stem synonym dictionary
const STEMMED_SYNONYMS = new Map();
for (const [key, list] of Object.entries(RAW_SYNONYMS)) {
  const stemmedKey = stem(key);
  const stemmedList = new Set();
  stemmedList.add(key);
  stemmedList.add(stemmedKey);
  for (const item of list) {
    stemmedList.add(item);
    stemmedList.add(stem(item));
  }
  const fullArr = Array.from(stemmedList);
  STEMMED_SYNONYMS.set(key, fullArr);
  STEMMED_SYNONYMS.set(stemmedKey, fullArr);
}

export function expandQuery(queryTokens) {
  const queryTerms = new Map(); // term -> weight

  for (const rawTok of queryTokens) {
    const sTok = stem(rawTok);
    // Base exact/stem token gets weight 1.0
    queryTerms.set(sTok, Math.max(queryTerms.get(sTok) || 0, 1.0));
    if (rawTok !== sTok) {
      queryTerms.set(rawTok, Math.max(queryTerms.get(rawTok) || 0, 1.0));
    }

    // Synonym expansion gets weight 0.75
    const syns = STEMMED_SYNONYMS.get(rawTok) || STEMMED_SYNONYMS.get(sTok);
    if (syns) {
      for (const syn of syns) {
        if (!queryTerms.has(syn)) {
          queryTerms.set(syn, 0.75);
        }
      }
    }
  }

  return queryTerms;
}

// --- In-Memory Document Cache with mtime Invalidation ------------------------
let cachedVaultRoot = null;
let cachedMtimeSignature = null;
let cachedIndex = null;

export function extractSections(content) {
  if (!content || typeof content !== 'string') {
    return { summary: '', fix: '', codeText: '' };
  }

  // Extract blockquote (handles multiline blockquotes starting with >)
  const lines = content.split(/\r?\n/);
  const quoteLines = [];
  let inQuote = false;
  for (const line of lines) {
    if (line.trim().startsWith('>')) {
      inQuote = true;
      quoteLines.push(line.replace(/^\s*>\s*/, '').trim());
    } else if (inQuote) {
      break;
    }
  }
  const summary = quoteLines.join(' ');

  // Extract fix / snippet section
  let fix = '';
  const sectionHeaderRegex = /^##\s+[^\r\n]*(?:Root Cause|Procedural Fix|Fix|Solution|Implementation|Snippet|Remediation|Usage)[^\r\n]*/im;
  const match = content.match(sectionHeaderRegex);
  if (match) {
    const startIdx = content.indexOf(match[0]) + match[0].length;
    const rest = content.slice(startIdx);
    const endMatch = rest.match(/\n##\s+|\n---\s*$/);
    const sectionBody = endMatch ? rest.slice(0, endMatch.index) : rest;
    const bodyLines = sectionBody.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    fix = bodyLines.slice(0, 8).join('\n');
  } else if (summary) {
    fix = summary;
  }

  // Code blocks
  const codeBlocks = [];
  const codeRegex = /```[\s\S]*?```/g;
  let codeMatch;
  while ((codeMatch = codeRegex.exec(content)) !== null) {
    codeBlocks.push(codeMatch[0]);
  }

  return { summary, fix, codeText: codeBlocks.join(' ') };
}

export function buildVaultIndex(vaultRoot) {
  const targetDirs = ['03-Dev', '08-Concepts'];
  const docs = [];
  let sig = '';

  for (const relDir of targetDirs) {
    const absDir = path.join(vaultRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    try {
      const dirStat = fs.statSync(absDir);
      sig += `${relDir}:${dirStat.mtimeMs};`;
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
        const absFile = path.join(absDir, entry.name);
        const fStat = fs.statSync(absFile);
        sig += `${entry.name}:${fStat.mtimeMs};`;
        const content = fs.readFileSync(absFile, 'utf8');
        const title = entry.name.replace(/\.md$/, '');
        const relPath = `${relDir}/${entry.name}`;
        const { summary, fix, codeText } = extractSections(content);

        // Term frequency calculation with field boosts
        const termFreqs = new Map();
        const addTokens = (text, boost) => {
          const toks = tokenize(text);
          for (const t of toks) {
            const st = stem(t);
            termFreqs.set(st, (termFreqs.get(st) || 0) + boost);
            if (t !== st) {
              termFreqs.set(t, (termFreqs.get(t) || 0) + (boost * 0.8));
            }
          }
        };

        // Title has 3.0x boost
        addTokens(title, 3.0);
        // Fix / summary has 2.0x boost
        if (fix) addTokens(fix, 2.0);
        // Code has 1.5x boost
        if (codeText) addTokens(codeText, 1.5);
        // General body has 1.0x boost
        addTokens(content, 1.0);

        let dl = 0;
        for (const count of termFreqs.values()) dl += count;

        docs.push({
          title,
          relPath,
          summary,
          fix,
          termFreqs,
          dl
        });
      }
    } catch {
      // Directory access issue; skip safely
    }
  }

  const N = docs.length;
  let totalDl = 0;
  const docFreq = new Map(); // term -> document count

  for (const doc of docs) {
    totalDl += doc.dl;
    for (const term of doc.termFreqs.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const avgdl = N > 0 ? totalDl / N : 1;

  // Precalculate IDF
  const idfMap = new Map();
  for (const [term, df] of docFreq.entries()) {
    // Standard BM25 IDF: ln(1 + (N - df + 0.5) / (df + 0.5))
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    idfMap.set(term, Math.max(idf, 0.1));
  }

  return {
    vaultRoot,
    sig,
    docs,
    avgdl,
    N,
    idfMap
  };
}

export function getOrUpdateIndex(vaultRoot) {
  if (cachedVaultRoot === vaultRoot && cachedIndex) {
    // Fast mtime signature check
    let currentSig = '';
    for (const relDir of ['03-Dev', '08-Concepts']) {
      const absDir = path.join(vaultRoot, relDir);
      if (fs.existsSync(absDir)) {
        try {
          const dirStat = fs.statSync(absDir);
          currentSig += `${relDir}:${dirStat.mtimeMs};`;
        } catch {}
      }
    }
    if (currentSig === cachedMtimeSignature) {
      return cachedIndex;
    }
  }

  const newIndex = buildVaultIndex(vaultRoot);
  cachedVaultRoot = vaultRoot;
  // Construct signature of top dirs
  let sig = '';
  for (const relDir of ['03-Dev', '08-Concepts']) {
    const absDir = path.join(vaultRoot, relDir);
    if (fs.existsSync(absDir)) {
      try {
        sig += `${relDir}:${fs.statSync(absDir).mtimeMs};`;
      } catch {}
    }
  }
  cachedMtimeSignature = sig;
  cachedIndex = newIndex;
  return newIndex;
}

// --- BM25 Hybrid Search Execution ------------------------------------------
export function searchVaultRunbooks(vaultRoot, queryString, options = {}) {
  const query = (queryString || '').trim();
  if (!query) return [];

  const rawTokens = tokenize(query);
  if (rawTokens.length === 0) return [];

  const index = getOrUpdateIndex(vaultRoot);
  if (index.docs.length === 0) return [];

  const queryTerms = expandQuery(rawTokens);
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const minScore = options.minScore ?? 1.2;
  const limit = options.limit ?? 2;

  const results = [];

  for (const doc of index.docs) {
    let score = 0;
    let matchedTerms = 0;

    for (const [term, termWeight] of queryTerms.entries()) {
      const tf = doc.termFreqs.get(term) || 0;
      if (tf > 0) {
        matchedTerms++;
        const idf = index.idfMap.get(term) || 0.1;
        // BM25 term score
        const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.dl / index.avgdl))));
        score += termScore * termWeight;
      }
    }

    if (score >= minScore) {
      results.push({
        title: doc.title,
        relPath: doc.relPath,
        score: Math.round(score * 100) / 100,
        summary: doc.summary,
        fix: doc.fix
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
