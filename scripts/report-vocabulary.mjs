// Offline inventory using the very same selection code as the app.
// node scripts/report-vocabulary.mjs writes the reviewable CSV; no network.
import { readFile, writeFile } from 'node:fs/promises';
import { LANGUAGES, definitions, buildTemplate, decodeLanguageData, isPrebuiltPair } from '../prebuilt.js';
const read = async file => decodeLanguageData(JSON.parse(await readFile(new URL(`../vocabulary/v1/${file}.json`, import.meta.url), 'utf8')));
const catalog = await read('catalog');
const languages = Object.fromEntries(await Promise.all(LANGUAGES.map(async language => [language.code, await read(language.code)])));
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const rows = [['Source language', 'Target language', 'Section', 'Deck', 'Importable cards', 'Target entries', 'Missing translations', 'Combined duplicates', 'Corpus positions', 'Partial', 'Estimated level cards']];
const pairCounts = {};
for (const source of LANGUAGES) for (const target of LANGUAGES) {
  if (!isPrebuiltPair(source.code, target.code)) continue;
  const library = { catalog, source: languages[source.code], target: languages[target.code] };
  const shared = new Set();
  for (const definition of definitions(catalog)) {
    const template = buildTemplate(library, definition);
    rows.push([source.name, target.name, template.kind, template.name, template.cards.length,
      template.targetCount, template.missingTranslations, template.combinedDuplicates,
      template.corpusLimit ?? '', template.partial ? 'Yes' : 'No', template.estimatedCount]);
    for (const card of template.cards) shared.add(card.entryId);
  }
  pairCounts[`${source.code}-${target.code}`] = shared.size;
}
await writeFile(new URL('../vocabulary/coverage.csv', import.meta.url), rows.map(row => row.map(quote).join(',')).join('\n') + '\n');
console.log(JSON.stringify({
  pairs: Object.keys(pairCounts).length,
  nonemptyPairs: Object.values(pairCounts).filter(Boolean).length,
  minDistinctEntriesPerPair: Math.min(...Object.values(pairCounts)),
  maxDistinctEntriesPerPair: Math.max(...Object.values(pairCounts)),
  availableDeckSelections: rows.slice(1).filter(row => row[4] > 0).length,
  coverage: catalog.coverage,
}, null, 2));
