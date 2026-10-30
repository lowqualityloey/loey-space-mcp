// Compatibility wrapper.
// The single implementation lives in src/search-engine.cjs so the canonical CLI
// (CommonJS) and the test suite (ESM) run the same engine. Do not re-implement it here.
import engine from './search-engine.cjs';

export const stem = engine.stem;
export const tokenize = engine.tokenize;
export const expandQuery = engine.expandQuery;
export const extractSections = engine.extractSections;
export const buildVaultIndex = engine.buildVaultIndex;
export const getOrUpdateIndex = engine.getOrUpdateIndex;
export const searchVaultRunbooks = engine.searchVaultRunbooks;
export default engine;
