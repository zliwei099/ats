/** A provider is deliberately capability-based: adapters never receive credentials from this app. */
export type ExecutionRequest = { taskId: string; executionId: string; input: unknown };
export type ProviderResult = { output: unknown; externalRunId?: string };

export interface ProviderAdapter {
  readonly name: string;
  execute(request: ExecutionRequest): Promise<ProviderResult>;
  cancel?(externalRunId: string): Promise<void>;
}

export class NoopProvider implements ProviderAdapter {
  readonly name = 'noop';
  async execute(request: ExecutionRequest): Promise<ProviderResult> {
    return { output: { accepted: true, taskId: request.taskId } };
  }
}
