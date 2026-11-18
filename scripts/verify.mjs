#!/usr/bin/env node
// End-to-end check: import the workflow into a throwaway n8n database, run it
// against the stand-in RAG service, then read the stored execution back and
// assert both branches behaved. n8n only prints its result to a TTY, so the
// execution row in SQLite is the source of truth; it is stored flatted.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { parse as unflatten } from 'flatted';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ragDir = path.resolve(here, '../../php-ticket-system');
const phpBin = path.join(ragDir, '.tools/php/php.exe');
const n8nBin =
  process.platform === 'win32'
    ? path.join(here, '../node_modules/n8n/bin/n8n.cmd').replace(/\//g, '\\')
    : path.join(here, '../node_modules/n8n/bin/n8n');
const workflow = path.join(here, '../workflow-ticket-triage.json');
const workflowId = 'ticket-triage';
const RAG_PORT = 8081;
const RAG_BASE_URL = `http://127.0.0.1:${RAG_PORT}`;

if (!existsSync(phpBin)) {
  console.error(`missing PHP build: ${phpBin}`);
  process.exit(1);
}

const userFolder = mkdtempSync(path.join(tmpdir(), 'n8n-verify-'));
const env = {
  ...process.env,
  N8N_USER_FOLDER: userFolder,
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
  N8N_LOG_LEVEL: 'error',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  RAG_BASE_URL,
  DB_TYPE: 'sqlite',
};

const failures = [];
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function runCli(args) {
  const res = spawnSync(n8nBin, args, {
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  return res.status ?? 1;
}

function latestExecution(dbFile) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.get(
      `select e.status, e.finished, d.data
         from execution_entity e
         join execution_data d on d.executionId = e.id
        where e.workflowId = ?
        order by e.id desc limit 1`,
      [workflowId],
      (err, row) => {
        db.close();
        if (err) reject(err);
        else resolve(row);
      },
    );
  });
}

async function waitForRag() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${RAG_BASE_URL}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'ping', top_k: 1, generate: false }),
      });
      if (r.ok) return true;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const rag = spawn(phpBin, ['-S', `127.0.0.1:${RAG_PORT}`, 'tests/fake_rag.php'], {
  cwd: ragDir,
  stdio: 'ignore',
});

try {
  if (!(await waitForRag())) throw new Error(`stand-in RAG service did not come up on ${RAG_BASE_URL}`);
  console.log('stand-in RAG service is up');

  check('workflow imports into a clean database', runCli(['import:workflow', `--input=${workflow}`]) === 0);
  check('n8n execute exits cleanly', runCli(['execute', `--id=${workflowId}`]) === 0);

  const row = await latestExecution(path.join(userFolder, '.n8n', 'database.sqlite'));
  if (!row) throw new Error('no stored execution — did the workflow run at all?');
  check('the run is stored as finished', row.finished === 1, `status=${row.status} finished=${row.finished}`);

  const execution = unflatten(row.data);
  const queues = [];
  for (const runs of Object.values(execution.resultData.runData)) {
    for (const run of runs) {
      for (const group of run.data?.main ?? []) {
        for (const item of group ?? []) {
          if (item.json?.queue) queues.push(item.json);
        }
      }
    }
  }
  for (const q of queues) {
    console.log(`  queue=${q.queue}  draft=${(q.draft ?? '').slice(0, 24)}  note=${(q.note ?? '').slice(0, 40)}`);
  }

  check(
    'an answerable ticket produces a draft for approval',
    queues.some((q) => q.queue === 'draft-ready' && typeof q.draft === 'string' && q.draft.length > 0),
  );
  check(
    'a refused question escalates to a human and carries no draft',
    queues.some((q) => q.queue === 'human-review' && q.draft === undefined && /不適|不足|declined|refus/i.test(q.note ?? '')),
  );
} catch (err) {
  failures.push(err.message);
  console.error(`error: ${err.message}`);
} finally {
  rag.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(userFolder, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file for a moment; not worth failing over.
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
