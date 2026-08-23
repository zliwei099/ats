# ATS MVP

一个仅监听回环地址的 TypeScript / Fastify / SQLite 服务，提供项目与任务、计划审批、单执行者执行、审计事件和验收状态机。

## 运行

```sh
npm install
npm run dev
```

服务仅绑定 `127.0.0.1:3000`，可用 `ATS_DB=./local.sqlite PORT=3100 npm run start` 覆盖本地数据库路径和端口。服务不读取或管理 Provider 凭据；`src/provider.ts` 定义最小 `ProviderAdapter` 契约。

## 浏览器控制台

启动后访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。控制台不会绑定 `0.0.0.0`，因此默认不可从局域网或公网访问。

最小验收 walkthrough：创建项目 → 在项目下创建任务 → 填写并“生成计划” → “提交计划” → “批准计划” → “开始执行” → “完成执行” → “验收通过”。右侧会持续显示任务/计划/执行状态及审计记录。若在批准前开始执行或触发不允许的状态操作，界面会保留后端的可理解错误提示，且不会绕过状态机。

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
curl -sS http://127.0.0.1:3000/tasks/$task_id
```

最后一个响应的 `status` 应为 `accepted`。SQLite schema 会在服务首次启动时自动创建；如果 `ATS_DB` 指向不存在的父目录，服务也会自动创建该目录。

验证：`npm test`、`npm run typecheck`。
