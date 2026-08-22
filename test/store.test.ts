import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, Store } from '../src/store.js';

function setup() { const store = new Store(); const project = store.createProject('P'); const task = store.createTask(String(project.id), 'T'); return { store, taskId: String(task.id) }; }
function mustThrow(fn: () => unknown, code: string) { assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code); }

test('execution cannot start before plan approval', () => {
  const { store, taskId } = setup();
  const plan = store.createPlan(taskId, 'work'); store.submitPlan(String(plan.id));
  mustThrow(() => store.startExecution(taskId, 'noop'), 'PLAN_NOT_APPROVED');
});
test('illegal task transitions are rejected', () => {
  const { store, taskId } = setup();
  mustThrow(() => store.transitionTask(taskId, 'accepted'), 'INVALID_STATE');
});
test('a task has exactly one active execution', () => {
  const { store, taskId } = setup();
  const plan = store.createPlan(taskId, 'work'); store.submitPlan(String(plan.id)); store.decidePlan(String(plan.id), true, 'reviewer');
  store.startExecution(taskId, 'noop');
  mustThrow(() => store.startExecution(taskId, 'noop'), 'INVALID_STATE');
});
test('approval, execution, and acceptance state flow is audited', () => {
  const { store, taskId } = setup(); const plan = store.createPlan(taskId, 'work'); store.submitPlan(String(plan.id)); store.decidePlan(String(plan.id), true, 'reviewer');
  const execution = store.startExecution(taskId, 'noop'); store.finishExecution(String(execution.id)); store.transitionTask(taskId, 'accepted', 'reviewer');
  assert.equal(store.task(taskId).status, 'accepted'); assert.ok(store.auditEvents(taskId).length >= 4);
});
