#!/usr/bin/env tsx
/**
 * UI eval harness — state-machine regression tests for ChatUiState.
 *
 * Same shape as the agent-runtime eval: each `eval/scenarios/*.ts`
 * file exports a `{ name, run }` default. The runner instantiates a
 * fresh ChatUiState per scenario, calls run(), aggregates assertion
 * results, and exits non-zero if any FAIL.
 *
 * State-level (not DOM-level) by design: catches the resolution-chain
 * and orthogonal-axis bugs that were the source of the repeated
 * picker / new-chat regressions. DOM-level tests would require
 * Playwright or Cypress and would be a separate, heavier harness.
 */

import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import type { AssertionResult } from './lib/assertions';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(HERE, 'scenarios');

interface Scenario {
  name: string;
  run: () => AssertionResult[] | Promise<AssertionResult[]>;
}

async function loadScenarios(): Promise<Array<{ file: string; scenario: Scenario }>> {
  let files: string[];
  try {
    files = (await fs.readdir(SCENARIOS_DIR)).filter((f) => f.endsWith('.ts')).sort();
  } catch {
    return [];
  }
  const loaded: Array<{ file: string; scenario: Scenario }> = [];
  for (const file of files) {
    // Windows absolute paths need a file:// URL for ESM dynamic import.
    const url = pathToFileURL(join(SCENARIOS_DIR, file)).href;
    const mod = await import(url);
    const scenario: Scenario = mod.default;
    if (!scenario || typeof scenario.run !== 'function') {
      console.warn(`[eval] skipping ${file} — no default export with .run()`);
      continue;
    }
    loaded.push({ file, scenario });
  }
  return loaded;
}

async function main(): Promise<void> {
  const entries = await loadScenarios();
  if (entries.length === 0) {
    console.log('[eval] no scenarios found in eval/scenarios/');
    process.exit(0);
  }

  console.log(`\n=== swirlock-chatbot-ui eval ===`);
  console.log(`scenarios: ${entries.length}\n`);

  let passed = 0;
  let failed = 0;

  for (const { file, scenario } of entries) {
    process.stdout.write(`  · ${scenario.name}\n`);
    let results: AssertionResult[];
    try {
      results = await scenario.run();
    } catch (err) {
      console.log(`    FAIL — scenario threw: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
      continue;
    }
    const failures = results.filter((r) => !r.ok);
    if (failures.length === 0) {
      console.log(`    PASS (${results.length} assertions)`);
      passed += 1;
    } else {
      console.log(`    FAIL`);
      for (const f of failures) console.log(`      ✗ ${f.message}`);
      failed += 1;
    }
  }

  console.log(`\n=== summary ===`);
  console.log(`  PASS:  ${passed}`);
  console.log(`  FAIL:  ${failed}`);
  console.log(`  TOTAL: ${entries.length}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[eval] runner crashed:', err);
  process.exit(2);
});
