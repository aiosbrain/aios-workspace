#!/usr/bin/env node
/**
 * agent-relay.mjs — Opus 4.8 plan → Cursor review loop → auto git merge
 *
 * Usage:
 *   node scripts/agent-relay.mjs "task" [branch] [--rounds N] [--dry-run] [--skill /my-skill]
 *
 * Env:
 *   ANTHROPIC_API_KEY  required
 *   CURSOR_API_KEY     required (used implicitly by cursor CLI)
 *
 * Cursor CLI must be installed: curl https://cursor.com/install -fsS | bash
 *
 * Merge signal: instruct Cursor to end its response with MERGE_READY when satisfied.
 * The loop exits and merges the branch on that token.
 *
 * Cursor slash commands: the -p flag passes the prompt directly to the agent.
 * If your /review-plan skill isn't triggered by the prefix, extract the skill's
 * underlying prompt and set REVIEW_PREAMBLE below instead.
 */

import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import Anthropic from '@anthropic-ai/sdk';

// ── Config ────────────────────────────────────────────────────────────────────

const MERGE_TOKEN   = 'MERGE_READY';
const DEFAULT_SKILL = '/review-plan';
const VALID_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;

// Fallback preamble if your Cursor skill isn't triggered via CLI prefix.
// Leave empty to rely on the slash command.
const REVIEW_PREAMBLE = process.env.REVIEW_PREAMBLE || '';

// ── Parse CLI args ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(name);

const dryRun   = hasFlag('--dry-run');
const maxRounds = parseInt(flag('--rounds') ?? '5');
const skill     = flag('--skill') ?? DEFAULT_SKILL;

const positional = argv.filter((a, i) =>
  !a.startsWith('--') && argv[i - 1] !== '--rounds' && argv[i - 1] !== '--skill'
);
const [task, branch] = positional;

if (!task) {
  console.error([
    'Usage: node scripts/agent-relay.mjs "task" [branch] [options]',
    '',
    'Options:',
    '  --rounds N       max plan/review cycles (default: 5)',
    '  --skill /name    Cursor slash command to invoke (default: /review-plan)',
    '  --dry-run        skip git operations',
  ].join('\n'));
  process.exit(1);
}

// ── Prereq checks ─────────────────────────────────────────────────────────────

function checkPrereqs() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }
  try {
    execSync('cursor --version', { stdio: 'pipe' });
  } catch {
    console.error('cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash');
    process.exit(1);
  }
}

// ── Anthropic client ──────────────────────────────────────────────────────────

const anthropic = new Anthropic();

async function callOpus(messages) {
  process.stdout.write('\n[opus] planning (xhigh effort)...');
  // xhigh effort can exceed 10 minutes — streaming is required by the SDK.
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
    system: [
      'You are a senior software architect.',
      'When given a task, produce a clear, numbered implementation plan.',
      'When given feedback, revise the plan to address all concerns — be specific.',
    ].join(' '),
    messages,
  });
  const res = await stream.finalMessage();
  process.stdout.write(' done.\n');
  const textBlock = res.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Opus returned no text block');
  return textBlock.text;
}

// ── Cursor agent subprocess ───────────────────────────────────────────────────

/**
 * Spawns `cursor agent -p <prompt> --output-format stream-json`.
 * Parses NDJSON events and accumulates text content.
 *
 * Cursor's NDJSON stream is not publicly documented — this parser captures
 * text from the most common event shapes seen in practice. If your Cursor
 * version emits a different shape, set --output-format text below and the
 * fallback stdout capture will still work.
 */
async function callCursorAgent(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write('\n[cursor] invoking agent...\n');

    const proc = spawn(
      'cursor',
      ['agent', '-p', prompt, '--output-format', 'stream-json'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const rl = createInterface({ input: proc.stdout });
    const errBufs = [];
    let text = '';

    proc.stderr.on('data', d => errBufs.push(d));

    rl.on('line', (line) => {
      const raw = line.trim();
      if (!raw) return;

      // Try structured NDJSON first
      try {
        const ev = JSON.parse(raw);

        // Shape 1: {type:"assistant", message:{content:[{type:"text",text:"..."}]}}
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text') {
              process.stdout.write(block.text);
              text += block.text;
            }
          }
          return;
        }

        // Shape 2: {type:"text", text:"..."}
        if (ev.type === 'text' && typeof ev.text === 'string') {
          process.stdout.write(ev.text);
          text += ev.text;
          return;
        }

        // Shape 3: {type:"result", result:"..."}  (final summary in some versions)
        if (ev.type === 'result' && typeof ev.result === 'string' && !text) {
          text = ev.result;
          return;
        }

        // Shape 4: {type:"content_block_delta", delta:{type:"text_delta",text:"..."}}
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          process.stdout.write(ev.delta.text);
          text += ev.delta.text;
          return;
        }
      } catch {
        // Non-JSON line (progress bar, etc.) — pass through to stdout for visibility
        process.stdout.write(raw + '\n');
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(text.trim());
      } else {
        const errMsg = Buffer.concat(errBufs).toString().trim();
        reject(new Error(`cursor agent exited ${code}${errMsg ? ': ' + errMsg.slice(0, 400) : ''}`));
      }
    });
  });
}

// ── Build Cursor review prompt ────────────────────────────────────────────────

function buildReviewPrompt(plan) {
  const parts = [];

  if (REVIEW_PREAMBLE) {
    // Custom preamble overrides slash command
    parts.push(REVIEW_PREAMBLE);
  } else {
    // Prefix with your Cursor slash command; the agent will interpret it
    parts.push(skill);
  }

  parts.push('', '## Plan to review', '', plan, '');

  parts.push(
    '---',
    'Review the plan above thoroughly.',
    'List any concerns, gaps, or changes needed.',
    `When the plan is solid and ready to implement, place this token alone on the very last line of your response:`,
    MERGE_TOKEN,
  );

  return parts.join('\n');
}

// ── Git operations ────────────────────────────────────────────────────────────

function gitMergeAndDelete(branchName) {
  if (!VALID_BRANCH_RE.test(branchName)) {
    console.error(`error: invalid branch name '${branchName}'`);
    process.exit(1);
  }
  if (dryRun) {
    console.log(`[dry-run] git merge --no-ff -- ${branchName} && git branch -d -- ${branchName}`);
    return;
  }
  execFileSync('git', ['merge', '--no-ff', '--', branchName, '-m', 'chore: merge via agent-relay'],
    { stdio: 'inherit' });
  execFileSync('git', ['branch', '-d', '--', branchName], { stdio: 'inherit' });
  console.log(`\n✓ Merged and deleted: ${branchName}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  checkPrereqs();

  console.log('\n── Agent Relay ──────────────────────────────────────────────');
  console.log(`Task:       ${task}`);
  console.log(`Branch:     ${branch ?? '(none — git ops skipped)'}`);
  console.log(`Skill:      ${REVIEW_PREAMBLE ? '(custom preamble)' : skill}`);
  console.log(`Max rounds: ${maxRounds}`);
  if (dryRun) console.log('Mode:       dry-run');
  console.log('─────────────────────────────────────────────────────────────');

  const history = [
    { role: 'user', content: `Plan this task in detail:\n\n${task}` },
  ];

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n══ Round ${round}/${maxRounds} ${'═'.repeat(50 - String(round).length)}`);

    // 1. Opus generates or revises the plan
    const plan = await callOpus(history);
    console.log('\n── Opus plan ───────────────────────────────────────────────\n');
    console.log(plan);
    history.push({ role: 'assistant', content: plan });

    // 2. Cursor reviews the plan
    const reviewPrompt = buildReviewPrompt(plan);
    const review = await callCursorAgent(reviewPrompt);

    // stream-json parser already prints to stdout; add a separator
    console.log('\n\n── Cursor review done ──────────────────────────────────────');

    // 3. Check for merge signal — must be the last non-empty line to avoid
    //    false positives when the task description or plan mentions the token.
    const lastLine = review.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
    if (lastLine === MERGE_TOKEN) {
      console.log(`\n✓ ${MERGE_TOKEN} received after round ${round}.`);
      if (branch) {
        gitMergeAndDelete(branch);
      } else {
        console.log('No branch specified — skipping git operations. Done.');
      }
      process.exit(0);
    }

    // 4. Feed review back to Opus for next round
    history.push({
      role: 'user',
      content: `Cursor's review:\n\n${review}\n\nRevise the plan to address all concerns.`,
    });
  }

  console.error(`\n✗ Reached max rounds (${maxRounds}) without receiving ${MERGE_TOKEN}.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
