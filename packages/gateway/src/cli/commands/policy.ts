/**
 * `gatewarden policy` — view and manage policy rules.
 *
 * Subcommands:
 *   gatewarden policy show [--rules-file <path>]   Print loaded rules as JSON
 *   gatewarden policy load --rules-file <path>     Load rules from file and save to state dir
 */

import { readFileSync } from 'node:fs';
import type { PolicyRule } from '@gatewarden/govern';
import type { CliState } from '../state.js';
import { loadPolicyRules, savePolicyRules } from '../state.js';

export interface PolicyOptions {
  subcommand: 'show' | 'load';
  rulesFile?: string;
}

export function cmdPolicy(state: CliState, opts: PolicyOptions): void {
  if (opts.subcommand === 'show') {
    const rules = loadPolicyRules(state.stateDir, opts.rulesFile);
    console.log(JSON.stringify(rules, null, 2));
    return;
  }

  // load subcommand
  if (!opts.rulesFile) {
    console.error('Error: policy load requires --rules-file <path>');
    process.exit(1);
  }

  let rules: PolicyRule[];
  try {
    rules = JSON.parse(readFileSync(opts.rulesFile, 'utf8')) as PolicyRule[];
  } catch (err) {
    console.error(
      `Error: failed to read rules file: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  savePolicyRules(state.stateDir, rules);
  console.log(JSON.stringify({ ok: true, rulesLoaded: rules.length }));
}
