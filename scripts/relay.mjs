/**
 * relay.mjs — Opus 4.8 ↔ Cursor review loop, packaged as an aios sub-command.
 *
 * Exported entry point: cmdRelay(repo, args)
 * Called by aios.mjs as:  aios relay "task" [branch] [options]
 *
 * Options:
 *   --rounds N       max plan/review cycles (default: 5)
 *   --skill /name    Cursor slash command (default: /review-plan)
 *   --dry-run        skip git operations
 */

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const MERGE_TOKEN = 'MERGE_READY';
const DEFAULT_SKILL = '/review-plan';

const c = {
  red:    (s) => `\x1b[0;31m${s}\x1b[0m`,
  green:  (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  blue:   (s) => `\x1b[0;34m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

function die(msg) {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const dryRun    = hasFlag('--dry-run');
  const maxRounds = parseInt(flag('--rounds') ?? '5', 10);
  const skill     = flag('--skill') ?? DEFAULT_SKILL;

  const positional = args.filter((a, i) =>
    !a.startsWith('--') && args[i - 1] !== '--rounds' && args[i - 1] !== '--skill'
  );
  const [task, branch] = positional;
  return { task, branch, dryRun, maxRounds, skill };
}

// ── prereq checks ─────────────────────────────────────────────────────────────

function checkPrereqs() {
  if (!process.env.ANTHROPIC_API_KEY) {
    die('ANTHROPIC_API_KEY is not set. Add it to your .env or export it in your shell.');
  }
  try {
    execSync('cursor --version', { stdio: 'pipe' });
  } catch {
    die('cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash');
  }
}

// ── Anthropic client ──────────────────────────────────────────────────────────

async function callOpus(anthropic, messages) {
  process.stdout.write('\n[opus] planning (xhigh effort)...');
  const res = await anthropic.messages.create({
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
  process.stdout.write(' done.\n');
  const textBlock = res.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Opus returned no text block');
  return textBlock.text;
}

// ── Cursor agent subprocess ───────────────────────────────────────────────────

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

    proc.stderr.on('data', (d) => errBufs.push(d));

    rl.on('line', (line) => {
      const raw = line.trim();
      if (!raw) return;

      try {
        const ev = JSON.parse(raw);

        // Shape 1: {type:"assistant", message:{content:[{type:"text",text:"..."}]}}
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text') { process.stdout.write(block.text); text += block.text; }
          }
          return;
        }
        // Shape 2: {type:"text", text:"..."}
        if (ev.type === 'text' && typeof ev.text === 'string') {
          process.stdout.write(ev.text); text += ev.text; return;
        }
        // Shape 3: {type:"result", result:"..."} (final summary in some Cursor versions)
        if (ev.type === 'result' && typeof ev.result === 'string' && !text) {
          text = ev.result; return;
        }
        // Shape 4: {type:"content_block_delta", delta:{type:"text_delta",text:"..."}}
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          process.stdout.write(ev.delta.text); text += ev.delta.text; return;
        }
      } catch {
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

// ── prompt builder ────────────────────────────────────────────────────────────

function buildReviewPrompt(skill, plan) {
  return [
    skill,
    '',
    '## Plan to review',
    '',
    plan,
    '',
    '---',
    'Review the plan above thoroughly.',
    'List any concerns, gaps, or changes needed.',
    `When the plan is solid and ready to implement, place this token alone on the very last line:`,
    MERGE_TOKEN,
  ].join('\n');
}

// ── git operations ────────────────────────────────────────────────────────────

function gitMergeAndDelete(repo, branchName, dryRun) {
  if (dryRun) {
    console.log(c.dim(`[dry-run] git merge --no-ff ${branchName} && git branch -d ${branchName}`));
    return;
  }
  execSync(
    `git merge --no-ff ${branchName} -m "chore: auto-merge via aios relay"`,
    { stdio: 'inherit', cwd: repo }
  );
  execSync(`git branch -d ${branchName}`, { stdio: 'inherit', cwd: repo });
  console.log(c.green(`\n✓ Merged and deleted: ${branchName}`));
}

// ── main entry point ──────────────────────────────────────────────────────────

export async function cmdRelay(repo, args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log([
      '',
      c.blue('aios relay — Opus 4.8 ↔ Cursor plan review loop'),
      '',
      'usage:',
      '  aios relay "task description" [branch] [options]',
      '',
      'arguments:',
      '  task      What to implement (required)',
      '  branch    Git branch to merge when approved (optional; omit to skip git ops)',
      '',
      'options:',
      '  --rounds N       max plan/review cycles (default: 5)',
      '  --skill /name    Cursor slash command (default: /review-plan)',
      '  --dry-run        skip git operations',
      '',
      'examples:',
      '  aios relay "Add a --version flag to aios.mjs" --dry-run',
      '  aios relay "Migrate validators to Zod" --rounds 6 --dry-run',
      '  aios relay "Add rate-limit headers" feat/rate-limit --rounds 5',
    ].join('\n'));
    return;
  }

  const { task, branch, dryRun, maxRounds, skill } = parseArgs(args);
  if (!task) die('task description is required.\nusage: aios relay "task" [branch] [options]');

  checkPrereqs();

  const anthropic = new Anthropic();

  console.log('\n── aios relay ───────────────────────────────────────────────');
  console.log(`Task:       ${task}`);
  console.log(`Branch:     ${branch ?? c.dim('(none — git ops skipped)')}`);
  console.log(`Skill:      ${skill}`);
  console.log(`Max rounds: ${maxRounds}`);
  if (dryRun) console.log(c.yellow('Mode:       dry-run'));
  console.log('─────────────────────────────────────────────────────────────');

  const history = [
    { role: 'user', content: `Plan this task in detail:\n\n${task}` },
  ];

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n══ Round ${round}/${maxRounds} ${'═'.repeat(50 - String(round).length)}`);

    const plan = await callOpus(anthropic, history);
    console.log('\n── Opus plan ───────────────────────────────────────────────\n');
    console.log(plan);
    history.push({ role: 'assistant', content: plan });

    const reviewPrompt = buildReviewPrompt(skill, plan);
    const review = await callCursorAgent(reviewPrompt);

    console.log('\n\n── Cursor review done ──────────────────────────────────────');

    const lastLine = review.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
    if (lastLine === MERGE_TOKEN) {
      console.log(c.green(`\n✓ ${MERGE_TOKEN} received after round ${round}.`));
      if (branch) {
        gitMergeAndDelete(repo, branch, dryRun);
      } else {
        console.log(c.dim('No branch specified — skipping git operations. Done.'));
      }
      return;
    }

    history.push({
      role: 'user',
      content: `Cursor's review:\n\n${review}\n\nRevise the plan to address all concerns.`,
    });
  }

  console.error(c.red(`\n✗ Reached max rounds (${maxRounds}) without receiving ${MERGE_TOKEN}.`));
  process.exit(1);
}
