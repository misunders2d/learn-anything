import assert from "node:assert/strict";
import test from "node:test";
import { mentorItemIsSuperseded } from "../skills/learn-anything/blocks/adapters/codex-cli/turn-order.mjs";

const older = { id: "older", role: "user", content: "Rust", createdAt: "2026-08-23T12:00:00.000Z" };
const newer = { id: "newer", role: "user", content: "Python Protocol", createdAt: "2026-08-23T12:01:00.000Z" };
const session = { transcript: [older, newer] };

test("new learner message supersedes stale automatic feedback", () => {
  assert.equal(mentorItemIsSuperseded({ type: "execution_result", createdAt: "2026-08-23T12:00:30.000Z" }, session), true);
});

test("latest learner turn remains active while an older learner turn is superseded", () => {
  assert.equal(mentorItemIsSuperseded({ type: "user_message", message: newer }, session), false);
  assert.equal(mentorItemIsSuperseded({ type: "user_message", message: older }, session), true);
});

test('explicit retry is ordered at retry time without superseding newer learner work', () => {
  const item = { type: 'user_message', message: { id: 'old' }, retryRequestedAt: '2026-09-19T12:00:02.000Z' };
  assert.equal(mentorItemIsSuperseded(item, { transcript: [{ role: 'user', id: 'new', createdAt: '2026-09-19T12:00:01.000Z' }] }), false);
  assert.equal(mentorItemIsSuperseded(item, { transcript: [{ role: 'user', id: 'newer', createdAt: '2026-09-19T12:00:03.000Z' }] }), true);
});
