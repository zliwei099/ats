# ATS MVP

一个仅监听回环地址的 TypeScript / Fastify / SQLite 服务，提供项目与任务、计划审批、单执行者执行、审计事件和验收状态机。

## 运行

```sh
npm ci
npm run dev
```

服务仅绑定 `127.0.0.1:3000`，可用 `ATS_DB=./local.sqlite PORT=3100 npm run start` 覆盖本地数据库路径和端口。服务不读取或管理 Provider 凭据；`src/provider.ts` 定义最小 `ProviderAdapter` 契约。

## API 闭环

```sh
project=$(curl -sS -X POST http://127.0.0.1:3000/projects -H 'content-type: application/json' -d '{"name":"demo"}')
project_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$project")
task=$(curl -sS -X POST http://127.0.0.1:3000/projects/$project_id/tasks -H 'content-type: application/json' -d '{"title":"ship"}')
task_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$task")
plan=$(curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/plans -H 'content-type: application/json' -d '{"body":"approved work"}')
plan_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$plan")
curl -sS -X POST http://127.0.0.1:3000/plans/$plan_id/submit -H 'content-type: application/json' -d '{}'
curl -sS -X POST http://127.0.0.1:3000/plans/$plan_id/approve -H 'content-type: application/json' -d '{"actor":"reviewer"}'
execution=$(curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/executions -H 'content-type: application/json' -d '{"provider":"noop"}')
execution_id=$(node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).id))' <<< "$execution")
curl -sS -X POST http://127.0.0.1:3000/executions/$execution_id/finish -H 'content-type: application/json' -d '{}'
curl -sS http://127.0.0.1:3000/audit/$task_id
curl -sS -X POST http://127.0.0.1:3000/tasks/$task_id/accept -H 'content-type: application/json' -d '{"actor":"reviewer"}'
curl -sS http://127.0.0.1:3000/tasks/$task_id/evidence
curl -sS http://127.0.0.1:3000/tasks/$task_id
```

最后一个响应的 `status` 应为 `accepted`。SQLite schema 会在服务首次启动时自动创建；如果 `ATS_DB` 指向不存在的父目录，服务也会自动创建该目录。

## 任务证据包查询

`GET /tasks/:taskId/evidence` 是给 loopback 控制台与独立复核使用的稳定证据视图。它只读取已有持久化记录，不会改写审计事件；响应包含 `task`、已关联的 `plan`、按 `created_at, id` 排序的 `executions`，以及按不可变写入 `sequence` 排序的 `audit_events`。`status_transitions` 和最终 `acceptance` 均由这些审计事件派生。计划的 `decided_by` 是审批人，执行条目的 `started_by` / `finished_by` 是执行者，`acceptance.actor` 是验收人（尚未验收时为 `null`）。

验证：`npm test`、`npm run typecheck`。

## 本地浏览器控制台

启动服务并按上面的 API 闭环创建一个已验收任务后，在浏览器打开 `http://127.0.0.1:3000/console`。下拉框只列出已验收任务；选择任务即可读取既有 `GET /tasks/:taskId/evidence` 证据包，按稳定顺序展示计划决策人、执行责任人、状态迁移、验收人和审计记录。也可以使用 `http://127.0.0.1:3000/console?taskId=<任务ID>` 直接打开某个已验收任务。

该控制台仅调用 `GET /tasks?status=accepted` 和 `GET /tasks/:taskId/evidence`，不提供任何写入操作，服务仍只监听 `127.0.0.1`。
