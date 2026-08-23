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

test('console exposes project/task views and preserves execution approval constraint', async () => {
  const app = buildServer(new Store());
  const projectResponse = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'console demo' } });
  const project = JSON.parse(projectResponse.body) as Record<string, string>;
  const taskResponse = await app.inject({ method: 'POST', url: `/projects/${project.id}/tasks`, payload: { title: 'review in browser' } });
  const task = JSON.parse(taskResponse.body) as Record<string, string>;

  const html = await app.inject({ method: 'GET', url: '/' });
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /ATS MVP 控制台/);
  const projects = await app.inject({ method: 'GET', url: '/projects' });
  assert.equal(JSON.parse(projects.body)[0].name, 'console demo');
  const tasks = await app.inject({ method: 'GET', url: `/projects/${project.id}/tasks` });
  assert.equal(JSON.parse(tasks.body)[0].id, task.id);
  const blocked = await app.inject({ method: 'POST', url: `/tasks/${task.id}/executions`, payload: { provider: 'noop' } });
  assert.equal(blocked.statusCode, 422);
  assert.match(blocked.body, /approved plan/);
  const detail = await app.inject({ method: 'GET', url: `/tasks/${task.id}/console` });
  assert.equal(JSON.parse(detail.body).task.status, 'planned');
  await app.close();
});
