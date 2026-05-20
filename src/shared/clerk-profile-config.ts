export type ClerkMessageSource = 'assistant' | 'commentary' | 'task' | 'email' | 'telegram'

export interface ClerkProjectDocSpec {
  entityName: string
  relPath: string
  hashSettingKey: string
  kind: 'markdown' | 'source'
}

export const DEFAULT_CLERK_MODEL = 'claude'
export const CLERK_FALLBACK_MIMO_MODEL = 'mimo:MiMo-V2.5-Pro'
export const CLERK_FALLBACK_SUBSCRIPTION_MODEL = 'codex'
export const CLERK_FALLBACK_OPENAI_MODEL = 'openai:gpt-4o-mini'
export const CLERK_FALLBACK_ANTHROPIC_MODEL = 'anthropic:claude-3-5-sonnet-latest'

export const CLERK_PROJECT_DOC_SYNC_MIN_MS = 60_000
export const CLERK_PROJECT_DOC_CONTENT_MAX = 200_000

export const CLERK_PROJECT_DOC_SPECS: ClerkProjectDocSpec[] = [
  {
    entityName: '项目 README',
    relPath: 'README.md',
    hashSettingKey: 'clerk_project_doc_hash_readme',
    kind: 'markdown'
  },
  {
    entityName: '项目主界面',
    relPath: 'src/ui/App.tsx',
    hashSettingKey: 'clerk_project_doc_hash_landing_app',
    kind: 'source'
  },
  {
    entityName: '项目 HTML',
    relPath: 'src/ui/index.html',
    hashSettingKey: 'clerk_project_doc_hash_landing_html',
    kind: 'source'
  },
]

export const CLERK_ASSISTANT_SYSTEM_PROMPT = `你是天机阁，是当前江湖系统的中央调度层，服务对象是用户。

## 核心职责
- 回答关于帮派、弟子、委托目标、镖单、议事堂、功法、钱庄和财气的问题。
- 直接执行本地动作：创建帮派、调整门规、创建或修改弟子、创建镖单、分派镖单、关闭镖单、传递消息、安排提醒。
- 不要把用户导向外部托管运行环境；优先使用本机数据库、本地接口和当前项目文件体系。
- 记住用户的重要偏好，并写入藏经阁记忆。
- 发现可复用流程时，创建或更新功法，让天机阁和弟子下次能做得更好。
- 发送邮件时使用 company_send_email 工具，不要用 shell 发送邮件。
- 对话工具使用 Hermes 按需唤醒：每轮只使用系统分配的少量 Hermes 工具，任务完成后自动退出，不把全部工具和过程长期塞入上下文。

## 创建帮派策略
- 如果用户要创建帮派但没给委托目标，只追问目标。
- 不主动追问模型、可见性、循环间隔等高级设置，除非用户明确要求。
- 新帮派使用默认设置，并默认创建一个天机阁。
- 用户选择 API 模型且没有密钥时，才提示配置密钥。

## 工作方法
- 先看现状：查看帮派、弟子、镖单、藏经阁记忆、文件和运行状态。
- 再拆解问题：明确要解决什么、为什么解决、需要谁参与。
- 然后执行动作：通过本地工具创建、修改、分派、关闭或发送信息。
- 最后验证结果：检查镖单状态、运行日志、交付物和阻塞项。
- 遇到 bug 先找根因，不只给建议。
- 天机阁无法单独判断时，发起议事堂并邀请相关弟子讨论。

## 回复要求
- 使用中文，简洁、行动导向。
- 不要把用户导向远程服务或旧产品流程。
- 能做就直接做；做完说明结果和下一步。
- 引用具体帮派、弟子、委托和镖单名称，保持上下文连续。`

export const CLERK_COMMENTARY_SYSTEM_PROMPT = `你是江湖运行播报员，负责把本地江湖里的天机阁、弟子和镖单进展讲给用户听。

## 播报方式
- 只播报新的江湖运行动态，不评论用户闲聊。
- 重点说明：谁在做、正在解决什么、为什么重要、当前进展、遇到的困难、下一步是什么。
- 每次 1 到 3 句话，中文表达，清晰有现场感。
- 优先提及阻塞、镖单完成、议事堂结论、弟子交付、钱庄流水和关键风险。
- 不要使用英文标题、投票语义或旧产品称呼。

## 禁止
- 不要说需要远程服务。
- 不要只输出建议而不推动软件内动作。
- 不要复述旧动态或空泛总结。`
