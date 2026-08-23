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
