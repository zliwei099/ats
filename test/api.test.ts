import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

test('HTTP API completes the documented approval and execution loop', async () => {
  const app = buildServer(new Store());
  const json = async (url: string, body?: object) => {
    const response = await app.inject({ method: body === undefined ? 'GET' : 'POST', url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return JSON.parse(response.body) as Record<string, string>;
  };
  const project = await json('/projects', { name: 'demo' });
  const task = await json(`/projects/${project.id}/tasks`, { title: 'ship' });
  const plan = await json(`/tasks/${task.id}/plans`, { body: 'approved work' });
  await json(`/plans/${plan.id}/submit`, {});
  await json(`/plans/${plan.id}/approve`, { actor: 'reviewer' });
  const execution = await json(`/tasks/${task.id}/executions`, { provider: 'noop' });
  await json(`/executions/${execution.id}/finish`, {});
  await json(`/tasks/${task.id}/accept`, { actor: 'reviewer' });
  assert.equal((await json(`/tasks/${task.id}`)).status, 'accepted');
  const events = await json(`/audit/${task.id}`);
  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 4);
  await app.close();
});

test('HTTP failure and retry loop preserves evidence and enforces existing gates', async () => {
  const store = new Store(); const app = buildServer(store);
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { response, body: JSON.parse(response.body) as Record<string, any> };
  };
  const project = (await request('POST', '/projects', { name: 'retry' })).body;
  const task = (await request('POST', `/projects/${project.id}/tasks`, { title: 'recoverable task' })).body;
  const plan = (await request('POST', `/tasks/${task.id}/plans`, { body: 'approved work' })).body;
  await request('POST', `/plans/${plan.id}/submit`, {}); await request('POST', `/plans/${plan.id}/approve`, { actor: 'reviewer' });
  const first = (await request('POST', `/tasks/${task.id}/executions`, { provider: 'noop', actor: 'executor' })).body;
  const failed = await request('POST', `/executions/${first.id}/fail`, { category: 'timeout', reason: 'loopback timeout', actor: 'executor' });
  assert.equal(failed.response.statusCode, 200); assert.equal(failed.body.status, 'failed');
  store.db.prepare("UPDATE plans SET status='submitted' WHERE id=?").run(plan.id);
  const unapproved = await request('POST', `/executions/${first.id}/retry`, { actor: 'operator' });
  assert.equal(unapproved.response.statusCode, 422); assert.equal(unapproved.body.error, 'PLAN_NOT_APPROVED');
  store.db.prepare("UPDATE plans SET status='approved' WHERE id=?").run(plan.id);

  const prerequisite = (await request('POST', `/projects/${project.id}/tasks`, { title: 'prerequisite' })).body;
  const prerequisitePlan = (await request('POST', `/tasks/${prerequisite.id}/plans`, { body: 'approved prerequisite' })).body;
  await request('POST', `/plans/${prerequisitePlan.id}/submit`, {}); await request('POST', `/plans/${prerequisitePlan.id}/approve`, { actor: 'reviewer' });
  await request('POST', `/tasks/${task.id}/dependencies`, { dependsOnTaskId: prerequisite.id });
  const dependencyBlocked = await request('POST', `/executions/${first.id}/retry`, { actor: 'operator' });
  assert.equal(dependencyBlocked.response.statusCode, 422); assert.equal(dependencyBlocked.body.error, 'DEPENDENCIES_UNMET');
  const prerequisiteExecution = (await request('POST', `/tasks/${prerequisite.id}/executions`, { provider: 'noop' })).body;
  await request('POST', `/executions/${prerequisiteExecution.id}/finish`, {}); await request('POST', `/tasks/${prerequisite.id}/accept`, { actor: 'reviewer' });
  const retry = await request('POST', `/executions/${first.id}/retry`, { actor: 'operator' });
  assert.equal(retry.response.statusCode, 201); assert.equal(retry.body.retry_of_execution_id, first.id);
  const duplicate = await request('POST', `/executions/${first.id}/retry`, { actor: 'operator' });
  assert.equal(duplicate.response.statusCode, 422); assert.equal(duplicate.body.error, 'INVALID_STATE');
  const evidence = await request('GET', `/tasks/${task.id}/evidence`);
  const repeated = await request('GET', `/tasks/${task.id}/evidence`);
  assert.deepEqual(repeated.body, evidence.body);
  assert.deepEqual(evidence.body.executions.map((execution: Record<string, string>) => execution.id), [first.id, retry.body.id]);
  assert.equal(evidence.body.executions[0].failure_category, 'timeout'); assert.equal(evidence.body.executions[0].failure_reason, 'loopback timeout');
  assert.ok(evidence.body.audit_events.some((event: Record<string, any>) => event.action === 'execution_retried' && event.detail.originalExecutionId === first.id && event.detail.retryExecutionId === retry.body.id));
  await app.close();
});

test('task evidence package joins approval, execution, transitions, and acceptance in a stable order', async () => {
  const app = buildServer(new Store());
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    assert.ok(response.statusCode < 300, response.body);
    return JSON.parse(response.body) as Record<string, any>;
  };
  const project = await request('POST', '/projects', { name: 'evidence' });
  const task = await request('POST', `/projects/${project.id}/tasks`, { title: 'ship', actor: 'planner' });
  const plan = await request('POST', `/tasks/${task.id}/plans`, { body: 'reviewed plan', actor: 'planner' });
  await request('POST', `/plans/${plan.id}/submit`, { actor: 'planner' });
  await request('POST', `/plans/${plan.id}/approve`, { actor: 'approver' });
  const execution = await request('POST', `/tasks/${task.id}/executions`, { provider: 'noop', actor: 'executor' });
  await request('POST', `/executions/${execution.id}/finish`, { actor: 'executor' });
  await request('POST', `/tasks/${task.id}/accept`, { actor: 'acceptor' });

  const evidence = await request('GET', `/tasks/${task.id}/evidence`);
  const repeated = await request('GET', `/tasks/${task.id}/evidence`);
  assert.deepEqual(repeated, evidence);
  assert.equal(evidence.task.id, task.id);
  assert.equal(evidence.plan.id, plan.id);
  assert.equal(evidence.plan.decided_by, 'approver');
  assert.equal(evidence.executions[0].id, execution.id);
  assert.equal(evidence.executions[0].started_by, 'planner');
  assert.equal(evidence.executions[0].finished_by, 'executor');
  assert.deepEqual(evidence.status_transitions.map((transition: Record<string, string>) => transition.to), ['ready', 'executing', 'awaiting_acceptance', 'accepted']);
  assert.equal(evidence.acceptance.actor, 'acceptor');
  assert.ok(evidence.audit_events.every((event: Record<string, string>) => [task.id, plan.id, execution.id].includes(event.entity_id)));
  await app.close();
});

test('handoff HTTP API preserves responsibility history and rejects invalid or active handoffs', async () => {
  const app = buildServer(new Store());
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { response, body: JSON.parse(response.body) as Record<string, any> };
  };
  const project = (await request('POST', '/projects', { name: 'handoff' })).body;
  const task = (await request('POST', `/projects/${project.id}/tasks`, { title: 'ship', actor: 'alice' })).body;
  const invalid = await request('POST', `/tasks/${task.id}/handoffs`, { fromOwner: 'alice', toOwner: 'alice', reason: 'same' });
  assert.equal(invalid.response.statusCode, 422); assert.equal(invalid.body.error, 'INVALID_HANDOFF');
  const missing = await request('POST', '/tasks/missing/handoffs', { fromOwner: 'alice', toOwner: 'bob', reason: 'missing' });
  assert.equal(missing.response.statusCode, 404); assert.equal(missing.body.error, 'NOT_FOUND');
  const handoff = await request('POST', `/tasks/${task.id}/handoffs`, { fromOwner: 'alice', toOwner: 'bob', reason: 'review complete', actor: 'coordinator' });
  assert.equal(handoff.response.statusCode, 200); assert.equal(handoff.body.owner, 'bob');
  const plan = (await request('POST', `/tasks/${task.id}/plans`, { body: 'approved' })).body;
  await request('POST', `/plans/${plan.id}/submit`, {}); await request('POST', `/plans/${plan.id}/approve`, { actor: 'reviewer' });
  const execution = await request('POST', `/tasks/${task.id}/executions`, { provider: 'noop', actor: 'alice' });
  assert.equal(execution.response.statusCode, 201);
  const active = await request('POST', `/tasks/${task.id}/handoffs`, { fromOwner: 'bob', toOwner: 'carol', reason: 'must reject' });
  assert.equal(active.response.statusCode, 409); assert.equal(active.body.error, 'EXECUTION_ACTIVE');
  const evidence = await request('GET', `/tasks/${task.id}/evidence`);
  assert.deepEqual(evidence.body.responsibility_chain.map((item: Record<string, string | null>) => [item.from_owner, item.to_owner, item.reason]), [[null, 'alice', null], ['alice', 'bob', 'review complete']]);
  assert.equal(evidence.body.executions[0].started_by, 'bob');
  const script = await app.inject({ method: 'GET', url: '/console.js' });
  assert.match(script.body, /负责人责任链/); assert.doesNotMatch(script.body, /handoffs.*POST/);
  await app.close();
});

test('dependency API blocks execution until the prerequisite is accepted and exposes stable evidence', async () => {
  const app = buildServer(new Store());
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { response, body: JSON.parse(response.body) as Record<string, any> };
  };
  const project = (await request('POST', '/projects', { name: 'dependencies' })).body;
  const prerequisite = (await request('POST', `/projects/${project.id}/tasks`, { title: 'first' })).body;
  const dependent = (await request('POST', `/projects/${project.id}/tasks`, { title: 'second' })).body;
  for (const task of [prerequisite, dependent]) {
    const plan = (await request('POST', `/tasks/${task.id}/plans`, { body: 'approved' })).body;
    await request('POST', `/plans/${plan.id}/submit`, {}); await request('POST', `/plans/${plan.id}/approve`, { actor: 'reviewer' });
  }
  const dependency = await request('POST', `/tasks/${dependent.id}/dependencies`, { dependsOnTaskId: prerequisite.id, actor: 'planner' });
  assert.equal(dependency.response.statusCode, 201);
  const blocked = await request('POST', `/tasks/${dependent.id}/executions`, { provider: 'noop' });
  assert.equal(blocked.response.statusCode, 422); assert.equal(blocked.body.error, 'DEPENDENCIES_UNMET');
  const prerequisiteExecution = (await request('POST', `/tasks/${prerequisite.id}/executions`, { provider: 'noop' })).body;
  await request('POST', `/executions/${prerequisiteExecution.id}/finish`, {}); await request('POST', `/tasks/${prerequisite.id}/accept`, { actor: 'reviewer' });
  const list = await request('GET', `/tasks/${dependent.id}/dependencies`);
  assert.equal(list.body[0].satisfied, 1); assert.equal(list.body[0].depends_on_task_id, prerequisite.id);
  const evidence = await request('GET', `/tasks/${dependent.id}/evidence`);
  assert.deepEqual(evidence.body.dependencies, list.body);
  assert.equal(evidence.body.blocked_dependents.length, 0);
  assert.ok(evidence.body.audit_events.some((event: Record<string, string>) => event.action === 'dependency_created'));
  assert.ok(evidence.body.audit_events.some((event: Record<string, string>) => event.action === 'dependency_resolved'));
  const prerequisiteEvidence = await request('GET', `/tasks/${prerequisite.id}/evidence`);
  const blockedDependent = prerequisiteEvidence.body.blocked_dependents[0];
  assert.equal(prerequisiteEvidence.body.task.status, 'accepted');
  assert.equal(blockedDependent.task_id, dependent.id);
  assert.equal(blockedDependent.task_status, 'ready');
  assert.equal(blockedDependent.satisfied, 1);
  assert.ok(blockedDependent.resolved_at);
  assert.ok(prerequisiteEvidence.body.audit_events.some((event: Record<string, string>) => event.action === 'dependency_created'));
  assert.ok(prerequisiteEvidence.body.audit_events.some((event: Record<string, string>) => event.action === 'dependency_resolved'));
  const execution = await request('POST', `/tasks/${dependent.id}/executions`, { provider: 'noop' });
  assert.equal(execution.response.statusCode, 201);
  await app.close();
});

test('dependency API rejects self references and cycles', async () => {
  const app = buildServer(new Store());
  const request = async (url: string, body: object) => app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const project = JSON.parse((await request('/projects', { name: 'cycles' })).body) as Record<string, string>;
  const create = async (title: string) => JSON.parse((await request(`/projects/${project.id}/tasks`, { title })).body) as Record<string, string>;
  const first = await create('first'); const second = await create('second');
  assert.equal((await request(`/tasks/${first.id}/dependencies`, { dependsOnTaskId: first.id })).statusCode, 422);
  assert.equal((await request(`/tasks/${first.id}/dependencies`, { dependsOnTaskId: second.id })).statusCode, 201);
  const cycle = await request(`/tasks/${second.id}/dependencies`, { dependsOnTaskId: first.id });
  assert.equal(cycle.statusCode, 422); assert.equal(JSON.parse(cycle.body).error, 'INVALID_DEPENDENCY');
  await app.close();
});

test('dependency-status API is read-only, stable, and explains a multi-prerequisite release', async () => {
  const app = buildServer(new Store());
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { response, body: JSON.parse(response.body) as Record<string, any> };
  };
  const project = (await request('POST', '/projects', { name: 'dependency status' })).body;
  const createApproved = async (title: string) => { const task = (await request('POST', `/projects/${project.id}/tasks`, { title })).body; const plan = (await request('POST', `/tasks/${task.id}/plans`, { body: 'approved' })).body; await request('POST', `/plans/${plan.id}/submit`, {}); await request('POST', `/plans/${plan.id}/approve`, { actor: 'reviewer' }); return task; };
  const [first, second, dependent] = await Promise.all(['first', 'second', 'dependent'].map(createApproved));
  await request('POST', `/tasks/${dependent.id}/dependencies`, { dependsOnTaskId: first.id });
  await request('POST', `/tasks/${dependent.id}/dependencies`, { dependsOnTaskId: second.id });
  const view = await request('GET', `/tasks/${dependent.id}/dependency-status`); const repeated = await request('GET', `/tasks/${dependent.id}/dependency-status`);
  assert.equal(view.response.statusCode, 200); assert.deepEqual(repeated.body, view.body); assert.equal(view.body.can_start, false);
  assert.deepEqual(view.body.prerequisites.map((item: Record<string, string>) => item.depends_on_task_id), (await request('GET', `/tasks/${dependent.id}/dependencies`)).body.map((item: Record<string, string>) => item.depends_on_task_id));
  assert.equal(view.body.blocking_reasons.filter((reason: Record<string, string>) => reason.code === 'PREREQUISITE_INCOMPLETE').length, 2);
  for (const task of [first, second]) { const execution = (await request('POST', `/tasks/${task.id}/executions`, { provider: 'noop' })).body; await request('POST', `/executions/${execution.id}/finish`, {}); await request('POST', `/tasks/${task.id}/accept`, { actor: 'reviewer' }); }
  const released = await request('GET', `/tasks/${dependent.id}/dependency-status`);
  assert.equal(released.body.can_start, true); assert.deepEqual(released.body.blocking_reasons, []);
  const missing = await request('GET', '/tasks/missing/dependency-status');
  assert.equal(missing.response.statusCode, 404); assert.equal(missing.body.error, 'NOT_FOUND');
  const script = await app.inject({ method: 'GET', url: '/console.js' });
  assert.match(script.body, /依赖状态与下一步条件/); assert.match(script.body, /dependency-status/); assert.doesNotMatch(script.body, /dependency-status.*POST/);
  await app.close();
});

test('loopback console lists tasks and reads their existing evidence package', async () => {
  const app = buildServer(new Store());
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    assert.ok(response.statusCode < 300, response.body);
    return { response, body: JSON.parse(response.body) as Record<string, any> };
  };
  const project = (await request('POST', '/projects', { name: 'console' })).body;
  const task = (await request('POST', `/projects/${project.id}/tasks`, { title: 'visible task' })).body;
  const plan = (await request('POST', `/tasks/${task.id}/plans`, { body: 'read only' })).body;
  await request('POST', `/plans/${plan.id}/submit`, {});
  await request('POST', `/plans/${plan.id}/approve`, { actor: 'approver' });
  const execution = (await request('POST', `/tasks/${task.id}/executions`, { provider: 'noop', actor: 'executor' })).body;
  await request('POST', `/executions/${execution.id}/finish`, { actor: 'executor' });
  await request('POST', `/tasks/${task.id}/accept`, { actor: 'acceptor' });

  const tasks = await request('GET', '/tasks');
  assert.deepEqual(tasks.body.map((item: Record<string, string>) => item.id), [task.id]);
  const page = await app.inject({ method: 'GET', url: '/console' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  assert.match(page.body, /任务证据包/);
  const script = await app.inject({ method: 'GET', url: '/console.js' });
  assert.equal(script.statusCode, 200);
  assert.match(script.body, /fetch\('\/tasks'\)/);
  assert.match(script.body, /\/evidence/);
  assert.doesNotMatch(script.body, /fetch\(['"]\/(?:projects|plans|executions)/);
  await app.close();
});

test('project decision memories retain sources, stable history, and supersession without weakening workflow gates', async () => {
  const app = buildServer(new Store());
  const request = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const response = await app.inject({ method, url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { response, body: JSON.parse(response.body) as Record<string, any> };
  };
  const project = (await request('POST', '/projects', { name: 'memory' })).body;
  const otherProject = (await request('POST', '/projects', { name: 'other' })).body;
  const first = await request('POST', `/projects/${project.id}/decision-memories`, {
    content: 'Use SQLite for the local MVP', source: { type: 'url', reference: 'https://example.test/adr/1' }, scope: 'local MVP', actor: 'architect'
  });
  const second = await request('POST', `/projects/${project.id}/decision-memories`, {
    content: 'Use SQLite WAL for concurrent local readers', source: { type: 'task', reference: 'ATS-28' }, scope: 'persistence', actor: 'architect'
  });
  assert.equal(first.response.statusCode, 201); assert.equal(second.response.statusCode, 201);
  const activeBefore = await request('GET', `/projects/${project.id}/decision-memories`);
  assert.deepEqual(activeBefore.body.map((memory: Record<string, string>) => memory.id), [first.body.id, second.body.id]);
  assert.equal(activeBefore.body[0].source_type, 'url'); assert.equal(activeBefore.body[1].source_reference, 'ATS-28');
  const superseded = await request('POST', `/decision-memories/${first.body.id}/supersede`, { replacementDecisionId: second.body.id, actor: 'reviewer' });
  assert.equal(superseded.response.statusCode, 200); assert.equal(superseded.body.status, 'superseded'); assert.equal(superseded.body.superseded_by, second.body.id);
  const active = await request('GET', `/projects/${project.id}/decision-memories`);
  assert.deepEqual(active.body.map((memory: Record<string, string>) => memory.id), [second.body.id]);
  const history = await request('GET', `/projects/${project.id}/decision-memories?status=all`);
  assert.deepEqual(history.body.map((memory: Record<string, string>) => memory.id), [first.body.id, second.body.id]);
  assert.equal(history.body[0].superseded_by_content, second.body.content);
  const wrongProject = await request('POST', `/projects/${otherProject.id}/decision-memories`, {
    content: 'Other decision', source: { type: 'audit', reference: 'audit:event-1' }, scope: 'other'
  });
  const invalidReplacement = await request('POST', `/decision-memories/${second.body.id}/supersede`, { replacementDecisionId: wrongProject.body.id });
  assert.equal(invalidReplacement.response.statusCode, 422); assert.equal(invalidReplacement.body.error, 'INVALID_SUPERSESSION');
  const missingProject = await request('GET', '/projects/missing/decision-memories');
  assert.equal(missingProject.response.statusCode, 404);
  const invalidSource = await request('POST', `/projects/${project.id}/decision-memories`, { content: 'bad', source: { type: 'url', reference: 'not a URL' }, scope: 'test' });
  assert.equal(invalidSource.response.statusCode, 422); assert.equal(invalidSource.body.error, 'INVALID_DECISION_SOURCE');

  const task = (await request('POST', `/projects/${project.id}/tasks`, { title: 'workflow remains gated' })).body;
  const blockedExecution = await request('POST', `/tasks/${task.id}/executions`, { provider: 'noop' });
  assert.equal(blockedExecution.response.statusCode, 422); assert.equal(blockedExecution.body.error, 'PLAN_NOT_APPROVED');
  const evidence = await request('GET', `/tasks/${task.id}/evidence`);
  assert.deepEqual(evidence.body.decision_memories.map((memory: Record<string, string>) => memory.id), [first.body.id, second.body.id]);
  const script = await app.inject({ method: 'GET', url: '/console.js' });
  assert.match(script.body, /项目决策记忆/);
  assert.doesNotMatch(script.body, /decision-memories.*POST/);
  await app.close();
});
