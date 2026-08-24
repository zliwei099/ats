import Fastify from 'fastify';
import { consoleHtml, consoleScript } from './console.js';
import { DecisionSource, DomainError, FailureCategory, Store } from './store.js';

export function buildServer(store = new Store()) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' || error.code === 'EXECUTION_ACTIVE' ? 409 : 422).send({ error: error.code, message: error.message });
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/console', async (_request, reply) => reply.type('text/html; charset=utf-8').send(consoleHtml));
  app.get('/console.js', async (_request, reply) => reply.type('application/javascript; charset=utf-8').send(consoleScript));
  app.post<{ Body: { name: string; actor?: string } }>('/projects', async (request, reply) => reply.code(201).send(store.createProject(request.body.name, request.body.actor)));
  app.post<{ Params: { projectId: string }; Body: { content: string; source: DecisionSource; scope: string; actor?: string } }>('/projects/:projectId/decision-memories', async (request, reply) => reply.code(201).send(store.createDecisionMemory(request.params.projectId, request.body.content, request.body.source, request.body.scope, request.body.actor)));
  app.get<{ Params: { projectId: string }; Querystring: { status?: 'active' | 'superseded' | 'all' } }>('/projects/:projectId/decision-memories', async request => {
    const status = request.query.status ?? 'active';
    if (!['active', 'superseded', 'all'].includes(status)) throw new DomainError('decision status filter is invalid', 'INVALID_DECISION');
    return store.decisionMemories(request.params.projectId, status);
  });
  app.post<{ Params: { decisionId: string }; Body: { replacementDecisionId: string; actor?: string } }>('/decision-memories/:decisionId/supersede', async request => store.supersedeDecisionMemory(request.params.decisionId, request.body.replacementDecisionId, request.body.actor));
  app.post<{ Params: { projectId: string }; Body: { title: string; actor?: string; dueAt?: string } }>('/projects/:projectId/tasks', async (request, reply) => reply.code(201).send(store.createTask(request.params.projectId, request.body.title, request.body.actor, request.body.dueAt)));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId', async request => store.task(request.params.taskId));
  app.get<{ Querystring: { status?: 'accepted' } }>('/tasks', async request => store.tasks(request.query.status));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/risk', async request => ({ risk: store.taskRisk(request.params.taskId) }));
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/risks', async request => store.projectRisks(request.params.projectId));
  app.get<{ Params: { projectId: string } }>('/projects/:projectId/queue', async request => store.projectQueue(request.params.projectId));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/evidence', async request => store.evidencePackage(request.params.taskId));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/plans', async request => store.planHistory(request.params.taskId));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/dependencies', async request => store.dependencies(request.params.taskId));
  app.get<{ Params: { taskId: string } }>('/tasks/:taskId/dependency-status', async request => store.dependencyView(request.params.taskId));
  app.post<{ Params: { taskId: string }; Body: { fromOwner: string; toOwner: string; reason: string; actor?: string } }>('/tasks/:taskId/handoffs', async request => store.handoffTask(request.params.taskId, request.body.fromOwner, request.body.toOwner, request.body.reason, request.body.actor));
  app.post<{ Params: { taskId: string }; Body: { dependsOnTaskId: string; actor?: string } }>('/tasks/:taskId/dependencies', async (request, reply) => reply.code(201).send(store.addDependency(request.params.taskId, request.body.dependsOnTaskId, request.body.actor)));
  app.post<{ Params: { taskId: string }; Body: { body: string; actor?: string } }>('/tasks/:taskId/plans', async (request, reply) => reply.code(201).send(store.createPlan(request.params.taskId, request.body.body, request.body.actor)));
  app.post<{ Params: { planId: string }; Body: { actor?: string } }>('/plans/:planId/submit', async request => store.submitPlan(request.params.planId, request.body.actor));
  app.post<{ Params: { planId: string }; Body: { actor: string } }>('/plans/:planId/approve', async request => store.decidePlan(request.params.planId, true, request.body.actor));
  app.post<{ Params: { planId: string }; Body: { actor: string; reason?: string } }>('/plans/:planId/reject', async request => store.decidePlan(request.params.planId, false, request.body.actor, request.body.reason));
  app.post<{ Params: { taskId: string }; Body: { provider: string; actor?: string } }>('/tasks/:taskId/executions', async (request, reply) => reply.code(201).send(store.startExecution(request.params.taskId, request.body.provider, request.body.actor)));
  app.post<{ Params: { executionId: string }; Body: { actor?: string } }>('/executions/:executionId/finish', async request => store.finishExecution(request.params.executionId, request.body.actor));
  app.post<{ Params: { executionId: string }; Body: { category: FailureCategory; reason: string; actor?: string } }>('/executions/:executionId/fail', async request => store.failExecution(request.params.executionId, request.body.category, request.body.reason, request.body.actor));
  app.post<{ Params: { executionId: string }; Body: { actor?: string } }>('/executions/:executionId/retry', async (request, reply) => reply.code(201).send(store.retryExecution(request.params.executionId, request.body.actor)));
  app.post<{ Params: { taskId: string }; Body: { actor?: string } }>('/tasks/:taskId/accept', async request => store.transitionTask(request.params.taskId, 'accepted', request.body.actor));
  app.post<{ Params: { taskId: string }; Body: { actor?: string } }>('/tasks/:taskId/reject', async request => store.transitionTask(request.params.taskId, 'rejected', request.body.actor));
  app.get<{ Params: { entityId: string } }>('/audit/:entityId', async request => store.auditEvents(request.params.entityId));
  return app;
}
