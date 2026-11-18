# Ticket triage to reply draft — an n8n workflow

Incoming support tickets, answered by a retrieval service, with the outcome
explicitly classified before anything reaches a customer:

- the service returns a grounded answer → the ticket is queued as **draft-ready**
  with that draft attached for a human to approve;
- the service refuses (no confident source) → the ticket is queued as
  **human-review** with the reason attached, and **no draft is produced**;
- the service errors or returns nothing → **human-review** as well.

Nothing is ever sent automatically. The workflow is the part that decides *who
has to write the reply*, not a machine that talks to customers.

```
Run manually / webhook POST /webhook/ticket
        │
        ▼
 Sample tickets (2 items: answerable + refusal)
        │
        ▼
 Ask RAG for a cited draft        POST {RAG_BASE_URL}/api/ask
        │
        ▼
 Classify draft, refusal, failure  →  outcome: draft | refused | failed
        │
        ▼
 Escalate?  needs_human == true
   ├── yes → Hand to an agent      queue = human-review, note = reason
   └── no  → Attach draft for approval   queue = draft-ready, draft = reply
        │
        ▼
 Reply to caller (respondToWebhook)
```

## The service contract

The workflow talks to the same HTTP service the PHP support desk uses
(`hk-law-rag` / its stand-in), so one endpoint serves both demos:

```http
POST /api/ask
{ "question": "Ticket subject: …\nTicket body: …", "top_k": 4, "generate": true }

200 { "answer": "…", "refused": false }
200 { "answer": null, "refused": true, "reason": "retrieval similarity too low" }
```

`tests/fake_rag.php` in the PHP repository implements exactly this contract and
refuses any question containing `REFUSE_ME`, which is what lets the check below
exercise both branches without a model running.

## Run it

```bash
npm install
npm run import                       # import the workflow into n8n
n8n execute --id=ticket-triage       # or open `n8n start` and press Execute
```

Environment used by the workflow:

| Variable | Why |
| --- | --- |
| `RAG_BASE_URL` | base URL of the retrieval service |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | n8n blocks `$env` inside nodes by default; this workflow needs the base URL |

## Verify it

```bash
npm run verify
```

That imports the workflow into a throwaway n8n database, starts the stand-in
retrieval service, runs the workflow, then reads the stored execution back and
asserts:

```
PASS  workflow imports into a clean database
PASS  n8n execute exits cleanly
PASS  the run is stored as finished
PASS  an answerable ticket produces a draft for approval
PASS  a refused question escalates to a human and carries no draft
```

Two things that make this check worth having rather than decorative:

1. **It reads the execution row from SQLite** (`execution_entity` +
   `execution_data`, stored [flatted](https://www.npmjs.com/package/flatted)),
   because n8n's CLI prints its result only to a TTY. Asserting on stdout would
   pass quietly while the workflow did nothing.
2. **The refusal path is asserted as hard as the happy path.** A draft that is
   silently empty is the failure mode that actually hurts: the customer gets
   nothing, or worse, gets a confident sentence the service never stood behind.

## Limits, stated plainly

- No ticketing-system integration yet — the input is a webhook payload and the
  output is a JSON response.
- One RAG call per ticket, no retry, no rate limiting.
- n8n 2.48 only supports SQLite or Postgres for its own database; this demo uses
  SQLite.
- The classification trusts the service's `refused` flag. If the service starts
  returning confident nonsense, this workflow will happily forward it as a
  draft — which is why approval stays human.
