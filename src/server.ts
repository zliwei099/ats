import Fastify from 'fastify';
import { DomainError, Store } from './store.js';

export function buildServer(store = new Store()) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' || error.code === 'EXECUTION_ACTIVE' ? 409 : 422).send({ error: error.code, message: error.message });
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  app.get('/health', async () => ({ ok: true }));
  app.post<{ Body: { name: string; actor?: string } }>('/projects', async (request, reply) => reply.code(201).send(store.createProject(request.body.name, request.body.actor)));
  app.post<{ Params: { projectId: string }; Body: { title: string; actor?: string } }>('/projects/:projectId/tasks', async (request, reply) => reply.code(201).send(store.createTask(request.params.projectId, request.body.title, request.body.actor)));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId', async request => store.task(request.params.taskId));
  app.post<{ Params: { taskId: string }; Body: { body: string; actor?: string } }>('/tasks/:taskId/plans', async (request, reply) => reply.code(201).send(store.createPlan(request.params.taskId, request.body.body, request.body.actor)));
  app.post<{ Params: { planId: string }; Body: { actor?: string } }>('/plans/:planId/submit', async request => store.submitPlan(request.params.planId, request.body.actor));
  app.post<{ Params: { planId: string }; Body: { actor: string } }>('/plans/:planId/approve', async request => store.decidePlan(request.params.planId, true, request.body.actor));
  app.post<{ Params: { planId: string }; Body: { actor: string } }>('/plans/:planId/reject', async request => store.decidePlan(request.params.planId, false, request.body.actor));
  app.post<{ Params: { taskId: string }; Body: { provider: string; actor?: string } }>('/tasks/:taskId/executions', async (request, reply) => reply.code(201).send(store.startExecution(request.params.taskId, request.body.provider, request.body.actor)));
  app.post<{ Params: { executionId: string }; Body: { actor?: string } }>('/executions/:executionId/finish', async request => store.finishExecution(request.params.executionId, request.body.actor));
  app.get<{ Params: { entityId: string } }>('/audit/:entityId', async request => store.auditEvents(request.params.entityId));
  return app;
}
