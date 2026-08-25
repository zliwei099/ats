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
test('plan history preserves ordered decisions and only the current approved version can execute', () => {
  const { store, taskId } = setup();
  const first = store.createPlan(taskId, 'first proposal', 'planner-a');
  store.submitPlan(String(first.id), 'planner-a');
  const rejected = store.decidePlan(String(first.id), false, 'reviewer-a', 'needs an explicit rollback');
  const second = store.createPlan(taskId, 'second proposal', 'planner-b');
  store.submitPlan(String(second.id), 'planner-b');
  const approved = store.decidePlan(String(second.id), true, 'reviewer-b');
  const history = store.planHistory(taskId);
  assert.deepEqual(history.map(plan => [plan.version, plan.status, plan.display_status, plan.is_current]), [[1, 'rejected', 'superseded', false], [2, 'approved', 'approved', true]]);
  assert.equal(history[0].created_by, 'planner-a'); assert.equal(history[0].decided_by, 'reviewer-a'); assert.equal(history[0].rejection_reason, 'needs an explicit rollback');
  assert.equal(store.evidencePackage(taskId).plan?.id, approved.id);
  assert.equal(store.evidencePackage(taskId).plan_history.length, 2);
  assert.doesNotThrow(() => store.startExecution(taskId, 'noop'));
  mustThrow(() => store.decidePlan(String(first.id), true, 'reviewer-c'), 'INVALID_STATE');
  mustThrow(() => store.createPlan('missing', 'no task'), 'NOT_FOUND');
});
test('a newer unapproved plan closes the execution gate even if an older plan was approved', () => {
  const { store, taskId } = setup();
  approve(store, taskId);
  const newer = store.createPlan(taskId, 'needs review');
  assert.equal(newer.version, 2);
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
test('dependency view gives stable direct relationships and explains unmet prerequisites', () => {
  const { store, taskId: prerequisiteId } = setup(); const projectId = String(store.task(prerequisiteId).project_id);
  const second = String(store.createTask(projectId, 'second').id); const dependentId = String(store.createTask(projectId, 'dependent').id);
  approve(store, prerequisiteId); approve(store, second); approve(store, dependentId);
  store.addDependency(dependentId, second); store.addDependency(dependentId, prerequisiteId);
  const firstView = store.dependencyView(dependentId); const repeatedView = store.dependencyView(dependentId);
  assert.deepEqual(repeatedView, firstView);
  assert.deepEqual(firstView.prerequisites.map(item => item.depends_on_task_id), store.dependencies(dependentId).map(item => item.depends_on_task_id));
  assert.equal(firstView.can_start, false);
  assert.deepEqual(firstView.blocking_reasons.filter(reason => reason.code === 'PREREQUISITE_INCOMPLETE').map(reason => reason.task_id), firstView.prerequisites.map(item => item.depends_on_task_id));
  for (const id of [prerequisiteId, second]) { const execution = store.startExecution(id, 'noop'); store.finishExecution(String(execution.id)); store.transitionTask(id, 'accepted', 'reviewer'); }
  const unblocked = store.dependencyView(dependentId);
  assert.equal(unblocked.can_start, true); assert.deepEqual(unblocked.blocking_reasons, []);
  assert.ok(unblocked.next_executable_conditions.every(condition => condition.satisfied));
});
test('dependency view identifies failed prerequisite retry chains and invalid tasks are rejected', () => {
  const { store, taskId: prerequisiteId } = setup(); const dependentId = String(store.createTask(String(store.task(prerequisiteId).project_id), 'dependent').id);
  approve(store, prerequisiteId); approve(store, dependentId); store.addDependency(dependentId, prerequisiteId);
  const execution = store.startExecution(prerequisiteId, 'noop'); store.failExecution(String(execution.id), 'timeout', 'timed out');
  const failed = store.dependencyView(dependentId);
  assert.ok(failed.blocking_reasons.some(reason => reason.code === 'PREREQUISITE_FAILED_RETRY_REQUIRED' && reason.execution_id === execution.id));
  const retry = store.retryExecution(String(execution.id));
  const retrying = store.dependencyView(dependentId);
  assert.ok(retrying.blocking_reasons.some(reason => reason.code === 'PREREQUISITE_RETRY_IN_PROGRESS' && reason.execution_id === retry.id));
  mustThrow(() => store.dependencyView('missing'), 'NOT_FOUND');
});
test('approval, execution, and acceptance state flow is audited', () => {
  const { store, taskId } = setup(); const plan = store.createPlan(taskId, 'work'); store.submitPlan(String(plan.id)); store.decidePlan(String(plan.id), true, 'reviewer');
  const execution = store.startExecution(taskId, 'noop'); store.finishExecution(String(execution.id)); store.transitionTask(taskId, 'accepted', 'reviewer');
  assert.equal(store.task(taskId).status, 'accepted'); assert.ok(store.auditEvents(taskId).length >= 4);
});
test('handoff appends an immutable responsibility chain and assigns future executions to the new owner', () => {
  const store = new Store(); const project = store.createProject('P'); const task = store.createTask(String(project.id), 'T', 'alice'); const taskId = String(task.id);
  approve(store, taskId);
  const handedOff = store.handoffTask(taskId, 'alice', 'bob', 'handoff after review', 'coordinator');
  assert.equal(handedOff.owner, 'bob');
  const execution = store.startExecution(taskId, 'noop', 'someone-else');
  const evidence = store.evidencePackage(taskId);
  assert.equal(evidence.executions[0].started_by, 'bob');
  assert.deepEqual(evidence.responsibility_chain.map(item => [item.from_owner, item.to_owner, item.reason]), [[null, 'alice', null], ['alice', 'bob', 'handoff after review']]);
  assert.ok(evidence.audit_events.some((event: any) => event.action === 'ownership_handed_off' && event.detail.toOwner === 'bob'));
  assert.equal(store.execution(String(execution.id)).status, 'active');
});
test('handoff rejects invalid owners, missing tasks, and active executions without changing history', () => {
  const store = new Store(); const project = store.createProject('P'); const task = store.createTask(String(project.id), 'T', 'alice'); const taskId = String(task.id);
  mustThrow(() => store.handoffTask(taskId, 'alice', 'alice', 'same'), 'INVALID_HANDOFF');
  mustThrow(() => store.handoffTask(taskId, '', 'bob', 'missing source'), 'INVALID_HANDOFF');
  mustThrow(() => store.handoffTask('missing', 'alice', 'bob', 'missing task'), 'NOT_FOUND');
  approve(store, taskId); store.startExecution(taskId, 'noop');
  const before = store.evidencePackage(taskId);
  mustThrow(() => store.handoffTask(taskId, 'alice', 'bob', 'active execution'), 'EXECUTION_ACTIVE');
  const after = store.evidencePackage(taskId);
  assert.equal(after.task.owner, 'alice'); assert.deepEqual(after.responsibility_chain, before.responsibility_chain); assert.deepEqual(after.audit_events, before.audit_events);
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
test('decision memories retain creation order when timestamps collide', () => {
  const store = new Store();
  (store as any).now = () => '2026-08-24T00:00:00.000Z';
  const project = store.createProject('P');
  const first = store.createDecisionMemory(String(project.id), 'First decision', { type: 'task', reference: 'ATS-1' }, 'MVP');
  const second = store.createDecisionMemory(String(project.id), 'Second decision', { type: 'audit', reference: 'audit:2' }, 'MVP');
  assert.deepEqual(store.decisionMemories(String(project.id), 'all').map(memory => memory.id), [first.id, second.id]);
});

test('personal memories are isolated by executor, validate traceable sources, and audit accesses', () => {
  const { store, taskId } = setup();
  store.createExecutor('alice', 'Alice'); store.createExecutor('bob', 'Bob');
  const first = store.createPersonalMemory('alice', { content: 'Use an approved plan first', kind: 'lesson', tags: ['workflow'], sourceTaskId: taskId });
  const second = store.createPersonalMemory('alice', { content: 'Keep evidence stable', tags: ['testing'] });
  store.createPersonalMemory('bob', { content: 'Do not share private context', tags: ['privacy'] });
  assert.deepEqual(store.personalMemories('alice', 'alice').map(memory => memory.id), [first.id, second.id]);
  assert.deepEqual(store.personalMemories('bob', 'bob').map(memory => memory.content), ['Do not share private context']);
  mustThrow(() => store.personalMemories('alice', 'bob'), 'MEMORY_ACCESS_DENIED');
  mustThrow(() => store.createPersonalMemory('missing', { content: 'no' }), 'NOT_FOUND');
  mustThrow(() => store.createPersonalMemory('alice', { content: '   ' }), 'INVALID_MEMORY');
  mustThrow(() => store.createPersonalMemory('alice', { content: 'bad source', sourceTaskId: 'missing' }), 'NOT_FOUND');
  assert.ok(store.auditEvents('alice').some((event: any) => event.action === 'personal_memories_accessed'));
  assert.ok(store.auditEvents(String(first.id)).some((event: any) => event.action === 'created'));
});

test('task risks respect exact time boundaries, stable severity sorting, owners, and completed-task exclusion', () => {
  const createdAt = new Date('2026-08-17T12:00:00.000Z');
  const observedAt = new Date('2026-08-24T12:00:00.000Z');
  let current = createdAt;
  const store = new Store(':memory:', () => current);
  const project = store.createProject('P'); const projectId = String(project.id);
  const stale = store.createTask(projectId, 'stale', 'carol');
  current = observedAt;
  const overdue = store.createTask(projectId, 'overdue', 'alice', '2026-08-24T11:59:59.999Z');
  const dueSoon = store.createTask(projectId, 'due soon', 'bob', '2026-08-25T12:00:00.000Z');
  const safe = store.createTask(projectId, 'safe', 'dana', '2026-08-25T12:00:00.001Z');
  const exact = store.createTask(projectId, 'exact boundary', 'erin', '2026-08-25T12:00:00.000Z');
  const risks = store.projectRisks(projectId, observedAt);
  assert.deepEqual(risks.map(risk => risk.risk_code), ['OVERDUE', 'DUE_SOON', 'DUE_SOON', 'STALE']);
  assert.equal(risks[0].owner, 'alice'); assert.equal(risks[3].owner, 'carol');
  assert.deepEqual(risks.slice(1, 3).map(risk => risk.owner).sort(), ['bob', 'erin']);
  assert.deepEqual(store.projectRisks(projectId, observedAt), risks);
  assert.equal(store.taskRisk(String(safe.id), observedAt), null);
  assert.equal(store.taskRisk(String(exact.id), observedAt)?.trigger_facts.remaining_hours, 24);
  assert.equal(store.taskRisk(String(stale.id), observedAt)?.trigger_facts.inactive_hours, 168);
  store.db.prepare("UPDATE tasks SET status='accepted' WHERE id=?").run(overdue.id);
  assert.deepEqual(new Set(store.projectRisks(projectId, observedAt).map(risk => risk.task_id)), new Set([String(dueSoon.id), String(exact.id), String(stale.id)]));
  assert.throws(() => store.createTask(projectId, 'bad', 'owner', 'invalid-date'), (error: any) => error.code === 'INVALID_DUE_DATE');
});

test('delivery readiness derives stable actionable blockers and becomes ready only after acceptance', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');
  const store = new Store(':memory:', () => now); const project = store.createProject('delivery'); const projectId = String(project.id);
  const approval = store.createTask(projectId, 'approval', 'planner');
  const prerequisite = store.createTask(projectId, 'prerequisite', 'dependency-owner');
  const dependent = store.createTask(projectId, 'dependent', 'delivery-owner');
  const active = store.createTask(projectId, 'active', 'executor');
  const review = store.createTask(projectId, 'review', 'verifier');
  const risk = store.createTask(projectId, 'risk', 'risk-owner', '2026-08-24T11:00:00.000Z');
  for (const task of [prerequisite, dependent, active, review, risk]) approve(store, String(task.id));
  store.addDependency(String(dependent.id), String(prerequisite.id));
  store.startExecution(String(active.id), 'noop');
  const reviewExecution = store.startExecution(String(review.id), 'noop'); store.finishExecution(String(reviewExecution.id));
  const first = store.deliveryReadiness(projectId, now); const second = store.deliveryReadiness(projectId, now);
  assert.deepEqual(second, first);
  assert.equal(first.conclusion, 'not_ready'); assert.equal(first.project_status, 'in_progress');
  assert.deepEqual(first.blockers.map(item => item.code), [...first.blockers.map(item => item.code)].sort());
  assert.ok(first.blockers.some(item => item.code === 'PLAN_APPROVAL_REQUIRED' && item.task_id === approval.id && item.owner === 'planner'));
  assert.ok(first.blockers.some(item => item.code === 'PREREQUISITE_INCOMPLETE' && item.task_id === dependent.id && item.next_action.code === 'SATISFY_PREREQUISITE'));
  assert.ok(first.blockers.some(item => item.code === 'ACTIVE_EXECUTION' && item.task_id === active.id));
  assert.ok(first.blockers.some(item => item.code === 'INDEPENDENT_VERIFICATION_REQUIRED' && item.task_id === review.id && item.next_action.code === 'REVIEW_AND_ACCEPT'));
  assert.ok(first.blockers.some(item => item.code === 'OVERDUE' && item.task_id === risk.id));
  const empty = store.createProject('empty');
  assert.deepEqual(store.deliveryReadiness(String(empty.id), now).blockers.map(item => item.code), ['PROJECT_HAS_NO_TASKS']);
  for (const task of [prerequisite, dependent, active, review, risk]) {
    const id = String(task.id); const status = String(store.task(id).status);
    if (status === 'executing') { const execution = store.evidencePackage(id).executions.find(item => item.status === 'active')!; store.finishExecution(String(execution.id)); }
    if (store.task(id).status === 'awaiting_acceptance') store.transitionTask(id, 'accepted', 'reviewer');
  }
  approve(store, String(approval.id)); const approvalExecution = store.startExecution(String(approval.id), 'noop'); store.finishExecution(String(approvalExecution.id)); store.transitionTask(String(approval.id), 'accepted', 'reviewer');
  for (const task of [prerequisite, dependent, risk]) {
    const id = String(task.id); const execution = store.startExecution(id, 'noop'); store.finishExecution(String(execution.id)); store.transitionTask(id, 'accepted', 'reviewer');
  }
  const ready = store.deliveryReadiness(projectId, now);
  assert.equal(ready.conclusion, 'ready'); assert.equal(ready.project_status, 'accepted'); assert.deepEqual(ready.blockers, []);
  mustThrow(() => store.deliveryReadiness('missing', now), 'NOT_FOUND');
});
