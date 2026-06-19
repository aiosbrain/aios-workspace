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

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const MERGE_TOKEN = 'MERGE_READY';
// Allowlist: letters, digits, hyphens, underscores, forward-slash, dots only.
// Rejects any shell metacharacter before it reaches execFileSync.
const VALID_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;
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

  const dryRun        = hasFlag('--dry-run');
  const autoMerge     = hasFlag('--merge');
  const maxRounds     = parseInt(flag('--rounds') ?? '3', 10);
  const skill         = flag('--skill') ?? DEFAULT_SKILL;
  const cursorTimeout = parseInt(flag('--cursor-timeout') ?? '300', 10) * 1000;
  const logFile       = flag('--log') ?? null;

  const positional = args.filter((a, i) =>
    !a.startsWith('--') &&
    args[i - 1] !== '--rounds' &&
    args[i - 1] !== '--skill' &&
    args[i - 1] !== '--cursor-timeout' &&
    args[i - 1] !== '--log'
  );
  const [task, branch] = positional;
  return { task, branch, dryRun, autoMerge, maxRounds, skill, cursorTimeout, logFile };
}

// ── prereq checks ─────────────────────────────────────────────────────────────

function checkPrereqs() {
  if (!process.env.ANTHROPIC_API_KEY) {
    die('ANTHROPIC_API_KEY is not set. Add it to your .env or export it in your shell.');
  }
  try {
    execFileSync('cursor', ['--version'], { stdio: 'pipe' });
  } catch {
    die('cursor CLI not found. Install: curl https://cursor.com/install -fsS | bash');
  }
}

// ── Anthropic client ──────────────────────────────────────────────────────────

async function callOpus(anthropic, messages) {
  process.stdout.write('\n[opus] planning (xhigh effort)...');
  // xhigh effort can exceed 10 minutes — streaming is required by the SDK.
  // .finalMessage() collects the full response once the stream completes.
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
  const textBlock = res.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Opus returned no text block');
  return textBlock.text;
}

// ── Cursor agent subprocess ───────────────────────────────────────────────────

async function callCursorAgent(prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    process.stdout.write('\n[cursor] invoking agent...\n');

    const proc = spawn(
      'cursor',
      ['agent', '-p', prompt, '--output-format', 'stream-json'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`cursor agent timed out after ${timeoutMs / 1000}s — increase with --cursor-timeout <seconds>`));
    }, timeoutMs);

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
      clearTimeout(timer);
      if (code === 0 || (code === null && text)) {
        resolve(text.trim());
      } else {
        const errMsg = Buffer.concat(errBufs).toString().trim();
        reject(new Error(`cursor agent exited ${code}${errMsg ? ': ' + errMsg.slice(0, 400) : ''}`));
      }
    });
  });
}

// ── prompt builder ────────────────────────────────────────────────────────────

function buildReviewPrompt(skill, plan, round, maxRounds) {
  const isLastRound = round >= maxRounds;
  const roundNote = isLastRound
    ? `**This is the final round (${round}/${maxRounds}). Approve unless there is a Blocker. Do not raise new Majors or Minors at this stage.**`
    : `Round ${round} of ${maxRounds}. If only Minors remain after this round, approve on the next.`;

  return [
    skill,
    '',
    `> ${roundNote}`,
    '',
    '## Plan to review',
    '',
    plan,
    '',
    '---',
    'Review the plan above.',
    'List any Blockers or approach-level Majors. Minor issues do not block approval.',
    `When the plan is ready to implement, place this token alone on the very last line:`,
    MERGE_TOKEN,
  ].join('\n');
}

// ── git operations ────────────────────────────────────────────────────────────

function validateBranch(branchName) {
  if (!VALID_BRANCH_RE.test(branchName)) {
    die(`invalid branch name '${branchName}' — only letters, digits, hyphens, underscores, dots, and slashes are allowed`);
  }
}

function gitMergeAndDelete(repo, branchName, dryRun) {
  validateBranch(branchName);
  if (dryRun) {
    console.log(c.dim(`[dry-run] git merge --no-ff -- ${branchName} && git branch -d -- ${branchName}`));
    return;
  }
  execFileSync('git', ['merge', '--no-ff', '-m', 'chore: merge via aios relay', '--', branchName],
    { stdio: 'inherit', cwd: repo });
  execFileSync('git', ['branch', '-d', '--', branchName],
    { stdio: 'inherit', cwd: repo });
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
      '  --rounds N              max plan/review cycles (default: 3)',
      '  --log <file>            save the final approved plan to a file',
      '  --skill /name           Cursor slash command (default: /review-plan)',
      '  --cursor-timeout N      seconds before killing a stalled Cursor call (default: 300)',
      '  --merge                 auto-merge the branch on approval (off by default)',
      '  --dry-run               skip git operations',
      '',
      'examples:',
      '  aios relay "Add a --version flag to aios.mjs" --dry-run',
      '  aios relay "Add m365 integration" --rounds 3 --log plan.md --dry-run',
      '  aios relay "Add rate-limit headers" feat/rate-limit --rounds 3 --log plan.md',
    ].join('\n'));
    return;
  }

  const { task, branch, dryRun, autoMerge, maxRounds, skill, cursorTimeout, logFile } = parseArgs(args);
  if (!task) die('task description is required.\nusage: aios relay "task" [branch] [options]');

  checkPrereqs();

  const anthropic = new Anthropic();

  // Initialise log file with a header so partial runs are recoverable
  if (logFile) {
    writeFileSync(logFile, `# aios relay plan\n\nTask: ${task}\n\n`);
  }

  const log = (label, text) => {
    if (!logFile) return;
    appendFileSync(logFile, `\n---\n## ${label}\n\n${text}\n`);
  };

  console.log('\n── aios relay ───────────────────────────────────────────────');
  console.log(`Task:       ${task}`);
  console.log(`Branch:     ${branch ?? c.dim('(none — git ops skipped)')}`);
  console.log(`Skill:      ${skill}`);
  console.log(`Max rounds: ${maxRounds}`);
  if (logFile) console.log(`Log:        ${logFile}`);
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
    log(`Round ${round} — Opus plan`, plan);
    history.push({ role: 'assistant', content: plan });

    const reviewPrompt = buildReviewPrompt(skill, plan, round, maxRounds);
    const review = await callCursorAgent(reviewPrompt, cursorTimeout);
    log(`Round ${round} — Cursor review`, review);

    console.log('\n\n── Cursor review done ──────────────────────────────────────');

    const lastLine = review.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
    if (lastLine === MERGE_TOKEN) {
      console.log(c.green(`\n✓ ${MERGE_TOKEN} received after round ${round}.`));
      if (logFile) {
        appendFileSync(logFile, `\n---\n## Approved plan (round ${round})\n\n${plan}\n`);
        console.log(c.dim(`Plan saved to ${logFile}`));
      }
      if (branch && autoMerge) {
        gitMergeAndDelete(repo, branch, dryRun);
      } else if (branch) {
        console.log(c.yellow('\nPlan approved. Review the diff before merging:'));
        console.log(c.dim(`  git diff main...${branch}`));
        console.log(c.dim(`  git merge --no-ff -- ${branch}`));
        console.log(c.dim('Re-run with --merge to have aios relay merge automatically.'));
      } else {
        console.log(c.dim('Plan approved. No branch specified — nothing to merge.'));
      }
      return;
    }

    history.push({
      role: 'user',
      content: `Cursor's review:\n\n${review}\n\nRevise the plan to address all concerns.`,
    });
  }

  // Save the last plan even if unapproved — don't lose the work
  const lastPlan = history.filter(m => m.role === 'assistant').at(-1)?.content ?? '';
  if (logFile && lastPlan) {
    appendFileSync(logFile, `\n---\n## Last plan (round limit reached — unapproved)\n\n${lastPlan}\n`);
    console.log(c.yellow(`\nRound limit reached. Last plan saved to ${logFile}`));
    console.log(c.dim('Review it, answer any open questions, then re-run or hand off to your build agent.'));
  } else {
    console.error(c.red(`\n✗ Reached max rounds (${maxRounds}) without receiving ${MERGE_TOKEN}.`));
  }
  process.exit(1);
}
