# Mentor turns, progress, and recovery

Read when implementing an adapter, recording a milestone, or diagnosing interrupted work. The server and its tests define the wire contract; the manual shell bridge remains an explicit compatibility path.

## Complete turns

Persistent adapters consume one `/api/mentor/next` item at a time and submit the entire response to `/api/mentor/turn`, carrying its `turnId` and `baseRevision`. Buffer learner-facing text and canvas until validation succeeds. Never publish partial canvas changes before the answer or convert provider errors into teaching text.

The server saves accepted work before acknowledging it. Work transitions through pending, inflight, committed, failed, or dismissed. Restart replays interrupted work within a bounded attempt budget. Duplicate commits must not duplicate transcript or progress. Revision checks protect edits made while the mentor was thinking; a conflict preserves the question as failed work instead of overwriting the current activity.

Failed work appears in `mentorRecovery` from `/api/session` and the initial event snapshot. Browser **Retry** posts `{turnId, action: "retry"}` to `/api/mentor/recovery` and dispatches with fresh lesson context. **Dismiss** clears the failed item without deleting the learner's transcript. Pending and inflight work are status-only; attempts to retry or dismiss active work return a conflict. Do not edit saved state manually to unblock a turn.

## Portable milestones

An optional `milestone` accompanies the same atomic commit:

```json
{
  "title": "Joined two tables",
  "takeaway": "The join key determines which rows match.",
  "nextStep": "Compare an inner join with a left join.",
  "concepts": ["join key"],
  "misconceptions": []
}
```

Record demonstrated learning, a useful takeaway, and a concrete next step. A run, click, or model assertion alone is not evidence of mastery. The server owns the milestone history in `session.json`, deduplicates it with the turn, and derives `notes.md` and `journal.md`; adapters must not independently append competing summaries.

## Execution evidence

Every run result records `executedCode` and `codeHash` from the exact submitted UTF-8 code. Editing after a run preserves the output for reference but requires another run before **Submit to mentor**. Refresh must not relabel stale output as evidence for the current code. Recovery controls must preserve unsent editor and composer drafts.
