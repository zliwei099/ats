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
  assert.equal(evidence.executions[0].started_by, 'executor');
  assert.equal(evidence.executions[0].finished_by, 'executor');
  assert.deepEqual(evidence.status_transitions.map((transition: Record<string, string>) => transition.to), ['ready', 'executing', 'awaiting_acceptance', 'accepted']);
  assert.equal(evidence.acceptance.actor, 'acceptor');
  assert.ok(evidence.audit_events.every((event: Record<string, string>) => [task.id, plan.id, execution.id].includes(event.entity_id)));
  await app.close();
});

test('loopback console lists accepted tasks and reads their existing evidence package', async () => {
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

  const accepted = await request('GET', '/tasks?status=accepted');
  assert.deepEqual(accepted.body.map((item: Record<string, string>) => item.id), [task.id]);
  const page = await app.inject({ method: 'GET', url: '/console' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  assert.match(page.body, /任务证据包/);
  const script = await app.inject({ method: 'GET', url: '/console.js' });
  assert.equal(script.statusCode, 200);
  assert.match(script.body, /\/tasks\?status=accepted/);
  assert.match(script.body, /\/evidence/);
  assert.doesNotMatch(script.body, /fetch\(['"]\/(?:projects|plans|executions)/);
  await app.close();
});
