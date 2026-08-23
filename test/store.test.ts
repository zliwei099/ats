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
