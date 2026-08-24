import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, Store } from '../src/store.js';

function setup() { const store = new Store(); const project = store.createProject('P'); const task = store.createTask(String(project.id), 'T'); return { store, taskId: String(task.id) }; }
function mustThrow(fn: () => unknown, code: string) { assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code); }
function approve(store: Store, taskId: string) { const plan = store.createPlan(taskId, 'work'); store.submitPlan(String(plan.id)); store.decidePlan(String(plan.id), true, 'reviewer'); }

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
test('unmet dependencies block execution, then acceptance releases the existing approval flow', () => {
  const { store, taskId: prerequisiteId } = setup();
  const dependent = store.createTask(String(store.task(prerequisiteId).project_id), 'dependent'); const dependentId = String(dependent.id);
  approve(store, prerequisiteId); approve(store, dependentId);
  const dependency = store.addDependency(dependentId, prerequisiteId, 'planner');
  assert.equal(dependency.satisfied, 0);
  mustThrow(() => store.startExecution(dependentId, 'noop'), 'DEPENDENCIES_UNMET');
  const prerequisiteExecution = store.startExecution(prerequisiteId, 'noop'); store.finishExecution(String(prerequisiteExecution.id)); store.transitionTask(prerequisiteId, 'accepted', 'reviewer');
  assert.equal(store.dependencies(dependentId)[0].satisfied, 1);
  const dependentExecution = store.startExecution(dependentId, 'noop');
  assert.equal(store.task(dependentId).status, 'executing');
  assert.equal(dependentExecution.status, 'active');
  assert.ok(store.auditEvents(dependentId).some((event: any) => event.action === 'dependency_created'));
  assert.ok(store.auditEvents(dependentId).some((event: any) => event.action === 'dependency_resolved'));
});
test('self dependencies and dependency cycles are rejected', () => {
  const { store, taskId: first } = setup(); const projectId = String(store.task(first).project_id);
  const second = String(store.createTask(projectId, 'second').id); const third = String(store.createTask(projectId, 'third').id);
  mustThrow(() => store.addDependency(first, first), 'INVALID_DEPENDENCY');
  store.addDependency(first, second); store.addDependency(second, third);
  mustThrow(() => store.addDependency(third, first), 'INVALID_DEPENDENCY');
});
test('approval, execution, and acceptance state flow is audited', () => {
  const { store, taskId } = setup(); const plan = store.createPlan(taskId, 'work'); store.submitPlan(String(plan.id)); store.decidePlan(String(plan.id), true, 'reviewer');
  const execution = store.startExecution(taskId, 'noop'); store.finishExecution(String(execution.id)); store.transitionTask(taskId, 'accepted', 'reviewer');
  assert.equal(store.task(taskId).status, 'accepted'); assert.ok(store.auditEvents(taskId).length >= 4);
});
test('failed executions retain their reason and retry only creates a linked new attempt', () => {
  const { store, taskId } = setup(); approve(store, taskId);
  const first = store.startExecution(taskId, 'noop', 'executor');
  const failed = store.failExecution(String(first.id), 'timeout', 'provider did not respond', 'executor');
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure_category, 'timeout'); assert.equal(store.task(taskId).status, 'ready');
  const retry = store.retryExecution(String(first.id), 'operator');
  assert.notEqual(retry.id, first.id); assert.equal(retry.retry_of_execution_id, first.id); assert.equal(retry.status, 'active');
  mustThrow(() => store.retryExecution(String(first.id), 'operator'), 'INVALID_STATE');
  const evidence = store.evidencePackage(taskId);
  assert.deepEqual(evidence.executions.map(execution => execution.id), [first.id, retry.id]);
  assert.ok(evidence.audit_events.some((event: any) => event.action === 'failed' && event.detail.reason === 'provider did not respond'));
  assert.ok(evidence.audit_events.some((event: any) => event.action === 'execution_retried' && event.detail.retryExecutionId === retry.id));
});
test('retry preserves approval and dependency gates', () => {
  const { store, taskId } = setup(); approve(store, taskId);
  const first = store.startExecution(taskId, 'noop'); store.failExecution(String(first.id), 'unknown', 'temporary failure');
  store.db.prepare("UPDATE plans SET status='submitted' WHERE task_id=?").run(taskId);
  mustThrow(() => store.retryExecution(String(first.id)), 'PLAN_NOT_APPROVED');
  store.db.prepare("UPDATE plans SET status='approved' WHERE task_id=?").run(taskId);
  const prerequisite = String(store.createTask(String(store.task(taskId).project_id), 'prerequisite').id);
  approve(store, prerequisite); store.addDependency(taskId, prerequisite);
  mustThrow(() => store.retryExecution(String(first.id)), 'DEPENDENCIES_UNMET');
});
